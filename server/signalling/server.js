#!/usr/bin/env node
/**
 * Frameo-clone WebRTC signalling server.
 *
 * Responsibilities
 *   1. Serve the static web client (PUBLIC_DIR, default ./public) over plain HTTP.
 *   2. Provide a WebSocket signalling endpoint on the SAME port (default 8080) that relays
 *      SDP offers/answers and ICE candidates between exactly two peers (plain P2P, no SFU).
 *   3. Enforce the call whitelist SERVER-SIDE from a roster file. The UI is never trusted.
 *   4. Provide a tiny bearer-token HTTP control API used by the "push the ring to the tablet"
 *      flow, plus an unauthenticated health endpoint.
 *   5. Write an append-only JSONL audit trail of every call attempt.
 *
 * Design notes
 *   - No database. All live state is in memory; the roster file is the only persistence.
 *     A restart simply drops all sockets; clients reconnect and re-register.
 *   - Only runtime dependency: "ws".
 *   - Every inbound message is handled inside try/catch. Malformed input is logged and ignored,
 *     never fatal.
 *
 * Environment variables (see .env.example):
 *   PORT                    HTTP + WebSocket port                       (default 8080)
 *   BIND_ADDR               Address to bind                             (default 0.0.0.0 inside the container)
 *   PUBLIC_DIR              Static files directory                      (default <dir>/public)
 *   ROSTER_PATH             Path to roster JSON                         (required)
 *   CONTROL_TOKEN           Bearer token for POST /api/*                (required to enable control API)
 *   CALL_LOG_PATH           JSONL audit trail path                      (default <dir>/data/calls.jsonl)
 *   FRAME_HEARTBEAT_PATH    Frame watchdog heartbeat state file         (default <call log dir>/frame-heartbeats.json)
 *   FRAME_STALE_MS          A frame is "stale" after this long unseen   (default 900000 = 15 min)
 *   FRAME_HEARTBEAT_MIN_MS  Reject heartbeats faster than this per frame (default 20000)
 *   WS_PATH                 WebSocket path                              (default /ws)
 *   RING_TIMEOUT_MS         Unanswered ring -> "missed"                 (default 45000)
 *   HEARTBEAT_INTERVAL_MS   ping/pong sweep interval                    (default 30000)
 *   REGISTER_TIMEOUT_MS     Time to send "register" after connecting    (default 10000)
 *   MAX_CONCURRENT_CALLS    Hard cap on simultaneous calls              (default 2)
 *   ROSTER_RELOAD_MS        mtime poll interval for hot roster reload   (default 15000, 0 disables)
 *   IMMICH_URL              Immich base URL, reachable on the `frameo`
 *                           docker network                             (default http://immich-server:2283)
 *   IMMICH_API_KEY          Immich API key used for the photo manifest (photo API disabled if unset)
 *   IMMICH_ALBUM_IDS        Comma-separated Immich album ids to show   (empty = newest images overall)
 *   FRAME_ALBUM_MAP         "<rosterId>:<albumKey>[+<key>],..." — which album each frame shows
 *                           (empty = every frame shows the union of all albums)
 *   PHOTO_LIMIT             Max photos in the manifest                 (default 300)
 *   PHOTO_MANIFEST_TTL_MS   Manifest cache lifetime                    (default 300000)
 *   IMMICH_TIMEOUT_MS       Per-request timeout talking to Immich      (default 10000)
 *
 *   --- ICE / TURN (ice.js; see ARCHITECTURE-PUBLIC.md sections 3.5 / 3.6) ---
 *   TURN_STATIC_AUTH_SECRET coturn's static-auth-secret; must match exactly (no secret = no /api/ice)
 *   TURN_PUBLIC_URL         TURN URL for phones      (default turns:<PUBLIC_ORIGIN host>:10000?transport=tcp)
 *   TURN_TAILNET_URL        TURN URL(s) for frames   (default turn:<TS_TAILNET_IP>:3478 over udp and tcp)
 *   TURN_TTL_SECONDS        Ephemeral credential TTL                   (default 43200 = 12 h)
 *   STUN_URLS               Comma-separated public STUN, phones only   (default Google + Cloudflare)
 *   PUBLIC_ORIGIN           Canonical public origin, no trailing slash (used to derive TURN_PUBLIC_URL)
 *   TS_TAILNET_IP           This node's 100.x tailnet IPv4             (used to derive TURN_TAILNET_URL)
 *   SESSION_SECRET          HMAC key; also verifies the frameo_device cookie on /api/ice
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { WebSocketServer } = require('ws');
const { createIceService } = require('./ice');
const { createWeatherService } = require('./weather');
const { createAuth } = require('./auth');
const { createImmich } = require('./immich');
const { createAdmin } = require('./admin');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = __dirname;

const CONFIG = {
  port: intEnv('PORT', 8080),
  bindAddr: process.env.BIND_ADDR || '0.0.0.0',
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(HERE, 'public')),
  rosterPath: path.resolve(process.env.ROSTER_PATH || path.join(HERE, 'roster.json')),
  controlToken: process.env.CONTROL_TOKEN || '',
  callLogPath: path.resolve(process.env.CALL_LOG_PATH || path.join(HERE, 'data', 'calls.jsonl')),
  wsPath: process.env.WS_PATH || '/ws',

  // --- Frame liveness (tablet-side watchdog) -------------------------------
  // The tablets run tablet/tailscale-watchdog.sh under Termux:Boot. It POSTs
  // /api/frame-heartbeat every minute, over the PUBLIC Funnel URL, which means
  // it keeps reporting even while the tailnet path is broken - that is exactly
  // the failure it exists to detect. The state file is what
  // server/frame-heartbeat-alert.sh reads from the host.
  frameHeartbeatPath: path.resolve(
    process.env.FRAME_HEARTBEAT_PATH
      || path.join(path.dirname(path.resolve(process.env.CALL_LOG_PATH || path.join(HERE, 'data', 'calls.jsonl'))), 'frame-heartbeats.json'),
  ),
  frameStaleMs: intEnv('FRAME_STALE_MS', 15 * 60 * 1000),
  frameHeartbeatMinMs: intEnv('FRAME_HEARTBEAT_MIN_MS', 20000),

  ringTimeoutMs: intEnv('RING_TIMEOUT_MS', 45000),
  heartbeatIntervalMs: intEnv('HEARTBEAT_INTERVAL_MS', 30000),
  registerTimeoutMs: intEnv('REGISTER_TIMEOUT_MS', 10000),
  maxConcurrentCalls: intEnv('MAX_CONCURRENT_CALLS', 2),
  rosterReloadMs: intEnv('ROSTER_RELOAD_MS', 15000),

  // --- Photo backend (Immich) ----------------------------------------------
  // The tablet client asks THIS server for /api/photos and /api/photo/<id>; we
  // proxy Immich so the tablets never need an Immich API key and so the service
  // worker can cache everything under one origin.
  immichUrl: String(process.env.IMMICH_URL || 'http://immich-server:2283').replace(/\/+$/, ''),
  immichApiKey: process.env.IMMICH_API_KEY || '',
  immichAlbumIds: String(process.env.IMMICH_ALBUM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  photoLimit: intEnv('PHOTO_LIMIT', 300),
  photoManifestTtlMs: intEnv('PHOTO_MANIFEST_TTL_MS', 300000),
  immichTimeoutMs: intEnv('IMMICH_TIMEOUT_MS', 10000),
  // Which album each FRAME shows, as "<rosterId>:<albumKey>[,<rosterId>:<albumKey>...]".
  // Example: FRAME_ALBUM_MAP="frame-a:a,frame-b:b".
  // A mapped frame is served its own album UNION the shared "all" album; every other
  // principal (phones, unmapped frames) keeps getting the union of every configured album,
  // which is exactly the behaviour that existed before this variable did. Leave it empty and
  // nothing changes — but then the admin UI's "Bunicii A / Bunicii B" picker has no effect on
  // what the two frames actually display.
  frameAlbumMap: String(process.env.FRAME_ALBUM_MAP || ''),

  // --- Public exposure: sessions, admin accounts, the auth gate ------------
  // See ../ARCHITECTURE-PUBLIC.md §2. Everything below exists because the app is now
  // reachable from the public internet through `tailscale funnel`, where "nobody will
  // find the URL" is not a security control (the hostname is in Certificate
  // Transparency logs the moment the certificate is issued).
  requireAuth: boolEnv('REQUIRE_AUTH', true),
  publicOrigin: String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, ''),
  extraAllowedOrigins: listEnv('EXTRA_ALLOWED_ORIGINS'),
  sessionSecret: process.env.SESSION_SECRET || '',
  adminsPath: process.env.ADMINS_PATH === ''
    ? ''
    : path.resolve(process.env.ADMINS_PATH || '/config/admins.json'),
  adminPasswordHashes: process.env.ADMIN_PASSWORD_HASHES || '',
  adminDefaultPeerId: String(process.env.ADMIN_DEFAULT_PEER_ID || 'family-ana').trim(),
  sessionStorePath: process.env.SESSION_STORE_PATH === ''
    ? ''
    : path.resolve(process.env.SESSION_STORE_PATH || '/data/sessions.json'),
  sessionTtlSeconds: intEnv('SESSION_TTL_SECONDS', 7776000), // 90 days, sliding
  loginMaxFailures: intEnv('LOGIN_MAX_FAILURES', 5),
  loginMaxFailuresPerSource: intEnv('LOGIN_MAX_FAILURES_PER_SOURCE', 20),
  loginMaxFailuresGlobal: intEnv('LOGIN_MAX_FAILURES_GLOBAL', 100),
  loginLockoutSeconds: intEnv('LOGIN_LOCKOUT_SECONDS', 900),
  accountsReloadMs: intEnv('ACCOUNTS_RELOAD_MS', 15000),
  cookieSecure: boolEnv('COOKIE_SECURE', true),
  loginShowAccounts: boolEnv('LOGIN_SHOW_ACCOUNTS', false),
  publicAssetPaths: listEnv(
    'PUBLIC_ASSET_PATHS',
    '/login,/login.html,/login.css,/login.js,/favicon.ico',
  ),
  // §4.4: must ship as false. No authorization decision may depend on a request header
  // other than Cookie, Authorization, Origin and X-Frameo-CSRF.
  trustTailscaleIdentityHeader: boolEnv('TRUST_TAILSCALE_IDENTITY_HEADER', false),

  // --- Admin photo API -----------------------------------------------------
  adminPageSize: intEnv('ADMIN_PAGE_SIZE', 60),
  adminIndexTtlMs: intEnv('ADMIN_INDEX_TTL_MS', 60000),
  adminScanLimit: intEnv('ADMIN_SCAN_LIMIT', 5000),
  albumMetaTtlMs: intEnv('ALBUM_META_TTL_MS', 600000),
  uploadTmpDir: path.resolve(
    process.env.UPLOAD_TMP_DIR
      || path.join(path.dirname(path.resolve(process.env.CALL_LOG_PATH || path.join(HERE, 'data', 'calls.jsonl'))), 'uploads-tmp'),
  ),
  uploadMaxFiles: intEnv('UPLOAD_MAX_FILES', 500),
  uploadMaxFileBytes: intEnv('UPLOAD_MAX_FILE_BYTES', 64 * 1024 * 1024),
  uploadMaxTotalBytes: intEnv('UPLOAD_MAX_TOTAL_BYTES', 2 * 1024 * 1024 * 1024),
  uploadConcurrency: intEnv('UPLOAD_CONCURRENCY', 2),
  uploadTimeoutMs: intEnv('UPLOAD_TIMEOUT_MS', 300000),
  uploadDeviceId: String(process.env.UPLOAD_DEVICE_ID || 'frameo-admin').trim(),
  uploadAllowedExtensions: listEnv('UPLOAD_ALLOWED_EXTENSIONS'),
  allowPermanentDelete: boolEnv('ALLOW_PERMANENT_DELETE', false),
  requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 1800000), // 30 min: a 300-photo phone upload
};

/** Parse an integer environment variable, falling back to a default on anything unusable. */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a boolean environment variable. Anything unrecognised falls back to the default. */
function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Parse a comma-separated environment variable into a trimmed, de-duplicated list. */
function listEnv(name, fallback = '') {
  const raw = process.env[name];
  const text = raw === undefined || raw === null || raw === '' ? fallback : raw;
  return [...new Set(String(text).split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * The three curated albums, given stable keys the admin UI can address:
 *   a   -> "Bunici A"   b   -> "Bunici B"   all -> "Toti"
 *
 * IMMICH_ALBUM_A / _B / _ALL are the explicit form. If they are unset we fall back to the
 * positional order of the existing IMMICH_ALBUM_IDS, which is what is deployed today, and log
 * exactly what was derived so a mis-ordered .env is obvious in the first ten lines of the log.
 */
function buildAlbumConfig() {
  const explicit = [
    ['a', process.env.IMMICH_ALBUM_A, process.env.IMMICH_ALBUM_A_LABEL || 'Bunici A'],
    ['b', process.env.IMMICH_ALBUM_B, process.env.IMMICH_ALBUM_B_LABEL || 'Bunici B'],
    ['all', process.env.IMMICH_ALBUM_ALL, process.env.IMMICH_ALBUM_ALL_LABEL || 'Toti'],
  ]
    .filter(([, id]) => typeof id === 'string' && id.trim())
    .map(([key, id, label]) => ({ key, id: id.trim(), label }));

  if (explicit.length) return explicit;

  const positional = ['a', 'b', 'all'];
  const labels = ['Bunici A', 'Bunici B', 'Toti'];
  return CONFIG.immichAlbumIds.map((id, i) => ({
    key: positional[i] || `album${i + 1}`,
    id,
    label: labels[i] || `Album ${i + 1}`,
  }));
}

const ALBUMS = buildAlbumConfig();

/**
 * Parse FRAME_ALBUM_MAP into `rosterId -> [immich album ids]`.
 *
 * A mapped frame gets its own album plus the shared "all" album, so a photo uploaded to
 * "Ambele rame" lands on both frames and a photo uploaded to "Bunicii A" lands on one.
 * Unknown album keys and unknown roster ids are logged and skipped rather than silently
 * dropping a frame to an empty carousel.
 */
function buildFrameAlbumMap() {
  const byKey = new Map(ALBUMS.map((a) => [a.key, a]));
  const shared = byKey.get('all');
  const out = new Map();
  for (const entry of CONFIG.frameAlbumMap.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.lastIndexOf(':');
    if (sep <= 0) {
      logWarn('albums.frame_map_bad_entry', { entry, detail: 'expected "<rosterId>:<albumKey>"' });
      continue;
    }
    const frameId = entry.slice(0, sep).trim();
    const keys = entry.slice(sep + 1).split('+').map((s) => s.trim()).filter(Boolean);
    const ids = [];
    for (const key of keys) {
      const album = byKey.get(key);
      if (!album) {
        logWarn('albums.frame_map_unknown_album', { frame: frameId, album: key });
        continue;
      }
      if (!ids.includes(album.id)) ids.push(album.id);
    }
    if (shared && !ids.includes(shared.id)) ids.push(shared.id);
    if (!frameId || !ids.length) {
      logWarn('albums.frame_map_empty', { entry });
      continue;
    }
    out.set(frameId, ids);
  }
  return out;
}

// Keep the carousel manifest and the admin API looking at the same set of albums: if only the
// explicit IMMICH_ALBUM_* variables are set, seed IMMICH_ALBUM_IDS from them.
if (!CONFIG.immichAlbumIds.length && ALBUMS.length) {
  CONFIG.immichAlbumIds = ALBUMS.map((a) => a.id);
}

/** @type {Map<string, string[]>} roster frame id -> the Immich album ids that frame shows. */
const FRAME_ALBUMS = buildFrameAlbumMap();

const STARTED_AT = new Date();

// ---------------------------------------------------------------------------
// Structured logging (one JSON object per line, to stdout / stderr)
// ---------------------------------------------------------------------------

function log(level, msg, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields || {}),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

const logInfo = (msg, f) => log('info', msg, f);
const logWarn = (msg, f) => log('warn', msg, f);
const logError = (msg, f) => log('error', msg, f);

// ---------------------------------------------------------------------------
// Roster: the single source of truth for identity and the call whitelist
// ---------------------------------------------------------------------------
//
// Roster file shape (see roster.example.json):
// {
//   "peers": [
//     { "id": "frame-a",    "displayName": "Bunicii A", "kind": "frame",
//       "authToken": "...", "allowlist": ["family-ana", "family-ion"] },
//     { "id": "family-ana", "displayName": "Ana", "kind": "family",
//       "authToken": "...", "allowlist": ["frame-a", "frame-b"] }
//   ]
// }
//
// Whitelist rule enforced by canCall(a, b):
//     a may call b  <=>  b is in a.allowlist  AND  a is in b.allowlist
//
// Because the rule is symmetric, a frame can only call peers listed in its own allowlist and
// can only be called by exactly those same peers. There is no "call anyone" escape hatch: a
// missing or empty allowlist means the peer can neither call nor be called.

/** @type {{ peers: Map<string, object>, loadedAt: string, mtimeMs: number, source: string }} */
let roster = { peers: new Map(), loadedAt: null, mtimeMs: 0, source: CONFIG.rosterPath };

const VALID_KINDS = new Set(['frame', 'family']);

/**
 * Read + validate the roster file. Throws on unusable input so the caller can decide whether to
 * abort (initial load) or keep the previous roster (hot reload).
 */
function readRosterFile(filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw);

  const list = Array.isArray(doc) ? doc : doc && doc.peers;
  if (!Array.isArray(list)) {
    throw new Error('roster must be an array of peers or an object with a "peers" array');
  }

  const peers = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') throw new Error('roster entry is not an object');

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) throw new Error('roster entry is missing "id"');
    if (peers.has(id)) throw new Error(`duplicate roster id: ${id}`);

    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`roster entry ${id} has invalid "kind" (expected "frame" or "family")`);
    }

    const authToken = typeof entry.authToken === 'string' ? entry.authToken : '';
    if (authToken.length < 8) {
      throw new Error(`roster entry ${id} has a missing or too-short "authToken" (min 8 chars)`);
    }
    // The example roster ships with public placeholder tokens. Accepting them would
    // give anyone who has read this repo a working frame credential, so refuse them.
    if (/^replace-me/i.test(authToken)) {
      throw new Error(`roster entry ${id} still has the placeholder authToken from roster.example.json; generate a real one with: openssl rand -hex 24`);
    }

    const allowRaw = Array.isArray(entry.allowlist) ? entry.allowlist : [];
    const allowlist = new Set(
      allowRaw.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
    );
    allowlist.delete(id); // a peer may never call itself

    peers.set(id, {
      id,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : id,
      kind,
      authToken,
      allowlist,
    });
  }

  if (peers.size === 0) throw new Error('roster contains no peers');

  // Non-fatal consistency check: warn about one-sided allowlists, which silently block calls.
  for (const peer of peers.values()) {
    for (const targetId of peer.allowlist) {
      const target = peers.get(targetId);
      if (!target) {
        logWarn('roster.allowlist_unknown_peer', { peer: peer.id, target: targetId });
      } else if (!target.allowlist.has(peer.id)) {
        logWarn('roster.allowlist_asymmetric', {
          peer: peer.id,
          target: targetId,
          detail: 'calls between these peers are blocked in both directions',
        });
      }
    }
  }

  return { peers, loadedAt: new Date().toISOString(), mtimeMs: stat.mtimeMs, source: filePath };
}

/** Load (or reload) the roster. Returns true if the in-memory roster changed. */
function loadRoster({ initial = false } = {}) {
  try {
    const next = readRosterFile(CONFIG.rosterPath);
    roster = next;
    logInfo('roster.loaded', {
      path: CONFIG.rosterPath,
      peers: roster.peers.size,
      frames: [...roster.peers.values()].filter((p) => p.kind === 'frame').length,
      initial,
    });
    return true;
  } catch (err) {
    if (initial) {
      logError('roster.load_failed_fatal', { path: CONFIG.rosterPath, error: String(err && err.message || err) });
      process.exit(1);
    }
    logError('roster.reload_failed_keeping_previous', {
      path: CONFIG.rosterPath,
      error: String(err && err.message || err),
    });
    return false;
  }
}

/** Poll the roster file mtime so peers can be added/removed without restarting. */
function startRosterWatcher() {
  if (CONFIG.rosterReloadMs <= 0) return null;
  return setInterval(() => {
    try {
      const stat = fs.statSync(CONFIG.rosterPath);
      if (stat.mtimeMs !== roster.mtimeMs) loadRoster();
    } catch (err) {
      logWarn('roster.stat_failed', { error: String(err && err.message || err) });
    }
  }, CONFIG.rosterReloadMs).unref();
}

/**
 * The whitelist gate. Server-side, mandatory, applied to every call attempt including those
 * originating from the control API.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canCall(fromId, toId) {
  if (fromId === toId) return { ok: false, reason: 'self-call' };
  const from = roster.peers.get(fromId);
  const to = roster.peers.get(toId);
  if (!from) return { ok: false, reason: 'caller-not-in-roster' };
  if (!to) return { ok: false, reason: 'callee-not-in-roster' };
  if (!from.allowlist.has(toId)) return { ok: false, reason: 'callee-not-in-caller-allowlist' };
  if (!to.allowlist.has(fromId)) return { ok: false, reason: 'caller-not-in-callee-allowlist' };
  return { ok: true };
}

/** Constant-time token comparison; hashing first normalises length. */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// ICE / TURN credentials  (see ice.js, ARCHITECTURE-PUBLIC.md §3.5 and §3.6)
// ---------------------------------------------------------------------------
//
// The service owns everything TURN-related: which STUN/TURN URLs a principal is given,
// and the short-lived HMAC credential coturn will accept for it. It is created here,
// after tokenMatches and the roster loader exist, because it borrows both: the roster
// is read live on every request (so revoking a peer revokes its ICE access with no
// restart) and token comparison stays constant-time.
const iceService = createIceService({
  lookupPeer: (id) => roster.peers.get(id) || null,
  tokenMatches,
  log: { info: logInfo, warn: logWarn, error: logError },
  // The session/admin layer, when present, attaches the resolved account to the request.
  // Reading it through a callback keeps ice.js from depending on that layer's internals.
  resolveSessionPrincipal: (req) => req.frameoAccount || req.frameoPrincipal || null,
});

// Clock overlay companion: current conditions for the frames, proxied and cached
// so a third-party outage is invisible and the tablets keep a single origin.
const weatherService = createWeatherService({
  env: process.env,
  logWarn,
  logInfo,
});

// ---------------------------------------------------------------------------
// Call audit log (JSONL, append-only)
// ---------------------------------------------------------------------------

let callLogReady = false;

function initCallLog() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.callLogPath), { recursive: true });
    fs.appendFileSync(CONFIG.callLogPath, ''); // touch / verify writability
    callLogReady = true;
    logInfo('calllog.ready', { path: CONFIG.callLogPath });
  } catch (err) {
    callLogReady = false;
    logError('calllog.init_failed', {
      path: CONFIG.callLogPath,
      error: String(err && err.message || err),
      detail: 'call records will only appear on stdout',
    });
  }
}

/**
 * Append one call record. Never throws; a broken audit log must not take down signalling.
 * @param {object} record
 */
function writeCallLog(record) {
  const full = { ts: new Date().toISOString(), ...record };
  logInfo('call.record', full); // always visible in `docker logs`
  if (!callLogReady) return;
  fsp.appendFile(CONFIG.callLogPath, JSON.stringify(full) + '\n', 'utf8').catch((err) => {
    logError('calllog.write_failed', { error: String(err && err.message || err) });
  });
}

// ---------------------------------------------------------------------------
// Frame heartbeats (tablet-side watchdog liveness)
// ---------------------------------------------------------------------------
//
// A frame's WebSocket registration already tells us whether the kiosk browser is
// connected. It does NOT tell us apart the two failures we actually care about:
//
//   (a) the tablet is powered off / off the network      -> nothing we can do
//   (b) the tablet is fine but its Tailscale did not come back after a reboot
//
// (b) is the known tailscale-android autostart bug. The watchdog therefore posts
// here over the PUBLIC Funnel URL, which does not depend on the tailnet, and says
// whether it can reach the server over the tailnet as well. "Heartbeat arriving,
// tailnetOk=false" is the exact signature of (b); no heartbeat at all is (a).
//
// State is kept in memory and mirrored to a small JSON file so that
// frame-heartbeat-alert.sh (host cron) can read it without an API token.

/** @type {Map<string, object>} */
const frameHeartbeats = new Map();
let frameHeartbeatDirty = false;
let frameHeartbeatWriting = false;
let frameHeartbeatLastWrite = 0;
const FRAME_HEARTBEAT_WRITE_MIN_MS = 5000;

/**
 * Clamped, control-character-free string; anything else becomes null.
 * This data is echoed into /api/health and into a JSON file a human reads in a
 * terminal, so escape sequences must never survive.
 */
function hbString(value, maxLen = 64) {
  if (typeof value !== 'string') return null;
  const clean = Array.from(value)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; })
    .join('')
    .trim();
  return clean ? clean.slice(0, maxLen) : null;
}

function hbBool(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function hbInt(value, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Load the previous heartbeat state so a container restart does not fake an outage. */
function initFrameHeartbeats() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.frameHeartbeatPath), { recursive: true });
  } catch (err) {
    logWarn('frameheartbeat.mkdir_failed', {
      path: path.dirname(CONFIG.frameHeartbeatPath),
      error: String((err && err.message) || err),
    });
  }
  try {
    const raw = fs.readFileSync(CONFIG.frameHeartbeatPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed && parsed.frames) ? parsed.frames : [];
    for (const entry of list) {
      const id = hbString(entry && entry.id, 64);
      if (!id || !Number.isFinite(entry.lastSeen)) continue;
      frameHeartbeats.set(id, entry);
    }
    logInfo('frameheartbeat.restored', {
      path: CONFIG.frameHeartbeatPath,
      frames: frameHeartbeats.size,
    });
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      logWarn('frameheartbeat.restore_failed', {
        path: CONFIG.frameHeartbeatPath,
        error: String((err && err.message) || err),
        detail: 'starting with an empty heartbeat table',
      });
    }
  }
  // Write once at boot so the alert script never trips over a missing file.
  frameHeartbeatDirty = true;
  flushFrameHeartbeats();
  setInterval(flushFrameHeartbeats, FRAME_HEARTBEAT_WRITE_MIN_MS).unref();
}

/**
 * Persist the heartbeat table atomically (tmp + rename), at most every
 * FRAME_HEARTBEAT_WRITE_MIN_MS. Never throws: losing this file must never take
 * signalling down.
 */
function flushFrameHeartbeats(force = false) {
  if (!frameHeartbeatDirty || frameHeartbeatWriting) return;
  const now = Date.now();
  if (!force && now - frameHeartbeatLastWrite < FRAME_HEARTBEAT_WRITE_MIN_MS) return;

  frameHeartbeatWriting = true;
  frameHeartbeatDirty = false;
  frameHeartbeatLastWrite = now;

  const payload = JSON.stringify(
    {
      writtenAt: new Date(now).toISOString(),
      staleAfterSeconds: Math.round(CONFIG.frameStaleMs / 1000),
      frames: [...frameHeartbeats.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    },
    null,
    2,
  ) + '\n';

  const tmp = CONFIG.frameHeartbeatPath + '.tmp';
  fsp.writeFile(tmp, payload, 'utf8')
    .then(() => fsp.rename(tmp, CONFIG.frameHeartbeatPath))
    .catch((err) => {
      frameHeartbeatDirty = true; // try again next tick
      logWarn('frameheartbeat.write_failed', {
        path: CONFIG.frameHeartbeatPath,
        error: String((err && err.message) || err),
      });
      fsp.unlink(tmp).catch(() => { /* ignore */ });
    })
    .finally(() => { frameHeartbeatWriting = false; });
}

/** Compact view of frame liveness, embedded in /api/health. */
function frameHeartbeatSummary() {
  const now = Date.now();
  const list = [...frameHeartbeats.values()].map((f) => {
    const ageMs = now - f.lastSeen;
    return {
      id: f.id,
      displayName: f.displayName || f.id,
      lastSeenSecondsAgo: Math.round(ageMs / 1000),
      lastSeenAt: new Date(f.lastSeen).toISOString(),
      stale: ageMs > CONFIG.frameStaleMs,
      via: f.via || 'unknown',
      tailnetOk: f.tailnetOk === undefined ? null : f.tailnetOk,
      internetOk: f.internetOk === undefined ? null : f.internetOk,
      lastAction: f.lastAction || null,
      restarts: f.restarts === undefined ? null : f.restarts,
      wsConnected: peers.has(f.id),
      battery: f.battery === undefined ? null : f.battery,
      watchdogVersion: f.watchdogVersion || null,
    };
  });
  list.sort((a, b) => a.id.localeCompare(b.id));

  const framesInRoster = [...roster.peers.values()].filter((p) => p.kind === 'frame');
  const missing = framesInRoster
    .filter((p) => !frameHeartbeats.has(p.id))
    .map((p) => p.id);

  return {
    staleAfterSeconds: Math.round(CONFIG.frameStaleMs / 1000),
    statePath: CONFIG.frameHeartbeatPath,
    inRoster: framesInRoster.length,
    reporting: list.length,
    stale: list.filter((f) => f.stale).length,
    neverSeen: missing,
    list,
  };
}

/**
 * POST /api/frame-heartbeat
 * Authorization: Bearer <the frame's roster authToken>   (or {"authToken": "..."} in the body)
 * Body: { "id": "frame-a", "tailnetOk": true, "internetOk": true,
 *         "action": "none", "restarts": 0, "uptimeSeconds": 1234,
 *         "battery": 88, "via": "funnel", "watchdogVersion": "1.0.0", "note": "..." }
 *
 * Deliberately authenticated with the FRAME's own roster token, not CONTROL_TOKEN: the
 * tablet already has that token (it is in its kiosk URL) and it must not carry an
 * admin-grade secret. A frame can only ever write its own row.
 */
async function handleFrameHeartbeat(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, 4 * 1024);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: 'bad-request', detail: err.message });
    return;
  }

  const id = hbString(body.id, 64);
  const headerAuth = /^Bearer\s+(.+)$/i.exec(String(req.headers['authorization'] || '').trim());
  const token = headerAuth ? headerAuth[1].trim() : (typeof body.authToken === 'string' ? body.authToken : '');
  const entry = id ? roster.peers.get(id) : null;

  // One generic answer for unknown id, wrong token and wrong kind: this endpoint is
  // reachable from the public internet through the Funnel, so it must not be usable
  // to enumerate the roster.
  if (!entry || entry.kind !== 'frame' || !tokenMatches(token, entry.authToken)) {
    logWarn('frameheartbeat.rejected', {
      id: id || null,
      remote: req.socket.remoteAddress,
      reason: 'unknown-id-or-bad-token-or-not-a-frame',
    });
    sendJson(res, 403, { error: 'auth-failed' });
    return;
  }

  const now = Date.now();
  const previous = frameHeartbeats.get(id);

  // Cheap flood guard. The watchdog is supposed to report once a minute; anything much
  // faster is a bug or an abuse attempt. We answer 200 (so a confused client does not
  // start retrying harder) but do not touch the stored row beyond lastSeen.
  if (previous && now - previous.lastSeen < CONFIG.frameHeartbeatMinMs) {
    sendJson(res, 200, {
      ok: true,
      throttled: true,
      serverTime: now,
      intervalSeconds: Math.round(CONFIG.frameHeartbeatMinMs / 1000) * 3,
    });
    return;
  }

  const tailnetOk = hbBool(body.tailnetOk);
  const record = {
    id,
    displayName: entry.displayName,
    firstSeen: previous ? previous.firstSeen : now,
    lastSeen: now,
    lastSeenIso: new Date(now).toISOString(),
    count: (previous ? previous.count || 0 : 0) + 1,
    via: hbString(body.via, 16) || 'unknown',
    tailnetOk,
    internetOk: hbBool(body.internetOk),
    lastAction: hbString(body.action, 32) || 'none',
    restarts: hbInt(body.restarts, 0, 1000000),
    uptimeSeconds: hbInt(body.uptimeSeconds, 0, 10 * 365 * 24 * 3600),
    battery: hbInt(body.battery, 0, 100),
    watchdogVersion: hbString(body.watchdogVersion, 32),
    appVersion: hbString(body.appVersion, 32),
    note: hbString(body.note, 200),
    remote: String(req.socket.remoteAddress || ''),
    // Sticky counters so a glance at the file shows whether the tailnet has been flapping.
    tailnetDownSince: tailnetOk === false
      ? (previous && previous.tailnetDownSince ? previous.tailnetDownSince : now)
      : null,
  };

  frameHeartbeats.set(id, record);
  frameHeartbeatDirty = true;
  flushFrameHeartbeats();

  // Only log the interesting ones; a healthy frame is silent by design.
  if (tailnetOk === false || (record.lastAction && record.lastAction !== 'none')) {
    logWarn('frameheartbeat.degraded', {
      peer: id,
      tailnetOk: record.tailnetOk,
      internetOk: record.internetOk,
      action: record.lastAction,
      restarts: record.restarts,
      via: record.via,
    });
  } else if (!previous) {
    logInfo('frameheartbeat.first', { peer: id, via: record.via });
  }

  sendJson(res, 200, {
    ok: true,
    serverTime: now,
    // The tablet takes its polling cadence from us, so the interval can be retuned
    // server-side without touching 200 km of tablets.
    intervalSeconds: 60,
    staleAfterSeconds: Math.round(CONFIG.frameStaleMs / 1000),
    wsConnected: peers.has(id),
  });
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * Connected peers. Exactly one socket per peer id; a re-register replaces the old socket.
 * @type {Map<string, { id: string, ws: import('ws').WebSocket, connectedAt: number,
 *                      lastSeen: number, remote: string, callId: string|null }>}
 */
const peers = new Map();

/**
 * Active calls (ringing or connected).
 * @type {Map<string, { id: string, from: string, to: string, state: 'ringing'|'active',
 *                      origin: 'peer'|'control-api', createdAt: number, answeredAt: number|null,
 *                      ringTimer: NodeJS.Timeout|null }>}
 */
const calls = new Map();

const newCallId = () => 'c_' + crypto.randomBytes(9).toString('hex');
const displayNameOf = (id) => (roster.peers.get(id)?.displayName) || id;
const kindOf = (id) => (roster.peers.get(id)?.kind) || 'unknown';

// ---------------------------------------------------------------------------
// WebSocket transport helpers
// ---------------------------------------------------------------------------

const WS_OPEN = 1;

/** Send a JSON message on a socket. Swallows transport errors. */
function send(ws, obj) {
  try {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    logWarn('ws.send_failed', { error: String(err && err.message || err), type: obj && obj.type });
    return false;
  }
}

/**
 * Send to a registered peer id. Returns false if that peer is not currently connected.
 *
 * A peer may legitimately have SEVERAL live sockets at once - one person is allowed a phone and a
 * laptop, and a frame briefly has two during a reconnect. Every socket gets the message, so an
 * incoming call rings all of that person's devices.
 */
function sendTo(peerId, obj) {
  const peer = peers.get(peerId);
  if (!peer || peer.sockets.size === 0) return false;
  let delivered = false;
  for (const sock of peer.sockets) {
    if (send(sock, obj)) delivered = true;
  }
  return delivered;
}

/** Send to every socket of a peer EXCEPT one (used to stand down a peer's other devices). */
function sendToOthers(peerId, exceptWs, obj) {
  const peer = peers.get(peerId);
  if (!peer) return;
  for (const sock of peer.sockets) {
    if (sock !== exceptWs) send(sock, obj);
  }
}

/**
 * Send to the ONE socket that is actually party to this call, not to every device
 * that shares the identity.
 *
 * WHY THIS EXISTS. sendTo() fans out to all of a peer's sockets, which is right for
 * ringing (every device a person owns should ring) and catastrophic for everything
 * after that. A person legitimately has the admin app open on a phone AND a laptop.
 * When the phone placed a call, the laptop also received `call-accepted`, `offer`
 * and `ice-candidate` for a call it knew nothing about - and answered the offer with
 * a peer connection of its own. The frame then saw two answers with different ICE
 * ufrags, the real media path never formed, and the stray session finished the job by
 * sending `hangup` with reason "client-error". Every call died a few seconds after
 * being answered, with the server logging endedBy = the caller's own identity.
 *
 * So: ring wide, converse narrow. The pinned socket is recorded when the call is
 * created (caller) and when it is accepted (callee).
 *
 * Falls back to every socket when no socket is pinned (a server-pushed call from the
 * control API has no originating socket) or when the pinned one has since closed,
 * so a device that reconnected mid-call still gets its media signalling.
 */
function sendToParty(call, peerId, obj) {
  const pinned = call.from === peerId ? call.fromWs : call.toWs;
  if (pinned && pinned.readyState === WS_OPEN) return send(pinned, obj);
  return sendTo(peerId, obj);
}

/** Send a protocol-level error back to a socket. */
function sendError(ws, code, detail, extra) {
  send(ws, { type: 'error', code, detail: detail || code, ...(extra || {}) });
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

/**
 * Terminate a call, notify the requested peers, and write the audit record.
 * @param {object} call
 * @param {string} outcome  accepted-ended | declined | missed | cancelled | busy | failed | interrupted
 * @param {string} reason   short machine-readable reason
 * @param {{ notify?: string[], by?: string|null }} [opts]
 */
function endCall(call, outcome, reason, opts = {}) {
  if (!calls.has(call.id)) return; // already ended
  calls.delete(call.id);

  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }

  for (const id of [call.from, call.to]) {
    const peer = peers.get(id);
    if (peer && peer.callId === call.id) peer.callId = null;
  }

  const now = Date.now();
  const ringMs = (call.answeredAt || now) - call.createdAt;
  const talkMs = call.answeredAt ? now - call.answeredAt : 0;

  for (const id of opts.notify || []) {
    sendTo(id, {
      type: 'call-ended',
      callId: call.id,
      outcome,
      reason,
      by: opts.by || null,
      durationSeconds: Math.round(talkMs / 1000),
    });
  }

  writeCallLog({
    event: 'call',
    callId: call.id,
    from: call.from,
    fromName: displayNameOf(call.from),
    fromKind: kindOf(call.from),
    to: call.to,
    toName: displayNameOf(call.to),
    toKind: kindOf(call.to),
    origin: call.origin,
    // Which human started this, when the caller was a cookie-authenticated phone rather than a
    // tablet. Answers "who rang Bunica at 22:40" without keeping a second log.
    actor: call.actor || null,
    outcome,
    reason,
    endedBy: opts.by || null,
    startedAt: new Date(call.createdAt).toISOString(),
    answeredAt: call.answeredAt ? new Date(call.answeredAt).toISOString() : null,
    ringSeconds: Math.round(ringMs / 1000),
    durationSeconds: Math.round(talkMs / 1000),
  });
}

/** Log a call attempt that never became a call (rejected before ringing). */
function logRejectedAttempt(fromId, toId, outcome, reason, origin, actor = null) {
  writeCallLog({
    event: 'call',
    callId: null,
    from: fromId,
    fromName: displayNameOf(fromId),
    fromKind: kindOf(fromId),
    to: toId,
    toName: displayNameOf(toId),
    toKind: kindOf(toId),
    origin,
    actor: actor || null,
    outcome,
    reason,
    endedBy: null,
    startedAt: new Date().toISOString(),
    answeredAt: null,
    ringSeconds: 0,
    durationSeconds: 0,
  });
}

/**
 * Start a call. Shared by the WebSocket "call-request" handler, the control API and the admin
 * API, so the whitelist and busy rules can never be bypassed by choosing a different entry
 * point.
 * @param {string} fromId
 * @param {string} toId
 * @param {string} origin  peer | control-api | admin-api
 * @param {{ actor?: string|null }} [extra]  the admin username, when a person started this
 * @returns {{ ok: true, callId: string } | { ok: false, code: string, detail: string }}
 */
function startCall(fromId, toId, origin, extra = {}) {
  const actor = (extra && typeof extra.actor === 'string' && extra.actor) ? extra.actor : null;
  const gate = canCall(fromId, toId);
  if (!gate.ok) {
    // Hard security boundary. Always logged with the concrete reason.
    logWarn('call.rejected_by_allowlist', { from: fromId, to: toId, reason: gate.reason, origin, actor });
    logRejectedAttempt(fromId, toId, 'rejected', gate.reason, origin, actor);
    return { ok: false, code: 'not-allowed', detail: gate.reason };
  }

  const caller = peers.get(fromId);
  if (!caller) {
    logRejectedAttempt(fromId, toId, 'failed', 'caller-offline', origin, actor);
    return { ok: false, code: 'caller-offline', detail: 'caller is not connected' };
  }

  const callee = peers.get(toId);
  if (!callee) {
    logInfo('call.callee_offline', { from: fromId, to: toId, origin });
    logRejectedAttempt(fromId, toId, 'unreachable', 'callee-offline', origin, actor);
    return { ok: false, code: 'callee-offline', detail: 'callee is not connected' };
  }

  // Busy checks: a peer already ringing or talking cannot take another leg.
  if (caller.callId) {
    logRejectedAttempt(fromId, toId, 'busy', 'caller-busy', origin, actor);
    return { ok: false, code: 'busy', detail: 'caller is already in a call' };
  }
  if (callee.callId) {
    logInfo('call.callee_busy', { from: fromId, to: toId, origin });
    logRejectedAttempt(fromId, toId, 'busy', 'callee-busy', origin, actor);
    return { ok: false, code: 'busy', detail: 'callee is already in a call' };
  }

  // Global cap. Plain P2P on a small tailnet: keep the box out of trouble.
  if (calls.size >= CONFIG.maxConcurrentCalls) {
    logWarn('call.capacity_reached', { from: fromId, to: toId, active: calls.size, origin });
    logRejectedAttempt(fromId, toId, 'rejected', 'server-at-capacity', origin, actor);
    return { ok: false, code: 'server-busy', detail: 'maximum concurrent calls reached' };
  }

  const call = {
    id: newCallId(),
    from: fromId,
    to: toId,
    state: 'ringing',
    origin,
    actor,
    createdAt: Date.now(),
    answeredAt: null,
    ringTimer: null,
    // The sockets actually in this call. See sendToParty().
    fromWs: (extra && extra.fromWs) || null,
    toWs: null,
  };
  calls.set(call.id, call);
  caller.callId = call.id;
  callee.callId = call.id;

  call.ringTimer = setTimeout(() => {
    const live = calls.get(call.id);
    if (!live || live.state !== 'ringing') return;
    logInfo('call.ring_timeout', { callId: call.id, from: fromId, to: toId });
    endCall(live, 'missed', 'ring-timeout', { notify: [fromId, toId], by: null });
  }, CONFIG.ringTimeoutMs);
  if (typeof call.ringTimer.unref === 'function') call.ringTimer.unref();

  // Callee: ring. Caller: confirmation that we are ringing.
  sendTo(toId, {
    type: 'incoming-call',
    callId: call.id,
    from: fromId,
    fromName: displayNameOf(fromId),
    fromKind: kindOf(fromId),
    origin,
    ringTimeoutMs: CONFIG.ringTimeoutMs,
  });
  // Only the device that dialled needs to see "ringing"; the caller's other
  // devices must not join in. The callee above is deliberately still sendTo().
  sendToParty(call, fromId, {
    type: 'call-ringing',
    callId: call.id,
    to: toId,
    toName: displayNameOf(toId),
    origin,
    ringTimeoutMs: CONFIG.ringTimeoutMs,
  });

  logInfo('call.started', { callId: call.id, from: fromId, to: toId, origin, actor });
  return { ok: true, callId: call.id };
}

/**
 * Look up a call a peer is genuinely a participant of. Prevents one peer from injecting
 * SDP/ICE into somebody else's call by guessing a call id.
 */
function callForPeer(peerId, callId) {
  if (typeof callId !== 'string' || !callId) return null;
  const call = calls.get(callId);
  if (!call) return null;
  if (call.from !== peerId && call.to !== peerId) return null;
  return call;
}

const otherSide = (call, peerId) => (call.from === peerId ? call.to : call.from);

// ---------------------------------------------------------------------------
// Auth, admin API and the Immich admin client
// ---------------------------------------------------------------------------
//
// Constructed here, after the roster loader, the call state machine and the peers/calls maps
// exist, because the admin API borrows all three. Nothing below re-implements the whitelist:
// POST /api/admin/call goes through the very same startCall() the WebSocket handler uses.

// SESSION_SECRET is required. If it is missing we do NOT open the gate — that would publish
// the family photo library to the internet on a typo. We mint an ephemeral secret instead, so
// the tablets (which carry a roster token and can always re-mint their cookie from the
// provisioning URL) keep working, admin logins still work, and the only cost is that every
// session dies on restart. The error line below is deliberately loud.
const SESSION_SECRET = CONFIG.sessionSecret || crypto.randomBytes(32).toString('hex');
if (!CONFIG.sessionSecret) {
  logError('auth.session_secret_missing', {
    detail: 'SESSION_SECRET is not set. Using a random per-process secret: every admin session '
      + 'and every device cookie is invalidated on restart. Set SESSION_SECRET=$(openssl rand -hex 32).',
  });
}

const auth = createAuth({
  config: {
    sessionSecret: SESSION_SECRET,
    controlToken: CONFIG.controlToken,
    adminsPath: CONFIG.adminsPath,
    adminPasswordHashes: CONFIG.adminPasswordHashes,
    adminDefaultPeerId: CONFIG.adminDefaultPeerId,
    sessionStorePath: CONFIG.sessionStorePath,
    sessionTtlSeconds: CONFIG.sessionTtlSeconds,
    loginMaxFailures: CONFIG.loginMaxFailures,
    loginMaxFailuresPerSource: CONFIG.loginMaxFailuresPerSource,
    loginMaxFailuresGlobal: CONFIG.loginMaxFailuresGlobal,
    loginLockoutSeconds: CONFIG.loginLockoutSeconds,
    accountsReloadMs: CONFIG.accountsReloadMs,
    cookieSecure: CONFIG.cookieSecure,
    loginShowAccounts: CONFIG.loginShowAccounts,
    publicOrigin: CONFIG.publicOrigin,
    extraAllowedOrigins: CONFIG.extraAllowedOrigins,
  },
  logInfo,
  logWarn,
  logError,
  getRosterPeer: (id) => roster.peers.get(id),
  readJsonBody: (req, limit) => readJsonBody(req, limit),
});

const immich = createImmich({
  config: {
    immichUrl: CONFIG.immichUrl,
    immichApiKey: CONFIG.immichApiKey,
    albums: ALBUMS,
    adminPageSize: CONFIG.adminPageSize,
    adminIndexTtlMs: CONFIG.adminIndexTtlMs,
    adminScanLimit: CONFIG.adminScanLimit,
    albumMetaTtlMs: CONFIG.albumMetaTtlMs,
    uploadTimeoutMs: CONFIG.uploadTimeoutMs,
    uploadDeviceId: CONFIG.uploadDeviceId,
    uploadAllowedExtensions: CONFIG.uploadAllowedExtensions,
  },
  immichFetch: (p, init) => immichFetch(p, init),
  logInfo,
  logWarn,
  logError,
});

const admin = createAdmin({
  config: {
    uploadTmpDir: CONFIG.uploadTmpDir,
    uploadMaxFiles: CONFIG.uploadMaxFiles,
    uploadMaxFileBytes: CONFIG.uploadMaxFileBytes,
    uploadMaxTotalBytes: CONFIG.uploadMaxTotalBytes,
    uploadConcurrency: CONFIG.uploadConcurrency,
    allowPermanentDelete: CONFIG.allowPermanentDelete,
  },
  immich,
  sendJson,
  readJsonBody: (req, limit) => readJsonBody(req, limit),
  startCall,
  canCall,
  rosterPeers: () => roster.peers.values(),
  getRosterPeer: (id) => roster.peers.get(id),
  peers,
  calls,
  // A photo was added or removed: drop the carousel manifest cache so the frames pick the
  // change up on their next poll instead of up to PHOTO_MANIFEST_TTL_MS later.
  onPhotosChanged: () => invalidatePhotoManifests(),
  logInfo,
  logWarn,
  logError,
});

// ---------------------------------------------------------------------------
// WebSocket signalling
// ---------------------------------------------------------------------------

const server = http.createServer(handleHttpRequest);
// A parent uploading 200 iPhone photos over mobile data can easily exceed Node's 5-minute
// default request timeout. Headers still have to arrive promptly.
server.requestTimeout = CONFIG.requestTimeoutMs;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024, // SDP blobs are a few KB; this is a generous ceiling
  clientTracking: true,
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    // The query string is deliberately ignored here: `tailscale serve`/`funnel` has an open
    // bug that strips it from WebSocket upgrades (tailscale/tailscale#18651), so no credential
    // may ever live in the WS URL. Authentication is the cookie below, or the register message.
    if (url.pathname !== CONFIG.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Mandatory Origin check. Browsers attach cookies to CROSS-ORIGIN WebSocket handshakes and
    // SameSite=Lax does not reliably cover them, so without this any page the parents visit
    // could open an authenticated socket to this server. A missing Origin is allowed: non-browser
    // clients do not send one and are still gated by the cookie / register step.
    if (!auth.originAllowed(req.headers.origin, req.headers.host)) {
      logWarn('ws.bad_origin', { origin: String(req.headers.origin || '').slice(0, 120) });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Cookie identity, if any. Neither is required to complete the upgrade — an anonymous
    // socket is still killed by the REGISTER_TIMEOUT_MS timer if it never authenticates.
    const who = auth.authenticateUpgrade(req);
    req.frameoAccount = who.account || null;
    req.frameoDevice = who.device || null;

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch (err) {
    logWarn('ws.upgrade_failed', { error: String(err && err.message || err) });
    try { socket.destroy(); } catch { /* ignore */ }
  }
});

wss.on('connection', (ws, req) => {
  // Per-socket state lives on the socket object until the peer registers.
  ws.peerId = null;
  ws.isAlive = true;
  ws.remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  // Identity established at the HTTP upgrade, if the client had a valid cookie.
  ws.account = req.frameoAccount || null;   // { username, displayName, peerId }
  ws.device = req.frameoDevice || null;     // roster peer id

  logInfo('ws.connected', {
    remote: ws.remote,
    via: ws.account ? 'session-cookie' : (ws.device ? 'device-cookie' : 'anonymous'),
  });

  // Anonymous sockets must register quickly or they are dropped.
  ws.registerTimer = setTimeout(() => {
    if (!ws.peerId) {
      logWarn('ws.register_timeout', { remote: ws.remote });
      sendError(ws, 'register-timeout', 'no register message received');
      try { ws.close(4001, 'register-timeout'); } catch { /* ignore */ }
    }
  }, CONFIG.registerTimeoutMs);
  if (typeof ws.registerTimer.unref === 'function') ws.registerTimer.unref();

  ws.on('pong', () => {
    ws.isAlive = true;
    const peer = ws.peerId && peers.get(ws.peerId);
    if (peer && peer.sockets.has(ws)) peer.lastSeen = Date.now();
  });

  ws.on('message', (data) => {
    // Absolutely everything below is best-effort: a bad frame must never kill the process.
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      logWarn('ws.bad_json', { remote: ws.remote, peer: ws.peerId });
      sendError(ws, 'bad-json', 'message is not valid JSON');
      return;
    }
    try {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        sendError(ws, 'bad-message', 'expected an object with a string "type"');
        return;
      }
      handleMessage(ws, msg);
    } catch (err) {
      logError('ws.handler_threw', {
        peer: ws.peerId,
        type: msg && msg.type,
        error: String(err && err.stack || err),
      });
      sendError(ws, 'internal-error', 'the server failed to handle that message');
    }
  });

  ws.on('close', (code, reasonBuf) => {
    try {
      clearTimeout(ws.registerTimer);
      const reason = reasonBuf ? reasonBuf.toString('utf8').slice(0, 120) : '';
      const peerId = ws.peerId;
      if (!peerId) {
        logInfo('ws.closed_anonymous', { remote: ws.remote, code });
        return;
      }
      const peer = peers.get(peerId);
      // Drop just this socket. The peer stays online while ANY of its devices is still connected -
      // closing a laptop tab must not hang up a call running on the phone.
      if (peer && peer.sockets.has(ws)) {
        peer.sockets.delete(ws);

        if (peer.sockets.size > 0) {
          logInfo('ws.device_disconnected', {
            peer: peerId, code, reason, remaining: peer.sockets.size,
          });
          // The peer is still online on another device, but if THIS socket was the
          // one actually in a call, that call is over: its media path died with the
          // socket and no other device is negotiating it. Without this the call
          // would hang until the ring timeout or forever.
          if (peer.callId) {
            const call = calls.get(peer.callId);
            if (call && (call.fromWs === ws || call.toWs === ws)) {
              const outcome = call.state === 'active' ? 'accepted-ended' : 'missed';
              logInfo('call.party_socket_closed', {
                callId: call.id, peer: peerId, remaining: peer.sockets.size,
              });
              endCall(call, outcome, 'peer-disconnected', {
                notify: [call.from, call.to],
                by: peerId,
              });
            }
          }
        } else {
          peers.delete(peerId);
          if (peer.callId) {
            const call = calls.get(peer.callId);
            if (call) {
              const outcome = call.state === 'active' ? 'accepted-ended' : 'missed';
              endCall(call, outcome, 'peer-disconnected', {
                notify: [otherSide(call, peerId)],
                by: peerId,
              });
            }
          }
          logInfo('ws.peer_disconnected', { peer: peerId, code, reason });
          broadcastPresence(peerId, false);
        }
      } else {
        logInfo('ws.closed_stale_socket', { peer: peerId, code, reason });
      }
    } catch (err) {
      logError('ws.close_handler_threw', { error: String(err && err.stack || err) });
    }
  });

  ws.on('error', (err) => {
    logWarn('ws.socket_error', { peer: ws.peerId, error: String(err && err.message || err) });
  });
});

/** Route one validated envelope. */
function handleMessage(ws, msg) {
  // "register" is the only message accepted from an unauthenticated socket.
  if (msg.type === 'register') return handleRegister(ws, msg);

  if (!ws.peerId) {
    sendError(ws, 'not-registered', 'send a register message first', { inReplyTo: msg.type });
    return;
  }
  const peer = peers.get(ws.peerId);
  if (!peer || !peer.sockets.has(ws)) {
    sendError(ws, 'stale-session', 'this socket is no longer registered');
    return;
  }
  peer.lastSeen = Date.now();

  switch (msg.type) {
    case 'heartbeat':      return handleHeartbeat(ws, peer, msg);
    case 'call-request':   return handleCallRequest(ws, peer, msg);
    case 'call-accept':    return handleCallAccept(ws, peer, msg);
    case 'call-decline':   return handleCallDecline(ws, peer, msg);
    case 'call-cancel':    return handleCallCancel(ws, peer, msg);
    case 'offer':          return handleSdp(ws, peer, msg, 'offer');
    case 'answer':         return handleSdp(ws, peer, msg, 'answer');
    case 'ice-candidate':  return handleIceCandidate(ws, peer, msg);
    case 'hangup':         return handleHangup(ws, peer, msg);
    default:
      logWarn('ws.unknown_type', { peer: peer.id, type: msg.type });
      sendError(ws, 'unknown-type', `unsupported message type: ${msg.type}`);
  }
}

/**
 * register: { type, id?, authToken?, battery? }
 *
 * Three ways in, checked in this order (ARCHITECTURE-PUBLIC.md §2.7):
 *   1. a valid admin session cookie was presented at the upgrade -> the socket may only claim
 *      the roster peer that account is bound to, and no authToken is needed or consulted;
 *   2. a valid device cookie was presented -> the socket may only claim that roster id;
 *   3. otherwise the original path: roster lookup plus a constant-time authToken comparison.
 *
 * In every case the id must still resolve to a live roster entry, so the roster remains the
 * single source of truth for identity and `canCall()` keeps working untouched.
 */
function handleRegister(ws, msg) {
  const requested = typeof msg.id === 'string' ? msg.id.trim() : '';
  const token = typeof msg.authToken === 'string' ? msg.authToken : '';

  let id = requested;
  let entry = null;
  let via = 'auth-token';
  let reason = 'unknown-id-or-bad-token';

  if (ws.account) {
    via = 'session-cookie';
    id = requested || ws.account.peerId;
    if (id === ws.account.peerId) entry = roster.peers.get(id) || null;
    else reason = 'id-does-not-match-session';
    if (!entry && reason === 'unknown-id-or-bad-token') reason = 'session-peer-not-in-roster';
  } else if (ws.device) {
    via = 'device-cookie';
    id = requested || ws.device;
    if (id === ws.device) entry = roster.peers.get(id) || null;
    else reason = 'id-does-not-match-device-cookie';
    if (!entry && reason === 'unknown-id-or-bad-token') reason = 'device-not-in-roster';
  } else {
    const candidate = id ? roster.peers.get(id) : null;
    if (candidate && tokenMatches(token, candidate.authToken)) entry = candidate;
  }

  // Same generic failure for every rejection: do not leak roster membership.
  if (!entry) {
    logWarn('register.rejected', { id: id || null, remote: ws.remote, via, reason });
    sendError(ws, 'auth-failed', 'unknown peer id or invalid auth token');
    try { ws.close(4003, 'auth-failed'); } catch { /* ignore */ }
    return;
  }

  if (ws.peerId && ws.peerId !== id) {
    sendError(ws, 'already-registered', 'this socket is already registered as another peer');
    return;
  }

  // MULTI-DEVICE: a peer id may hold several live sockets at once.
  //
  // This used to evict the previous socket ("session-replaced"). That was wrong: one person
  // legitimately has a phone AND a laptop, and both authenticate to the same family-* peer id, so
  // the two clients evicted each other in a permanent ~2s loop - each reconnect kicking the other
  // off - which made every call drop after a few seconds. Observed live: 85 connect/replace/close
  // cycles in 5 minutes for family-ana.
  //
  // So we ADD the socket to a set instead. An incoming call rings every device the person has, and
  // a call already in progress is left completely alone when another device connects.
  const existing = peers.get(id);
  if (existing) {
    if (!existing.sockets.has(ws)) {
      existing.sockets.add(ws);
      logInfo('register.additional_socket', {
        peer: id, remote: ws.remote, sockets: existing.sockets.size, via,
      });
    }
    clearTimeout(ws.registerTimer);
    ws.peerId = id;
    existing.lastSeen = Date.now();
    if (ws.account && ws.account.username) existing.actor = ws.account.username;
    applyBatteryReport(existing, msg.battery);
    sendRegistered(ws, id, existing);
    return;
  }

  clearTimeout(ws.registerTimer);
  ws.peerId = id;
  const registered = {
    id,
    sockets: new Set([ws]),
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    remote: ws.remote,
    callId: null,
    // Who is behind this socket, for the call log's `actor` field. null for tablets.
    actor: ws.account ? ws.account.username : null,
    via,
    battery: null,
  };
  applyBatteryReport(registered, msg.battery);
  peers.set(id, registered);

  sendRegistered(ws, id, registered);

  logInfo('register.ok', {
    peer: id,
    kind: entry.kind,
    remote: ws.remote,
    via,
    actor: registered.actor,
    contacts: (roster.peers.get(id)?.allowlist.size) || 0,
  });
  broadcastPresence(id, true);
}

/**
 * Send the `registered` acknowledgement to ONE socket.
 *
 * Factored out because a peer can register more than once - a second device, or a reconnect that
 * joins an existing peer record - and each socket needs its own copy of the contact list.
 */
function sendRegistered(ws, id, record) {
  const entry = roster.peers.get(id);
  if (!entry) return;

  // The client receives its own profile plus the resolved (and now authoritative) contact list.
  const contacts = [...entry.allowlist]
    .map((cid) => roster.peers.get(cid))
    .filter(Boolean)
    .filter((c) => c.allowlist.has(id)) // only mutually-allowed contacts are callable
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      kind: c.kind,
      online: peers.has(c.id),
      busy: Boolean(peers.get(c.id)?.callId),
    }));

  send(ws, {
    type: 'registered',
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    contacts,
    serverTime: Date.now(),
    heartbeatIntervalMs: CONFIG.heartbeatIntervalMs,
    // Non-breaking extra: how many devices this person currently has connected.
    devices: record && record.sockets ? record.sockets.size : 1,
  });
}

/**
 * Optional battery report, sent on `register` and on every `heartbeat`:
 *     { "battery": { "level": 0..100, "charging": true|false } }
 * Purely informational — it surfaces in GET /api/admin/frames so "why is the frame dark?"
 * has an answer. Anything malformed is ignored rather than rejected.
 */
function applyBatteryReport(peer, raw) {
  if (!peer || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const level = Number(raw.level);
  if (!Number.isFinite(level) || level < 0 || level > 100) return;
  peer.battery = {
    level: Math.round(level),
    charging: raw.charging === true,
    at: Date.now(),
  };
}

/**
 * Tell a peer's mutually-allowed contacts that it came online / went offline, so tablets can
 * show a green dot without polling.
 */
function broadcastPresence(peerId, online) {
  const entry = roster.peers.get(peerId);
  if (!entry) return;
  for (const contactId of entry.allowlist) {
    const contact = roster.peers.get(contactId);
    if (!contact || !contact.allowlist.has(peerId)) continue;
    sendTo(contactId, {
      type: 'presence',
      id: peerId,
      displayName: entry.displayName,
      kind: entry.kind,
      online,
      busy: Boolean(peers.get(peerId)?.callId),
    });
  }
}

/** heartbeat: { type, battery? } — application-level keepalive on top of ws ping/pong. */
function handleHeartbeat(ws, peer, msg) {
  peer.lastSeen = Date.now();
  ws.isAlive = true;
  applyBatteryReport(peer, msg && msg.battery);
  send(ws, { type: 'heartbeat-ack', serverTime: Date.now(), callId: peer.callId });
}

/** call-request: { type, to } */
function handleCallRequest(ws, peer, msg) {
  const to = typeof msg.to === 'string' ? msg.to.trim() : '';
  if (!to) {
    sendError(ws, 'bad-request', 'call-request requires a "to" peer id');
    return;
  }
  const result = startCall(peer.id, to, 'peer', { actor: peer.actor, fromWs: ws });
  if (!result.ok) {
    send(ws, { type: 'call-failed', to, code: result.code, detail: result.detail });
  }
}

/** call-accept: { type, callId } */
function handleCallAccept(ws, peer, msg) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    sendError(ws, 'no-such-call', 'unknown call id', { callId: msg.callId ?? null });
    return;
  }
  if (call.to !== peer.id) {
    sendError(ws, 'not-callee', 'only the callee may accept a call', { callId: call.id });
    return;
  }
  if (call.state !== 'ringing') {
    sendError(ws, 'bad-state', `call is not ringing (state=${call.state})`, { callId: call.id });
    return;
  }

  call.state = 'active';
  call.answeredAt = Date.now();
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }

  // This socket is now the callee side of the call; everything after this point
  // is addressed to it alone.
  call.toWs = ws;

  // Stand down the callee's OTHER devices so they stop ringing and never try to
  // negotiate a second peer connection for this call.
  sendToOthers(call.to, ws, {
    type: 'call-ended',
    callId: call.id,
    outcome: 'answered-elsewhere',
    reason: 'answered-on-another-device',
    by: peer.id,
    durationSeconds: 0,
  });

  // The CALLER creates the WebRTC offer once the callee has accepted.
  sendToParty(call, call.from, {
    type: 'call-accepted',
    callId: call.id,
    by: peer.id,
    byName: displayNameOf(peer.id),
    role: 'caller',
    shouldCreateOffer: true,
  });
  send(ws, {
    type: 'call-accepted',
    callId: call.id,
    by: peer.id,
    byName: displayNameOf(peer.id),
    role: 'callee',
    shouldCreateOffer: false,
  });

  logInfo('call.accepted', { callId: call.id, from: call.from, to: call.to });
}

/** call-decline: { type, callId, reason? } */
function handleCallDecline(ws, peer, msg) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    sendError(ws, 'no-such-call', 'unknown call id', { callId: msg.callId ?? null });
    return;
  }
  if (call.to !== peer.id) {
    sendError(ws, 'not-callee', 'only the callee may decline a call', { callId: call.id });
    return;
  }
  const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : 'declined-by-callee';
  sendToParty(call, call.from, {
    type: 'call-declined',
    callId: call.id,
    by: peer.id,
    byName: displayNameOf(peer.id),
    reason,
  });
  endCall(call, 'declined', reason, { notify: [], by: peer.id });
  send(ws, { type: 'call-ended', callId: call.id, outcome: 'declined', reason, by: peer.id, durationSeconds: 0 });
  logInfo('call.declined', { callId: call.id, from: call.from, to: call.to, reason });
}

/** call-cancel: { type, callId } — caller gives up while it is still ringing. */
function handleCallCancel(ws, peer, msg) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    sendError(ws, 'no-such-call', 'unknown call id', { callId: msg.callId ?? null });
    return;
  }
  if (call.from !== peer.id) {
    sendError(ws, 'not-caller', 'only the caller may cancel a call', { callId: call.id });
    return;
  }
  if (call.state !== 'ringing') {
    sendError(ws, 'bad-state', 'call is already connected; use hangup', { callId: call.id });
    return;
  }
  sendTo(call.to, { type: 'call-cancelled', callId: call.id, by: peer.id, byName: displayNameOf(peer.id) });
  endCall(call, 'cancelled', 'cancelled-by-caller', { notify: [peer.id], by: peer.id });
  logInfo('call.cancelled', { callId: call.id, from: call.from, to: call.to });
}

/**
 * offer / answer: { type, callId, sdp }
 * The SDP payload is relayed verbatim; the server never parses or rewrites it.
 */
function handleSdp(ws, peer, msg, kind) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    sendError(ws, 'no-such-call', 'unknown call id', { callId: msg.callId ?? null });
    return;
  }
  if (call.state !== 'active') {
    sendError(ws, 'bad-state', `cannot send ${kind} before the call is accepted`, { callId: call.id });
    return;
  }
  if (kind === 'offer' && call.from !== peer.id) {
    sendError(ws, 'bad-role', 'only the caller sends the offer', { callId: call.id });
    return;
  }
  if (kind === 'answer' && call.to !== peer.id) {
    sendError(ws, 'bad-role', 'only the callee sends the answer', { callId: call.id });
    return;
  }
  const sdp = msg.sdp;
  const sdpOk = typeof sdp === 'string'
    ? sdp.length > 0
    : sdp && typeof sdp === 'object' && typeof sdp.sdp === 'string';
  if (!sdpOk) {
    sendError(ws, 'bad-request', `${kind} requires an "sdp" string or RTCSessionDescription object`, { callId: call.id });
    return;
  }

  const target = otherSide(call, peer.id);
  const delivered = sendToParty(call, target, { type: kind, callId: call.id, from: peer.id, sdp });
  if (!delivered) {
    logWarn('sdp.peer_gone', { callId: call.id, kind, target });
    sendError(ws, 'peer-offline', 'the other peer is no longer connected', { callId: call.id });
    endCall(call, 'failed', 'peer-offline-during-negotiation', { notify: [peer.id], by: null });
    return;
  }
  logInfo('sdp.relayed', { callId: call.id, kind, from: peer.id, to: target });
}

/** ice-candidate: { type, callId, candidate } — relayed verbatim (trickle ICE). */
function handleIceCandidate(ws, peer, msg) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    // Late candidates after hangup are normal; do not spam the client with errors.
    logInfo('ice.dropped_no_call', { peer: peer.id, callId: msg.callId ?? null });
    return;
  }
  if (call.state !== 'active') {
    logInfo('ice.dropped_not_active', { peer: peer.id, callId: call.id, state: call.state });
    return;
  }
  const candidate = msg.candidate;
  // `null` is the legitimate end-of-candidates signal, so allow it explicitly.
  const ok = candidate === null
    || typeof candidate === 'string'
    || (candidate && typeof candidate === 'object');
  if (!ok) {
    sendError(ws, 'bad-request', 'ice-candidate requires a "candidate" field', { callId: call.id });
    return;
  }
  sendToParty(call, otherSide(call, peer.id), {
    type: 'ice-candidate',
    callId: call.id,
    from: peer.id,
    candidate,
  });
}

/** hangup: { type, callId, reason? } — works in either state, from either side. */
function handleHangup(ws, peer, msg) {
  const call = callForPeer(peer.id, msg.callId);
  if (!call) {
    sendError(ws, 'no-such-call', 'unknown call id', { callId: msg.callId ?? null });
    return;
  }
  const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : 'hangup';
  const outcome = call.state === 'active' ? 'accepted-ended' : 'cancelled';
  sendToParty(call, otherSide(call, peer.id), {
    type: 'hangup',
    callId: call.id,
    by: peer.id,
    byName: displayNameOf(peer.id),
    reason,
  });
  endCall(call, outcome, reason, { notify: [peer.id, otherSide(call, peer.id)], by: peer.id });
  logInfo('call.hangup', { callId: call.id, by: peer.id, outcome, reason });
}

// ---------------------------------------------------------------------------
// Heartbeat sweep: ping every peer, drop the ones that did not pong last round
// ---------------------------------------------------------------------------

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    try {
      if (ws.isAlive === false) {
        logWarn('ws.stale_terminated', { peer: ws.peerId, remote: ws.remote });
        ws.terminate(); // fires 'close', which cleans up peers/calls
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    } catch (err) {
      logWarn('ws.ping_failed', { peer: ws.peerId, error: String(err && err.message || err) });
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}, CONFIG.heartbeatIntervalMs);
heartbeatTimer.unref();

// Presence broadcast on disconnect is handled here (after peers map cleanup in 'close').
wss.on('close', () => clearInterval(heartbeatTimer));

// ---------------------------------------------------------------------------
// HTTP: control API, health, static files
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Read a small JSON request body. Rejects oversized or malformed payloads. */
function readJsonBody(req, limitBytes = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('body must be a JSON object'), { statusCode: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => reject(Object.assign(err, { statusCode: 400 })));
  });
}

/** Bearer-token check for the control API. */
function controlAuthorised(req) {
  if (!CONFIG.controlToken) return false;
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!m) return false;
  return tokenMatches(m[1].trim(), CONFIG.controlToken);
}

/**
 * One gate at the top of every request, before any route dispatch, and it fails closed:
 * anything not explicitly PUBLIC requires an authenticated principal
 * (ARCHITECTURE-PUBLIC.md §2.4).
 */
function handleHttpRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  const pathname = decodeURIComponentSafe(url.pathname);
  if (pathname === null) {
    sendJson(res, 400, { error: 'bad-path' });
    return;
  }

  // Security headers go on every response, including 401s and 404s.
  auth.applySecurityHeaders(res);

  // Resolve the caller once. This also mints the device cookie when the tablet arrives with
  // ?device=&token=, and slides the session expiry for an admin.
  const principal = auth.authenticate(req, res, url);
  req.frameoPrincipal = principal;
  // ice.js reads either of these; give it the shape it expects for an admin session.
  req.frameoAccount = principal.type === 'admin'
    ? { username: principal.username, displayName: principal.displayName, peerId: principal.peerId }
    : null;

  // --- PUBLIC: reachable with no credential at all -------------------------
  if (pathname === '/api/health') return handleHealth(req, res, principal);
  if (pathname === '/api/auth/login' || pathname === '/api/login') {
    auth.handleLogin(req, res).catch((err) => httpFailed(res, 'auth.login', err));
    return;
  }
  if (pathname === '/api/auth/session' || pathname === '/api/session') {
    return auth.handleSession(req, res, principal);
  }
  // The tablet watchdog authenticates itself with its own roster token in the body, over the
  // public Funnel URL, precisely so it can still report when the tailnet path is broken.
  if (pathname === '/api/frame-heartbeat') return handleFrameHeartbeat(req, res);
  // Bearer-only control API. Never cookie-authenticated, so it needs no CSRF check and no
  // session; it does its own 401.
  if (pathname === '/api/call') return handleControlCall(req, res);
  if (pathname === '/api/hangup') return handleControlHangup(req, res);

  // --- the gate ------------------------------------------------------------
  const isPublicAsset = PUBLIC_ASSET_PATHS.has(pathname);
  if (CONFIG.requireAuth && !isPublicAsset && principal.type === 'anonymous') {
    return denyUnauthenticated(req, res, url, pathname);
  }

  // --- CSRF: every state-changing, cookie-authenticated request ------------
  const needsCsrf = pathname.startsWith('/api/admin/')
    || pathname === '/api/auth/logout'
    || pathname === '/api/auth/logout-all'
    || pathname === '/api/logout';
  if (needsCsrf && !auth.csrfOk(req, principal)) {
    logWarn('http.csrf_rejected', {
      path: pathname,
      method: req.method,
      username: principal.username || null,
    });
    sendJson(res, 403, { error: 'csrf', detail: `send the ${auth.CSRF_HEADER} header` });
    return;
  }

  if (pathname === '/api/auth/logout' || pathname === '/api/logout') {
    return auth.handleLogout(req, res, principal);
  }
  if (pathname === '/api/auth/logout-all') return auth.handleLogoutAll(req, res, principal);

  if (pathname === '/api/photos') {
    handlePhotoManifest(req, res, url, principal).catch((err) => httpFailed(res, 'photos.manifest', err));
    return;
  }
  if (pathname === '/api/weather') {
    weatherService.handleRequest(req, res, sendJson)
      .catch((err) => httpFailed(res, 'weather.current', err));
    return;
  }
  if (pathname.startsWith('/api/photo/')) {
    handlePhotoAsset(req, res, pathname, url).catch((err) => httpFailed(res, 'photos.asset', err));
    return;
  }
  // ICE / TURN credentials. Two names for one handler: /api/ice is what the client
  // code calls, /api/turn-credentials is the name written into
  // ARCHITECTURE-PUBLIC.md §3.5. Both are device/admin only and fail closed.
  if (pathname === '/api/ice' || pathname === '/api/turn-credentials') {
    return iceService.handleRequest(req, res, url, sendJson);
  }

  // --- admin API: requireAdmin() -------------------------------------------
  if (pathname.startsWith('/api/admin/')) {
    if (principal.type !== 'admin') {
      logWarn('http.admin_denied', {
        path: pathname,
        method: req.method,
        principal: principal.type,
        id: principal.id || null,
      });
      sendJson(res, principal.type === 'anonymous' ? 401 : 403, {
        error: principal.type === 'anonymous' ? 'unauthenticated' : 'forbidden',
        detail: 'this endpoint requires an admin login',
      });
      return;
    }
    if (admin.route(req, res, url, pathname, principal)) return;
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  // A logged-in PERSON who typed the bare hostname wants the phone app, not the tablet
  // carousel. Only admins are redirected: a frame's device cookie must keep getting "/"
  // exactly as before, because that is the kiosk URL burnt into two provisioned tablets.
  if ((pathname === '/' || pathname === '/index.html') && principal.type === 'admin') {
    res.writeHead(302, { location: '/admin/', 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
    return;
  }
  if (pathname === '/login' || pathname === '/login/') return serveLoginAsset(req, res, '/login.html');
  if (pathname === '/login.html' || pathname === '/login.css' || pathname === '/login.js') {
    return serveLoginAsset(req, res, pathname);
  }
  serveStatic(req, res, pathname);
}

/** Paths that are reachable with no credential at all. Everything else is gated. */
const PUBLIC_ASSET_PATHS = new Set(CONFIG.publicAssetPaths);

/**
 * Built-in login page, used only when public/login.html is absent. It is deliberately plain
 * and deliberately CSP-clean (no inline <script>, no inline style, no onclick attributes).
 * If the client bundle provides its own login files they are served instead, byte for byte.
 */
const BUILTIN_LOGIN = {
  '/login.html': {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Rama foto - autentificare</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main class="card">
  <h1>Rama foto</h1>
  <p class="sub">Introdu parola pentru a continua.</p>
  <form id="login-form" autocomplete="on">
    <label for="username">Utilizator <span class="opt">(optional)</span></label>
    <input id="username" name="username" type="text" autocomplete="username"
           autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="text">
    <label for="password">Parola</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button id="submit" type="submit">Intra</button>
  </form>
  <p id="message" role="status" aria-live="polite"></p>
</main>
<script src="/login.js"></script>
</body>
</html>
`,
  },
  '/login.css': {
    type: 'text/css; charset=utf-8',
    body: `:root { color-scheme: dark light; --bg:#101216; --fg:#f2f4f8; --muted:#9aa3b2;
  --accent:#3f7fd8; --err:#ff6b6b; --field:#1b1f27; --line:#2b313c; }
* { box-sizing: border-box; }
body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
  background:var(--bg); color:var(--fg);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.card { width:100%; max-width:22rem; }
h1 { font-size:1.6rem; margin:0 0 .25rem; }
.sub { color:var(--muted); margin:0 0 1.5rem; }
label { display:block; margin:1rem 0 .35rem; font-size:.9rem; color:var(--muted); }
.opt { opacity:.7; }
input { width:100%; padding:.85rem .9rem; font-size:1.05rem; color:var(--fg);
  background:var(--field); border:1px solid var(--line); border-radius:.6rem; }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
button { width:100%; margin-top:1.5rem; padding:.9rem; font-size:1.05rem; font-weight:600;
  color:#fff; background:var(--accent); border:0; border-radius:.6rem; }
button[disabled] { opacity:.55; }
#message { min-height:1.5rem; margin:1rem 0 0; color:var(--err); }
#message.ok { color:var(--muted); }
`,
  },
  '/login.js': {
    type: 'text/javascript; charset=utf-8',
    body: `'use strict';
(function () {
  var form = document.getElementById('login-form');
  var message = document.getElementById('message');
  var submit = document.getElementById('submit');

  function nextTarget() {
    var raw = new URLSearchParams(window.location.search).get('next') || '/';
    // Same rule the server applies: one leading slash, no scheme, no protocol-relative URL.
    return /^\\/(?!\\/)/.test(raw) ? raw : '/';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    if (!password) return;
    submit.disabled = true;
    message.className = 'ok';
    message.textContent = 'Se verifica...';

    var payload = { password: password };
    if (username) payload.username = username;

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, body: body };
      });
    }).then(function (result) {
      if (result.status === 200) {
        message.className = 'ok';
        message.textContent = 'Bine ai venit!';
        window.location.replace(nextTarget());
        return;
      }
      submit.disabled = false;
      message.className = '';
      if (result.status === 429) message.textContent = 'Prea multe incercari. Asteapta 15 minute.';
      else message.textContent = 'Parola gresita.';
    }).catch(function () {
      submit.disabled = false;
      message.className = '';
      message.textContent = 'Conexiune esuata. Incearca din nou.';
    });
  });
})();
`,
  },
};

function httpFailed(res, where, err) {
  logError('http.handler_threw', { where, error: String((err && err.stack) || err) });
  try {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' });
    else res.destroy();
  } catch { /* ignore */ }
}

/**
 * No credential on a gated path. A browser asking for a page is bounced to the login form with
 * a validated `next`; anything else gets an honest 401.
 */
function denyUnauthenticated(req, res, url, pathname) {
  const accept = String(req.headers.accept || '');
  const wantsHtml = accept.includes('text/html');
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  logWarn('http.unauthenticated', {
    path: pathname,
    method: req.method,
    sourceKey: auth.sourceKeyOf(req),
  });
  if (wantsHtml && isGet) {
    const next = auth.safeNextPath(url.pathname + (url.search || ''));
    res.writeHead(302, {
      location: '/login?next=' + encodeURIComponent(next),
      'cache-control': 'no-store',
      'content-length': 0,
    });
    res.end();
    return;
  }
  sendJson(res, 401, { error: 'unauthenticated', detail: 'log in at /login' });
}

/**
 * Serve the login page. If the client bundle ships its own login.html / login.css / login.js
 * those win; otherwise the built-in fallback below is used, so a missing client file can never
 * lock all three people out of their own photo frame. The fallback obeys the same CSP as
 * everything else: no inline script, no inline style.
 */
function serveLoginAsset(req, res, assetPath) {
  const relative = assetPath.replace(/^\/+/, '');
  const target = path.join(CONFIG.publicDir, relative);
  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      streamFile(req, res, target, stat);
      return;
    }
    const fallback = BUILTIN_LOGIN[assetPath];
    if (!fallback) {
      sendJson(res, 404, { error: 'not-found', detail: assetPath });
      return;
    }
    const body = Buffer.from(fallback.body, 'utf8');
    res.writeHead(200, {
      'content-type': fallback.type,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * GET /api/health
 *
 * PUBLIC, but reduced: an anonymous caller gets exactly `{"ok":true}`. The verbose payload
 * (peer list, roster size, Immich state, uptime) is a reconnaissance gift on the public
 * internet, so it is only returned to an authenticated principal. `healthcheck.sh` therefore
 * has to send `Authorization: Bearer $CONTROL_TOKEN` to keep seeing the full body; Docker's own
 * HEALTHCHECK only looks at the status code and is unaffected.
 */
function handleHealth(req, res, principal) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (CONFIG.requireAuth && (!principal || principal.type === 'anonymous')) {
    sendJson(res, 200, { ok: true });
    return;
  }
  const now = Date.now();
  const connected = [...peers.values()].map((p) => ({
    id: p.id,
    displayName: displayNameOf(p.id),
    kind: kindOf(p.id),
    connectedForSeconds: Math.round((now - p.connectedAt) / 1000),
    lastSeenSecondsAgo: Math.round((now - p.lastSeen) / 1000),
    inCall: p.callId || null,
  }));
  const activeCalls = [...calls.values()].map((c) => ({
    callId: c.id,
    from: c.from,
    to: c.to,
    state: c.state,
    origin: c.origin,
    ageSeconds: Math.round((now - c.createdAt) / 1000),
    talkingSeconds: c.answeredAt ? Math.round((now - c.answeredAt) / 1000) : 0,
  }));

  sendJson(res, 200, {
    status: 'ok',
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    peers: {
      connected: connected.length,
      inRoster: roster.peers.size,
      list: connected,
    },
    calls: {
      active: activeCalls.filter((c) => c.state === 'active').length,
      ringing: activeCalls.filter((c) => c.state === 'ringing').length,
      max: CONFIG.maxConcurrentCalls,
      list: activeCalls,
    },
    roster: { path: roster.source, loadedAt: roster.loadedAt },
    // Never a hash, a session id or a cookie value: counts and paths only.
    auth: { ...auth.stats(), gateEnabled: CONFIG.requireAuth, publicOrigin: CONFIG.publicOrigin || null },
    // Tablet-side watchdog liveness. `stale` here is the thing
    // server/frame-heartbeat-alert.sh alerts on.
    frames: frameHeartbeatSummary(),
    callLog: { path: CONFIG.callLogPath, writable: callLogReady },
    controlApi: { enabled: Boolean(CONFIG.controlToken) },
    // Secret-free: counts and booleans only, never a URL with a credential in it.
    turn: iceService.status(),
    photos: {
      enabled: Boolean(CONFIG.immichApiKey),
      immichUrl: CONFIG.immichUrl,
      albums: CONFIG.immichAlbumIds.length,
      perFrameAlbums: [...FRAME_ALBUMS.keys()],
      manifests: [...photoManifests.entries()].map(([key, m]) => ({
        albums: key === '*library*' ? 0 : key.split('|').length,
        cached: m.photos.length,
        cachedAt: m.at ? new Date(m.at).toISOString() : null,
        error: m.error,
      })),
    },
    memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
  });
}

/**
 * POST /api/call  { "from": "family-ana", "to": "frame-a" }
 * Authorization: Bearer $CONTROL_TOKEN
 *
 * Rings `to` on behalf of `from`. Subject to exactly the same whitelist and busy rules as a
 * WebSocket call-request — the control token grants no whitelist bypass.
 */
async function handleControlCall(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
    return;
  }
  if (!CONFIG.controlToken) {
    logWarn('control.disabled', { path: '/api/call' });
    sendJson(res, 503, { error: 'control-api-disabled', detail: 'CONTROL_TOKEN is not set' });
    return;
  }
  if (!controlAuthorised(req)) {
    logWarn('control.unauthorised', { path: '/api/call', remote: req.socket.remoteAddress });
    res.setHeader('www-authenticate', 'Bearer');
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: 'bad-body', detail: String(err.message || err) });
    return;
  }

  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) {
    sendJson(res, 400, { error: 'bad-request', detail: 'both "from" and "to" are required' });
    return;
  }

  logInfo('control.call_requested', { from, to, remote: req.socket.remoteAddress });
  const result = startCall(from, to, 'control-api');
  if (!result.ok) {
    const status = result.code === 'not-allowed' ? 403
      : result.code === 'busy' ? 409
      : result.code === 'server-busy' ? 503
      : 409;
    sendJson(res, status, { error: result.code, detail: result.detail, from, to });
    return;
  }
  sendJson(res, 202, { status: 'ringing', callId: result.callId, from, to });
}

/**
 * POST /api/hangup  { "callId": "c_..." }  or  { "peer": "frame-a" }
 * Authorization: Bearer $CONTROL_TOKEN
 *
 * Operational escape hatch: end a call remotely when a tablet is stuck. Not part of the peer
 * protocol; purely for administration.
 */
async function handleControlHangup(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
    return;
  }
  if (!CONFIG.controlToken) {
    sendJson(res, 503, { error: 'control-api-disabled', detail: 'CONTROL_TOKEN is not set' });
    return;
  }
  if (!controlAuthorised(req)) {
    logWarn('control.unauthorised', { path: '/api/hangup', remote: req.socket.remoteAddress });
    res.setHeader('www-authenticate', 'Bearer');
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: 'bad-body', detail: String(err.message || err) });
    return;
  }

  const callId = typeof body.callId === 'string' ? body.callId.trim() : '';
  const peerId = typeof body.peer === 'string' ? body.peer.trim() : '';
  let call = callId ? calls.get(callId) : null;
  if (!call && peerId) {
    const p = peers.get(peerId);
    if (p && p.callId) call = calls.get(p.callId);
  }
  if (!call) {
    sendJson(res, 404, { error: 'no-such-call', detail: 'no matching active call' });
    return;
  }

  const id = call.id;
  const outcome = call.state === 'active' ? 'accepted-ended' : 'cancelled';
  sendToParty(call, call.from, { type: 'hangup', callId: id, by: 'control-api', byName: 'admin', reason: 'admin-hangup' });
  sendToParty(call, call.to, { type: 'hangup', callId: id, by: 'control-api', byName: 'admin', reason: 'admin-hangup' });
  endCall(call, outcome, 'admin-hangup', { notify: [call.from, call.to], by: 'control-api' });
  logInfo('control.hangup', { callId: id });
  sendJson(res, 200, { status: 'ended', callId: id });
}

// ---------------------------------------------------------------------------
// Photo API (Immich proxy)
// ---------------------------------------------------------------------------
//
// The tablet client is deliberately credential-free: it holds no Immich API key
// and talks only to this origin. So the two endpoints it needs live here:
//
//   GET /api/photos?limit=N   -> { photos: [ { id, url } ] }   newest first
//   GET /api/photo/<assetId>  -> the preview-size JPEG for that asset
//
// Immich is reached over the internal `frameo` docker network (immich-server),
// never over the published 127.0.0.1 port. Without IMMICH_API_KEY the manifest
// is served as an empty list (HTTP 200) rather than an error: the frame then
// keeps showing whatever the service worker already cached instead of flapping.

/** Immich asset ids are UUIDs; be strict, this value goes into an upstream URL. */
const ASSET_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * One cached manifest per distinct album set, keyed by the sorted album id list. With
 * FRAME_ALBUM_MAP unset there is exactly one key and this behaves like the single cache it
 * replaced; with it set there are at most three (frame A, frame B, everyone else).
 * @type {Map<string, { at: number, photos: Array<{id:string,url:string}>, error: string|null }>}
 */
const photoManifests = new Map();
/** @type {Map<string, Promise<void>>} in-flight refreshes, so N frames cause one Immich call. */
const photoManifestInFlight = new Map();
let immichKeyWarned = false;

const EMPTY_MANIFEST = { at: 0, photos: [], error: null };

/** Which Immich albums this principal's carousel is built from. */
function albumIdsFor(principal) {
  if (principal && principal.type === 'device' && FRAME_ALBUMS.has(principal.id)) {
    return FRAME_ALBUMS.get(principal.id);
  }
  return CONFIG.immichAlbumIds;
}

const manifestKeyFor = (albumIds) => (albumIds.length ? [...albumIds].sort().join('|') : '*library*');

const getManifest = (key) => photoManifests.get(key) || EMPTY_MANIFEST;

/** Drop every cached manifest. Called when a photo is added or removed. */
function invalidatePhotoManifests() {
  for (const [key, entry] of photoManifests) {
    photoManifests.set(key, { at: 0, photos: entry.photos, error: entry.error });
  }
}

/** One fetch against Immich, with an API key and a hard timeout. */
async function immichFetch(pathAndQuery, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.immichTimeoutMs);
  try {
    return await fetch(CONFIG.immichUrl + pathAndQuery, {
      ...init,
      signal: controller.signal,
      headers: {
        'x-api-key': CONFIG.immichApiKey,
        accept: 'application/json',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort capture date of an Immich asset, for "newest first" ordering. */
function assetTime(asset) {
  const raw = asset.fileCreatedAt || asset.localDateTime || asset.createdAt || asset.updatedAt;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function usableImage(asset) {
  if (!asset || typeof asset.id !== 'string' || !ASSET_ID_RE.test(asset.id)) return false;
  if (asset.type && String(asset.type).toUpperCase() !== 'IMAGE') return false;
  if (asset.isTrashed || asset.isArchived) return false;
  return true;
}

/**
 * Build the manifest from Immich.
 *  - IMMICH_ALBUM_IDS set  -> the union of those albums (this is the curated case)
 *  - otherwise             -> the newest images in the library
 * Throws on a transport/HTTP failure so the caller can fall back to the last
 * good manifest.
 */
async function loadPhotoManifest(albumIds) {
  if (!CONFIG.immichApiKey) return { photos: [], error: 'immich-api-key-not-set' };

  const byId = new Map();

  if (albumIds.length) {
    let ok = 0;
    let lastError = null;
    for (const albumId of albumIds) {
      let res;
      try {
        // NOTE (verified against a live Immich v3.1.0 on 2026-08-08):
        // GET /api/albums/{id} does NOT return an `assets` array. It reports
        // `assetCount` but omits the assets themselves, and `?withoutAssets=false`
        // does not bring them back either. Reading the album directly therefore
        // always yielded zero photos.
        // The supported way to list an album's assets is the metadata search
        // endpoint filtered by albumIds, which returns `.assets.items[]`.
        res = await immichFetch('/api/search/metadata', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            albumIds: [albumId],
            type: 'IMAGE',
            size: Math.min(1000, Math.max(1, CONFIG.photoLimit)),
            page: 1,
            withExif: false,
            order: 'desc',
          }),
        });
      } catch (err) {
        lastError = String((err && err.message) || err);
        logWarn('photos.album_fetch_failed', { album: albumId, error: lastError });
        continue;
      }
      if (!res.ok) {
        lastError = 'http-' + res.status;
        logWarn('photos.album_http_error', { album: albumId, status: res.status });
        continue;
      }
      const doc = await res.json().catch(() => null);
      const assets =
        (doc && doc.assets && Array.isArray(doc.assets.items) && doc.assets.items) || [];
      for (const asset of assets) if (usableImage(asset)) byId.set(asset.id, asset);
      ok++;
    }
    if (ok === 0) throw new Error('no album could be read from Immich (' + (lastError || 'unknown') + ')');
  } else {
    const res = await immichFetch('/api/search/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'IMAGE',
        size: Math.min(1000, Math.max(1, CONFIG.photoLimit)),
        page: 1,
        withExif: false,
        order: 'desc',
      }),
    });
    if (!res.ok) throw new Error('immich search returned HTTP ' + res.status);
    const doc = await res.json().catch(() => null);
    const items = (doc && doc.assets && Array.isArray(doc.assets.items) && doc.assets.items)
      || (doc && Array.isArray(doc.items) && doc.items)
      || [];
    for (const asset of items) if (usableImage(asset)) byId.set(asset.id, asset);
  }

  const photos = [...byId.values()]
    .sort((a, b) => assetTime(b) - assetTime(a))
    .slice(0, CONFIG.photoLimit)
    .map((asset) => ({ id: asset.id, url: '/api/photo/' + encodeURIComponent(asset.id) }));

  return { photos, error: photos.length ? null : 'immich-returned-no-images' };
}

/** Serve the manifest, refreshing it at most once per PHOTO_MANIFEST_TTL_MS per album set. */
async function handlePhotoManifest(req, res, url, principal) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (!CONFIG.immichApiKey && !immichKeyWarned) {
    immichKeyWarned = true;
    logWarn('photos.disabled', {
      detail: 'IMMICH_API_KEY is not set; /api/photos will return an empty manifest',
    });
  }

  const albumIds = albumIdsFor(principal);
  const key = manifestKeyFor(albumIds);

  if (Date.now() - getManifest(key).at >= CONFIG.photoManifestTtlMs) {
    let pending = photoManifestInFlight.get(key);
    if (!pending) {
      pending = loadPhotoManifest(albumIds)
        .then((result) => {
          photoManifests.set(key, { at: Date.now(), photos: result.photos, error: result.error });
          logInfo('photos.manifest_refreshed', {
            count: result.photos.length,
            albums: albumIds.length,
            error: result.error,
          });
        })
        .catch((err) => {
          // Keep the previous manifest; a dead Immich must not blank the frames.
          const message = String((err && err.message) || err);
          photoManifests.set(key, { at: Date.now(), photos: getManifest(key).photos, error: message });
          logError('photos.manifest_refresh_failed', { error: message });
        })
        .finally(() => { photoManifestInFlight.delete(key); });
      photoManifestInFlight.set(key, pending);
    }
    await pending;
  }

  const manifest = getManifest(key);
  const requested = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, CONFIG.photoLimit)
    : CONFIG.photoLimit;

  sendJson(res, 200, {
    photos: manifest.photos.slice(0, limit),
    count: Math.min(manifest.photos.length, limit),
    total: manifest.photos.length,
    cachedAt: manifest.at ? new Date(manifest.at).toISOString() : null,
    source: albumIds.length ? 'albums' : 'library',
    error: manifest.error,
  });
}

/**
 * Stream one Immich image through this origin.
 * `?size=thumbnail` gives the small grid tile the admin UI uses; anything else (including no
 * parameter at all) keeps the original behaviour and returns the `preview` size the carousel
 * wants, so existing tablet URLs are unchanged.
 */
async function handlePhotoAsset(req, res, pathname, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  const id = pathname.slice('/api/photo/'.length);
  if (!ASSET_ID_RE.test(id)) {
    sendJson(res, 400, { error: 'bad-asset-id' });
    return;
  }
  if (!CONFIG.immichApiKey) {
    sendJson(res, 503, { error: 'photo-backend-not-configured', detail: 'IMMICH_API_KEY is not set' });
    return;
  }
  const requestedSize = url && url.searchParams ? String(url.searchParams.get('size') || '') : '';
  const size = requestedSize === 'thumbnail' ? 'thumbnail' : 'preview';

  let upstream;
  try {
    upstream = await immichFetch(
      '/api/assets/' + encodeURIComponent(id) + '/thumbnail?size=' + size,
      { headers: { accept: 'image/*' } },
    );
  } catch (err) {
    logWarn('photos.asset_fetch_failed', { asset: id, error: String((err && err.message) || err) });
    sendJson(res, 502, { error: 'upstream-unreachable' });
    return;
  }

  if (!upstream.ok) {
    sendJson(res, upstream.status === 404 ? 404 : 502, { error: 'upstream-error', status: upstream.status });
    return;
  }

  const headers = {
    'content-type': upstream.headers.get('content-type') || 'image/jpeg',
    // Immich asset ids are immutable, so the bytes behind one never change. `private` rather
    // than `public` now that the endpoint is authenticated: cache it on the tablet and in the
    // phone's browser, never in a shared proxy. This is the one deliberate exception to
    // "no-store on every /api/* response" — without it the frames lose their offline cache and
    // re-download the whole carousel on every reload.
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['content-length'] = length;

  if (req.method === 'HEAD' || !upstream.body) {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (err) => {
    logWarn('photos.asset_stream_error', { asset: id, error: String((err && err.message) || err) });
    res.destroy();
  });
  stream.pipe(res);
}

/** Static file serving out of PUBLIC_DIR, with traversal protection. */
function serveStatic(req, res, pathname) {
  let relative = pathname.replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  // Reject anything with NUL bytes or that escapes the public directory.
  if (relative.includes('\0')) {
    sendJson(res, 400, { error: 'bad-path' });
    return;
  }
  const target = path.resolve(CONFIG.publicDir, relative);
  const rootWithSep = CONFIG.publicDir.endsWith(path.sep) ? CONFIG.publicDir : CONFIG.publicDir + path.sep;
  if (target !== CONFIG.publicDir && !target.startsWith(rootWithSep)) {
    logWarn('http.traversal_blocked', { pathname, remote: req.socket.remoteAddress });
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  fs.stat(target, (err, stat) => {
    // A DIRECTORY that exists (e.g. /admin) must redirect to its trailing-slash form. Without
    // this it falls through to the SPA fallback below and serves the TABLET carousel at
    // /admin — the single most confusing failure this app can produce, because the page loads
    // and simply is not the admin UI. Relative asset URLs in the admin bundle need the
    // trailing slash anyway.
    if (!err && stat.isDirectory()) {
      res.writeHead(301, {
        location: encodeURI(pathname) + '/',
        'cache-control': 'no-store',
        'content-length': 0,
      });
      res.end();
      return;
    }
    if (err || !stat.isFile()) {
      // Single-page-app fallback, deliberately narrow: only top-level, extension-less routes
      // such as /frame or /call. Anything nested or with a file extension gets an honest 404.
      if (!path.extname(relative) && !relative.includes('/')) {
        const indexPath = path.join(CONFIG.publicDir, 'index.html');
        fs.stat(indexPath, (indexErr, indexStat) => {
          if (indexErr || !indexStat.isFile()) {
            sendJson(res, 404, { error: 'not-found', detail: pathname });
            return;
          }
          streamFile(req, res, indexPath, indexStat);
        });
        return;
      }
      sendJson(res, 404, { error: 'not-found', detail: pathname });
      return;
    }
    streamFile(req, res, target, stat);
  });
}

function streamFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isHtml = ext === '.html' || ext === '.htm';
  // The service worker is the thing that controls client freshness: if IT is
  // cached, a tablet keeps running the old UI forever. Must always revalidate.
  const isServiceWorker = path.basename(filePath).toLowerCase() === 'sw.js';
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }

  const headers = {
    'content-type': contentType,
    'content-length': stat.size,
    'last-modified': new Date(stat.mtimeMs).toUTCString(),
    etag,
    // HTML must never be cached: the tablets should pick up client updates on reload.
    'cache-control': (isHtml || isServiceWorker) ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    logWarn('http.stream_error', { file: filePath, error: String(err && err.message || err) });
    res.destroy();
  });
  stream.pipe(res);
}

server.on('clientError', (err, socket) => {
  logWarn('http.client_error', { error: String(err && err.message || err) });
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Process-level safety nets: log, never die silently
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  logError('process.uncaught_exception', { error: String(err && err.stack || err) });
});
process.on('unhandledRejection', (reason) => {
  logError('process.unhandled_rejection', { error: String((reason && reason.stack) || reason) });
});

function shutdown(signal) {
  logInfo('process.shutdown', { signal, peers: peers.size, calls: calls.size });
  // Flush the frame heartbeat table so a restart does not lose the last minute of
  // liveness and make the alert script cry wolf.
  flushFrameHeartbeats(true);
  // Persist sessions synchronously: nobody should have to log in again because the container
  // was restarted for an unrelated reason.
  try { auth.stop(); } catch (err) {
    logError('auth.stop_failed', { error: String((err && err.message) || err) });
  }
  // Close every live call so the audit trail is not left with dangling entries.
  for (const call of [...calls.values()]) {
    const outcome = call.state === 'active' ? 'accepted-ended' : 'missed';
    endCall(call, outcome, 'server-shutdown', { notify: [call.from, call.to], by: null });
  }
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server-shutdown'); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => {
  logInfo('process.sighup_reload_roster', {});
  loadRoster();
  auth.loadAccounts();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadRoster({ initial: true });
startRosterWatcher();
initCallLog();
initFrameHeartbeats();
// Restores the session store, loads admins.json + ADMIN_PASSWORD_HASHES, and starts the
// hot-reload watcher. Must run after loadRoster() so account->peer binding can be validated.
auth.start();

try {
  fs.mkdirSync(CONFIG.uploadTmpDir, { recursive: true });
} catch (err) {
  logError('upload.tmpdir_failed', {
    path: CONFIG.uploadTmpDir,
    error: String((err && err.message) || err),
    detail: 'photo uploads will fail until this directory is writable',
  });
}

if (CONFIG.requireAuth && !CONFIG.publicOrigin) {
  logWarn('auth.public_origin_missing', {
    detail: 'PUBLIC_ORIGIN is not set. The WebSocket Origin check falls back to comparing the '
      + 'Origin host against the request Host header, and ice.js cannot derive TURN_PUBLIC_URL, '
      + 'so phones get no relay. Set it to https://<machine>.<tailnet>.ts.net',
  });
}
if (CONFIG.trustTailscaleIdentityHeader) {
  logError('auth.trust_tailscale_header_enabled', {
    detail: 'TRUST_TAILSCALE_IDENTITY_HEADER must ship as false (ARCHITECTURE-PUBLIC.md §4.4). '
      + 'This server ignores the header regardless; unset the variable.',
  });
}
if (!CONFIG.requireAuth) {
  logError('auth.gate_disabled', {
    detail: 'REQUIRE_AUTH=false. Every endpoint is reachable without a credential. This is only '
      + 'safe on a tailnet-only deployment; never with tailscale funnel enabled.',
  });
}
if (!ALBUMS.length) {
  logWarn('albums.none_configured', {
    detail: 'no IMMICH_ALBUM_A/_B/_ALL and no IMMICH_ALBUM_IDS; the admin photo API will be empty',
  });
} else {
  logInfo('albums.configured', { albums: ALBUMS.map((a) => ({ key: a.key, label: a.label })) });
}
if (FRAME_ALBUMS.size) {
  logInfo('albums.per_frame', { frames: [...FRAME_ALBUMS.keys()] });
} else if (ALBUMS.length > 1) {
  logWarn('albums.no_per_frame_map', {
    detail: 'FRAME_ALBUM_MAP is empty, so every frame shows the union of all configured albums '
      + 'and the admin UI album picker has no effect on which frame displays a photo. Set e.g. '
      + 'FRAME_ALBUM_MAP="frame-a:a,frame-b:b".',
  });
}

if (!CONFIG.controlToken) {
  logWarn('control.token_missing', {
    detail: 'CONTROL_TOKEN is not set; POST /api/call and /api/hangup will return 503',
  });
}
if (!CONFIG.immichApiKey) {
  logWarn('photos.token_missing', {
    detail: 'IMMICH_API_KEY is not set; /api/photos returns an empty manifest and the frames will '
      + 'show only what their service worker already cached',
  });
}
if (!fs.existsSync(CONFIG.publicDir)) {
  logWarn('static.public_dir_missing', {
    path: CONFIG.publicDir,
    detail: 'static requests will 404 until the client files are mounted',
  });
}

server.listen(CONFIG.port, CONFIG.bindAddr, () => {
  logInfo('server.listening', {
    address: `${CONFIG.bindAddr}:${CONFIG.port}`,
    wsPath: CONFIG.wsPath,
    publicDir: CONFIG.publicDir,
    rosterPath: CONFIG.rosterPath,
    callLogPath: CONFIG.callLogPath,
    maxConcurrentCalls: CONFIG.maxConcurrentCalls,
    ringTimeoutMs: CONFIG.ringTimeoutMs,
    heartbeatIntervalMs: CONFIG.heartbeatIntervalMs,
    node: process.version,
  });
});
