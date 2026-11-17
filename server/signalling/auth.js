'use strict';

/**
 * Authentication, sessions, brute-force protection and the security-header policy for the
 * frameo-clone signalling server.
 *
 * Implements ARCHITECTURE-PUBLIC.md §2 in full. Read that document before changing anything
 * here; the cookie names, the hash format, the counters and the header values are a contract
 * that the client code and the ops scripts are written against.
 *
 * Three principals exist and nothing else may be granted access:
 *   admin    a person on a phone     -> username + scrypt password -> `frameo_sid` cookie
 *   device   a tablet in a kiosk     -> roster authToken           -> `frameo_device` cookie
 *   control  the local ring script   -> CONTROL_TOKEN bearer
 *
 * Everything is in memory except the session store, which is mirrored to a 0600 file so a
 * container restart does not log three people out.
 *
 * Logging rule, absolute: this module never logs a password, a password hash, a session id, a
 * cookie value, a roster authToken, or a minted TURN credential. Rate-limit buckets are keyed
 * on an HMAC of the source address, never the address itself.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { verifyPassword, isValidHash, MAX_PASSWORD_BYTES } = require('./scrypt');

const COOKIE_SESSION = 'frameo_sid';
const COOKIE_CSRF = 'frameo_csrf';
const COOKIE_DEVICE = 'frameo_device';
const CSRF_HEADER = 'x-frameo-csrf';

const DEVICE_COOKIE_MAX_AGE = 31536000; // 365 days
const SESSION_PERSIST_INTERVAL_MS = 30000;
const SESSION_PRUNE_INTERVAL_MS = 600000;
const FAILED_LOGIN_DELAY_MS = 300;

/** Hard ceiling on how many accounts one password-only login attempt may scrypt-check. */
const MAX_PASSWORD_ONLY_CANDIDATES = 16;

const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Parse a Cookie header into a plain object. Never throws. */
function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || !header) return out;
  for (const piece of header.split(';')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const name = piece.slice(0, idx).trim();
    if (!name || name in out) continue;
    let value = piece.slice(idx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Append one Set-Cookie header without clobbering the ones already queued. */
function appendSetCookie(res, cookie) {
  if (res.headersSent) return;
  const existing = res.getHeader('set-cookie');
  if (!existing) res.setHeader('set-cookie', [cookie]);
  else if (Array.isArray(existing)) res.setHeader('set-cookie', existing.concat(cookie));
  else res.setHeader('set-cookie', [String(existing), cookie]);
}

function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`, 'Path=/'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.expires) parts.push(`Expires=${new Date(opts.expires).toUTCString()}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  // Deliberately no Domain attribute: a host-only cookie for the ts.net name and nothing else.
  return parts.join('; ');
}

/** Constant-time comparison of two short strings that may differ in length. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Only a single leading slash, no scheme, no protocol-relative "//evil.com". */
function safeNextPath(value) {
  if (typeof value !== 'string' || !value) return '/';
  if (!/^\/(?!\/)/.test(value)) return '/';
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return '/';
  if (value.length > 512) return '/';
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// ---------------------------------------------------------------------------
// Sliding-window failure counters
// ---------------------------------------------------------------------------

class SlidingWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.map = new Map(); // key -> { times: number[], lockedUntil: number }
  }

  _entry(key) {
    let e = this.map.get(key);
    if (!e) {
      e = { times: [], lockedUntil: 0 };
      this.map.set(key, e);
    }
    return e;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, e] of this.map) {
      e.times = e.times.filter((t) => t > cutoff);
      if (e.times.length === 0 && e.lockedUntil <= now) this.map.delete(key);
    }
  }

  /** @returns {number} milliseconds remaining on an active lock, or 0. */
  lockedFor(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) return 0;
    return e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  count(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) return 0;
    const cutoff = now - this.windowMs;
    e.times = e.times.filter((t) => t > cutoff);
    return e.times.length;
  }

  /** Record a failure. Locks the key when `limit` is reached. @returns the new count. */
  fail(key, limit, lockMs, now = Date.now()) {
    const e = this._entry(key);
    const cutoff = now - this.windowMs;
    e.times = e.times.filter((t) => t > cutoff);
    e.times.push(now);
    if (e.times.length >= limit) e.lockedUntil = Math.max(e.lockedUntil, now + lockMs);
    return e.times.length;
  }

  clear(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Account file / env parsing
// ---------------------------------------------------------------------------

/**
 * ADMIN_PASSWORD_HASHES format (one account per line, or per ";"):
 *
 *     username|Display Name|rosterPeerId|scrypt$N=32768,r=8,p=1$<salt>$<hash>
 *     username|scrypt$N=...$...$...                       (short form)
 *
 * The short form takes its display name from the username and its roster peer from
 * ADMIN_DEFAULT_PEER_ID. "|" is used as the separator precisely because it can never occur
 * inside a base64url hash or inside the scrypt parameter block.
 */
function parseAccountsEnv(raw, defaultPeerId) {
  const out = [];
  const errors = [];
  const text = String(raw || '').trim();
  if (!text) return { accounts: out, errors };

  const entries = text
    .split(/[\r\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  for (const entry of entries) {
    const fields = entry.split('|').map((s) => s.trim());
    let username;
    let displayName;
    let peerId;
    let passwordHash;
    if (fields.length >= 4) {
      [username, displayName, peerId, passwordHash] = fields;
    } else if (fields.length === 2) {
      [username, passwordHash] = fields;
      displayName = username;
      peerId = defaultPeerId;
    } else {
      errors.push(`unparseable ADMIN_PASSWORD_HASHES entry (expected 4 fields or 2, got ${fields.length})`);
      continue;
    }
    out.push({ username, displayName, peerId, passwordHash, disabled: false, source: 'env' });
  }
  return { accounts: out, errors };
}

function normaliseAccount(raw, source, defaultPeerId) {
  if (!raw || typeof raw !== 'object') throw new Error('account entry is not an object');
  const username = String(raw.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error(`account has an invalid "username" (expected ${USERNAME_RE})`);
  }
  const passwordHash = String(raw.passwordHash || '').trim();
  if (!isValidHash(passwordHash)) {
    throw new Error(`account "${username}" has a missing or malformed "passwordHash"`);
  }
  const peerId = String(raw.peerId || defaultPeerId || '').trim();
  if (!peerId) throw new Error(`account "${username}" has no "peerId"`);
  const displayName = String(raw.displayName || '').trim() || username;
  return {
    username,
    displayName,
    peerId,
    passwordHash,
    disabled: raw.disabled === true,
    source,
  };
}

// ---------------------------------------------------------------------------
// The auth service
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {(msg:string, f?:object)=>void} deps.logInfo
 * @param {(msg:string, f?:object)=>void} deps.logWarn
 * @param {(msg:string, f?:object)=>void} deps.logError
 * @param {(id:string)=>object|undefined} deps.getRosterPeer
 * @param {(req:import('node:http').IncomingMessage, limit?:number)=>Promise<object>} deps.readJsonBody
 */
function createAuth(deps) {
  const { config, logInfo, logWarn, logError, getRosterPeer, readJsonBody } = deps;

  const sessionTtlMs = Math.max(3600, config.sessionTtlSeconds) * 1000;
  const lockoutMs = Math.max(30, config.loginLockoutSeconds) * 1000;

  /** @type {Map<string, {sid:string, username:string, displayName:string, peerId:string, createdAt:number, expiresAt:number, lastSeenAt:number, label:string, csrf:string}>} */
  const sessions = new Map();

  /** @type {Map<string, {username:string, displayName:string, peerId:string, passwordHash:string, disabled:boolean, source:string}>} */
  let accounts = new Map();
  let accountsLoadedAt = null;
  let accountsMtimeMs = 0;

  const userFailures = new SlidingWindow(lockoutMs);
  const sourceFailures = new SlidingWindow(lockoutMs);
  const globalFailures = new SlidingWindow(lockoutMs);

  let sessionsDirty = false;
  let persistTimer = null;
  let pruneTimer = null;
  let accountsTimer = null;

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  function loadAccounts({ initial = false } = {}) {
    const next = new Map();
    const problems = [];

    // 1. Environment-supplied accounts (lowest precedence).
    const fromEnv = parseAccountsEnv(config.adminPasswordHashes, config.adminDefaultPeerId);
    for (const err of fromEnv.errors) problems.push(err);
    for (const raw of fromEnv.accounts) {
      try {
        const acct = normaliseAccount(raw, 'env', config.adminDefaultPeerId);
        next.set(acct.username, acct);
      } catch (err) {
        problems.push(String((err && err.message) || err));
      }
    }

    // 2. admins.json (highest precedence, hot-reloaded).
    let fileMtimeMs = 0;
    if (config.adminsPath) {
      try {
        const stat = fs.statSync(config.adminsPath);
        fileMtimeMs = stat.mtimeMs;
        const doc = JSON.parse(fs.readFileSync(config.adminsPath, 'utf8'));
        const list = Array.isArray(doc) ? doc : doc && doc.accounts;
        if (!Array.isArray(list)) {
          throw new Error('admins file must be an array or an object with an "accounts" array');
        }
        const seen = new Set();
        for (const raw of list) {
          const acct = normaliseAccount(raw, 'file', config.adminDefaultPeerId);
          if (seen.has(acct.username)) throw new Error(`duplicate account username: ${acct.username}`);
          seen.add(acct.username);
          next.set(acct.username, acct);
        }
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          if (initial) {
            logWarn('auth.admins_file_missing', {
              path: config.adminsPath,
              detail: 'falling back to ADMIN_PASSWORD_HASHES only',
            });
          }
        } else {
          const message = String((err && err.message) || err);
          if (initial) {
            logError('auth.admins_file_invalid', { path: config.adminsPath, error: message });
          } else {
            logError('auth.admins_reload_failed_keeping_previous', {
              path: config.adminsPath,
              error: message,
            });
            return false; // keep the previous good copy
          }
          problems.push(message);
        }
      }
    }

    for (const problem of problems) logWarn('auth.account_rejected', { error: problem });

    // Warn (do not fail) about accounts bound to a roster peer that does not exist or is not a
    // family peer. The roster is hot-reloadable too, so this can be transient.
    const peerOwners = new Map();
    for (const acct of next.values()) {
      const peer = getRosterPeer(acct.peerId);
      if (!peer) {
        logWarn('auth.account_peer_unknown', { username: acct.username, peerId: acct.peerId });
      } else if (peer.kind !== 'family') {
        logWarn('auth.account_peer_wrong_kind', {
          username: acct.username,
          peerId: acct.peerId,
          kind: peer.kind,
        });
      }
      if (!acct.disabled) {
        if (!peerOwners.has(acct.peerId)) peerOwners.set(acct.peerId, []);
        peerOwners.get(acct.peerId).push(acct.username);
      }
    }
    // Two enabled accounts on one roster peer is a configuration trap, not a feature: the
    // signalling server keeps exactly one socket per peer id and closes the older one when a
    // second registers. Both phones then knock each other offline in a reconnect loop and
    // neither can be rung. Loud, because the symptom ("calls just never work for ion") gives
    // no hint at the cause.
    for (const [peerId, usernames] of peerOwners) {
      if (usernames.length > 1) {
        logError('auth.accounts_share_peer_id', {
          peerId,
          usernames,
          detail: 'give each account its own roster peer; one live WebSocket exists per peer id, '
            + 'so these accounts will repeatedly disconnect each other and cannot be called',
        });
      }
    }

    accounts = next;
    accountsLoadedAt = new Date().toISOString();
    accountsMtimeMs = fileMtimeMs;

    // Disabled or removed accounts lose every live session immediately. This is the
    // "my phone was stolen" procedure and it must not need a restart.
    let dropped = 0;
    for (const [sid, session] of sessions) {
      const acct = accounts.get(session.username);
      if (!acct || acct.disabled) {
        sessions.delete(sid);
        dropped++;
      }
    }
    if (dropped) {
      sessionsDirty = true;
      logInfo('auth.sessions_dropped_on_reload', { count: dropped });
    }

    logInfo('auth.accounts_loaded', {
      count: accounts.size,
      enabled: [...accounts.values()].filter((a) => !a.disabled).length,
      fromFile: [...accounts.values()].filter((a) => a.source === 'file').length,
      fromEnv: [...accounts.values()].filter((a) => a.source === 'env').length,
      initial,
    });
    return true;
  }

  function startAccountsWatcher() {
    if (!config.adminsPath || config.accountsReloadMs <= 0) return;
    accountsTimer = setInterval(() => {
      try {
        const stat = fs.statSync(config.adminsPath);
        if (stat.mtimeMs !== accountsMtimeMs) loadAccounts();
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          logWarn('auth.admins_stat_failed', { error: String((err && err.message) || err) });
        }
      }
    }, config.accountsReloadMs);
    if (typeof accountsTimer.unref === 'function') accountsTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Session store
  // -------------------------------------------------------------------------

  function signSid(sid) {
    return crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('base64url');
  }

  function signDevice(rosterId, authToken) {
    return crypto
      .createHmac('sha256', config.sessionSecret)
      .update(`device:${rosterId}:${authToken}`)
      .digest('base64url');
  }

  function sourceIpOf(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
    if (Array.isArray(xff) && xff.length) return String(xff[0]).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  /** An opaque, stable bucket key. Raw IPs never reach a log line (ARCHITECTURE §2.3). */
  function sourceKeyOf(req) {
    return crypto
      .createHmac('sha256', config.sessionSecret)
      .update(sourceIpOf(req))
      .digest('base64url')
      .slice(0, 16);
  }

  function loadSessions() {
    if (!config.sessionStorePath) return;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(config.sessionStorePath, 'utf8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        logWarn('auth.session_store_unreadable', {
          path: config.sessionStorePath,
          error: String((err && err.message) || err),
          detail: 'starting with an empty session store; everyone must log in again',
        });
      }
      return;
    }
    const list = (doc && Array.isArray(doc.sessions) && doc.sessions) || [];
    const now = Date.now();
    let restored = 0;
    for (const s of list) {
      if (!s || typeof s.sid !== 'string' || typeof s.username !== 'string') continue;
      if (!Number.isFinite(s.expiresAt) || s.expiresAt <= now) continue;
      sessions.set(s.sid, {
        sid: s.sid,
        username: s.username,
        displayName: String(s.displayName || s.username),
        peerId: String(s.peerId || ''),
        createdAt: Number(s.createdAt) || now,
        expiresAt: Number(s.expiresAt),
        lastSeenAt: Number(s.lastSeenAt) || now,
        label: String(s.label || '').slice(0, 64),
        csrf: typeof s.csrf === 'string' && s.csrf ? s.csrf : crypto.randomBytes(16).toString('base64url'),
      });
      restored++;
    }
    logInfo('auth.sessions_restored', { count: restored, path: config.sessionStorePath });
  }

  async function persistSessions({ force = false } = {}) {
    if (!config.sessionStorePath) return;
    if (!sessionsDirty && !force) return;
    sessionsDirty = false;
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      sessions: [...sessions.values()],
    });
    const tmp = `${config.sessionStorePath}.tmp`;
    let handle = null;
    try {
      await fsp.mkdir(path.dirname(config.sessionStorePath), { recursive: true });
      handle = await fsp.open(tmp, 'w', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmp, config.sessionStorePath);
      await fsp.chmod(config.sessionStorePath, 0o600).catch(() => {});
    } catch (err) {
      sessionsDirty = true;
      logError('auth.session_persist_failed', {
        path: config.sessionStorePath,
        error: String((err && err.message) || err),
      });
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  function persistSessionsSync() {
    if (!config.sessionStorePath) return;
    try {
      fs.mkdirSync(path.dirname(config.sessionStorePath), { recursive: true });
      const tmp = `${config.sessionStorePath}.tmp`;
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sessions: [...sessions.values()],
      });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, config.sessionStorePath);
      sessionsDirty = false;
    } catch (err) {
      logError('auth.session_persist_sync_failed', { error: String((err && err.message) || err) });
    }
  }

  function pruneSessions() {
    const now = Date.now();
    let removed = 0;
    for (const [sid, s] of sessions) {
      if (s.expiresAt <= now) {
        sessions.delete(sid);
        removed++;
      }
    }
    if (removed) {
      sessionsDirty = true;
      logInfo('auth.sessions_pruned', { removed, remaining: sessions.size });
    }
    userFailures.prune(now);
    sourceFailures.prune(now);
    globalFailures.prune(now);
  }

  function createSession(account, label) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session = {
      sid,
      username: account.username,
      displayName: account.displayName,
      peerId: account.peerId,
      createdAt: now,
      expiresAt: now + sessionTtlMs,
      lastSeenAt: now,
      label: String(label || '').slice(0, 64),
      csrf: crypto.randomBytes(16).toString('base64url'),
    };
    sessions.set(sid, session);
    sessionsDirty = true;
    return session;
  }

  function setSessionCookies(res, session) {
    const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    appendSetCookie(res, buildCookie(COOKIE_SESSION, `${session.sid}.${signSid(session.sid)}`, {
      maxAge,
      httpOnly: true,
      secure: config.cookieSecure,
    }));
    // Deliberately readable by JavaScript: this is the double-submit CSRF token.
    appendSetCookie(res, buildCookie(COOKIE_CSRF, session.csrf, {
      maxAge,
      httpOnly: false,
      secure: config.cookieSecure,
    }));
  }

  function clearSessionCookies(res) {
    appendSetCookie(res, buildCookie(COOKIE_SESSION, '', { maxAge: 0, httpOnly: true, secure: config.cookieSecure }));
    appendSetCookie(res, buildCookie(COOKIE_CSRF, '', { maxAge: 0, httpOnly: false, secure: config.cookieSecure }));
  }

  /** Validate a `<sid>.<hmac>` cookie without touching the session map on garbage input. */
  function sessionFromCookie(value) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 200) return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const sid = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(sid) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac)) return null;
    let expected;
    try {
      expected = signSid(sid);
    } catch {
      return null;
    }
    if (!safeEqual(mac, expected)) return null;
    const session = sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sid);
      sessionsDirty = true;
      return null;
    }
    return session;
  }

  /** Validate a `<rosterId>.<hmac>` device cookie against the live roster. */
  function deviceFromCookie(value) {
    if (typeof value !== 'string' || value.length < 5 || value.length > 300) return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const rosterId = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(rosterId)) return null;
    const peer = getRosterPeer(rosterId);
    if (!peer) return null;
    let expected;
    try {
      expected = signDevice(rosterId, peer.authToken);
    } catch {
      return null;
    }
    if (!safeEqual(mac, expected)) return null;
    return peer;
  }

  function setDeviceCookie(res, peer) {
    appendSetCookie(res, buildCookie(COOKIE_DEVICE, `${peer.id}.${signDevice(peer.id, peer.authToken)}`, {
      maxAge: DEVICE_COOKIE_MAX_AGE,
      httpOnly: true,
      secure: config.cookieSecure,
    }));
  }

  // -------------------------------------------------------------------------
  // Request authentication
  // -------------------------------------------------------------------------

  const ANONYMOUS = Object.freeze({ type: 'anonymous' });

  function controlAuthorised(req) {
    if (!config.controlToken) return false;
    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!m) return false;
    return safeEqual(m[1].trim(), config.controlToken);
  }

  /**
   * Resolve the principal behind a request, refreshing the session cookie and minting the device
   * cookie as side effects. Never throws.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  function authenticate(req, res, url) {
    try {
      if (controlAuthorised(req)) return { type: 'control', id: 'control-api', displayName: 'control' };

      const cookies = parseCookies(req.headers.cookie);

      const session = sessionFromCookie(cookies[COOKIE_SESSION]);
      if (session) {
        const account = accounts.get(session.username);
        if (account && !account.disabled) {
          const now = Date.now();
          session.lastSeenAt = now;
          // Sliding expiry: refresh at most once a day so we are not re-issuing a cookie on
          // every single request.
          if (session.expiresAt - now < sessionTtlMs - 86400000) {
            session.expiresAt = now + sessionTtlMs;
            sessionsDirty = true;
            setSessionCookies(res, session);
          } else if (!cookies[COOKIE_CSRF]) {
            // The CSRF cookie is not HttpOnly and can be lost independently; re-issue it.
            setSessionCookies(res, session);
          }
          return {
            type: 'admin',
            id: session.peerId,
            username: session.username,
            displayName: session.displayName || account.displayName,
            peerId: session.peerId,
            session,
            account,
          };
        }
        // Account vanished or was disabled between reloads.
        sessions.delete(session.sid);
        sessionsDirty = true;
      }

      // The tablet bootstrap: ?device=<rosterId>&token=<authToken> on ANY path. Accepting it
      // everywhere (not only on "/") means a kiosk that lost its cookie can be repaired by
      // re-opening the provisioning URL, and that a bare asset request with the pair attached
      // still works. The pair is never logged.
      if (url && url.searchParams) {
        const deviceId = String(url.searchParams.get('device') || '').trim();
        const deviceToken = String(url.searchParams.get('token') || '').trim();
        if (deviceId && deviceToken) {
          const peer = getRosterPeer(deviceId);
          if (peer && safeEqual(deviceToken, peer.authToken)) {
            setDeviceCookie(res, peer);
            return { type: 'device', id: peer.id, displayName: peer.displayName, peer };
          }
          logWarn('auth.device_query_rejected', {
            device: deviceId || null,
            reason: peer ? 'bad-token' : 'unknown-device',
            sourceKey: sourceKeyOf(req),
          });
        }
      }

      const devicePeer = deviceFromCookie(cookies[COOKIE_DEVICE]);
      if (devicePeer) {
        return { type: 'device', id: devicePeer.id, displayName: devicePeer.displayName, peer: devicePeer };
      }

      return ANONYMOUS;
    } catch (err) {
      logError('auth.authenticate_threw', { error: String((err && err.stack) || err) });
      return ANONYMOUS;
    }
  }

  /**
   * Cookie-only authentication for the WebSocket upgrade, where there is no ServerResponse to
   * attach Set-Cookie to. Returns { account } or { device } or {}.
   */
  function authenticateUpgrade(req) {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const session = sessionFromCookie(cookies[COOKIE_SESSION]);
      if (session) {
        const account = accounts.get(session.username);
        if (account && !account.disabled) {
          session.lastSeenAt = Date.now();
          return { account: { username: session.username, displayName: session.displayName, peerId: session.peerId } };
        }
      }
      const devicePeer = deviceFromCookie(cookies[COOKIE_DEVICE]);
      if (devicePeer) return { device: devicePeer.id };
      return {};
    } catch (err) {
      logError('auth.upgrade_auth_threw', { error: String((err && err.stack) || err) });
      return {};
    }
  }

  /**
   * Mandatory Origin check on the WebSocket upgrade (cross-site WebSocket hijacking).
   *
   * `hostHeader` is the request's own Host header. It matters: if PUBLIC_ORIGIN is not
   * configured, comparing against the configured list alone rejects EVERY browser, because
   * browsers always send an Origin on a WebSocket handshake. That turns a forgotten .env line
   * into "video calls never connect and nothing in the UI says why". Falling back to a
   * same-host comparison keeps the security property (a third-party page still cannot open an
   * authenticated socket, because its Origin host is not our Host) while staying usable.
   *
   * @param {string|undefined} originHeader
   * @param {string|undefined} hostHeader
   */
  function originAllowed(originHeader, hostHeader) {
    // Non-browser clients (the watchdog, curl) send no Origin. They are still gated by the
    // cookie or by the register message.
    if (originHeader === undefined || originHeader === null || originHeader === '') return true;
    const origin = String(originHeader).trim();
    if (config.publicOrigin && origin === config.publicOrigin) return true;
    if (config.extraAllowedOrigins.includes(origin)) return true;

    const host = String(hostHeader || '').trim().toLowerCase();
    if (!host) return false;
    let originHost;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      originHost = parsed.host.toLowerCase();
    } catch {
      return false;
    }
    return originHost === host;
  }

  // -------------------------------------------------------------------------
  // CSRF
  // -------------------------------------------------------------------------

  /**
   * Double-submit check for every state-changing cookie-authenticated request.
   * `SameSite=Lax` already blocks the realistic case; this covers the corners.
   */
  function csrfOk(req, principal) {
    if (!principal || principal.type !== 'admin') return true; // bearer / device principals are exempt
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const header = req.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) return false;
    const cookies = parseCookies(req.headers.cookie);
    const cookieValue = cookies[COOKIE_CSRF];
    if (!cookieValue) return false;
    if (!safeEqual(String(provided), String(cookieValue))) return false;
    // Bind it to the session too, so a stale cookie from another login cannot be replayed.
    return safeEqual(String(provided), principal.session.csrf);
  }

  // -------------------------------------------------------------------------
  // Security headers
  // -------------------------------------------------------------------------

  const connectSrc = (() => {
    const list = ["'self'"];
    const add = (origin) => {
      if (!origin) return;
      list.push(origin);
      if (origin.startsWith('https://')) list.push('wss://' + origin.slice('https://'.length));
      else if (origin.startsWith('http://')) list.push('ws://' + origin.slice('http://'.length));
    };
    add(config.publicOrigin);
    for (const o of config.extraAllowedOrigins) add(o);
    return [...new Set(list)].join(' ');
  })();

  const CSP = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${connectSrc}`,
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  function applySecurityHeaders(res) {
    if (res.headersSent) return;
    res.setHeader('strict-transport-security', 'max-age=31536000');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    res.setHeader('content-security-policy', CSP);
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  function sendJson(res, status, body, extraHeaders) {
    const payload = JSON.stringify(body);
    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        ...(extraHeaders || {}),
      });
    }
    res.end(payload);
  }

  function accountCandidates(username) {
    if (username) {
      const acct = accounts.get(username);
      return acct && !acct.disabled ? [acct] : [];
    }
    // Password-only login (the parents just type the family password). Bounded work: at most
    // MAX_PASSWORD_ONLY_CANDIDATES scrypt calls, and the endpoint is rate-limited hard.
    return [...accounts.values()].filter((a) => !a.disabled).slice(0, MAX_PASSWORD_ONLY_CANDIDATES);
  }

  /**
   * POST /api/auth/login   (alias: POST /api/login)
   * Body: { "password": "...", "username": "ana" (optional), "label": "Ana's iPhone" }
   */
  async function handleLogin(req, res) {
    if (String(req.method).toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
      return;
    }
    const contentType = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(contentType)) {
      sendJson(res, 415, { error: 'unsupported-media-type', detail: 'send application/json' });
      return;
    }

    const sourceKey = sourceKeyOf(req);
    const now = Date.now();

    // Global "we are being scanned" backstop.
    if (globalFailures.lockedFor('*', now)) {
      logWarn('auth.global_lockout', { sourceKey });
      sendJson(res, 429, { error: 'rate-limited', detail: 'too many failed logins' }, {
        'retry-after': String(config.loginLockoutSeconds),
      });
      return;
    }
    if (sourceFailures.lockedFor(sourceKey, now)) {
      logWarn('auth.login', { username: null, outcome: 'rate-limited', sourceKey });
      sendJson(res, 429, { error: 'rate-limited', detail: 'too many failed logins' }, {
        'retry-after': String(config.loginLockoutSeconds),
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, 1024);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: 'bad-body', detail: String((err && err.message) || err) });
      return;
    }

    const usernameRaw = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const username = USERNAME_RE.test(usernameRaw) ? usernameRaw : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const label = typeof body.label === 'string' ? body.label.slice(0, 64) : '';

    if (!password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      await noteFailure(username, sourceKey, 'invalid-credentials');
      sendJson(res, 401, { error: 'invalid-credentials' });
      return;
    }
    if (usernameRaw && !username) {
      // Syntactically impossible username: same generic answer, still counted.
      await noteFailure('', sourceKey, 'unknown-user');
      sendJson(res, 401, { error: 'invalid-credentials' });
      return;
    }

    if (username && userFailures.lockedFor(username, now)) {
      logWarn('auth.login', { username, outcome: 'locked-out', sourceKey });
      sendJson(res, 429, { error: 'rate-limited', detail: 'too many failed logins for this account' }, {
        'retry-after': String(config.loginLockoutSeconds),
      });
      return;
    }

    const candidates = accountCandidates(username);
    if (candidates.length === 0) {
      await noteFailure(username, sourceKey, username ? 'unknown-user' : 'no-accounts-configured');
      sendJson(res, 401, { error: 'invalid-credentials' });
      return;
    }

    let matched = null;
    for (const acct of candidates) {
      // Do not short-circuit a locked account into a success when the caller omitted the
      // username: a locked username stays locked no matter which door it is tried through.
      if (userFailures.lockedFor(acct.username, now)) continue;
      // eslint-disable-next-line no-await-in-loop
      const ok = await verifyPassword(password, acct.passwordHash);
      if (ok) {
        matched = acct;
        break;
      }
    }

    if (!matched) {
      await noteFailure(username, sourceKey, 'bad-password');
      sendJson(res, 401, { error: 'invalid-credentials' });
      return;
    }

    userFailures.clear(matched.username);
    const session = createSession(matched, label);
    setSessionCookies(res, session);
    logInfo('auth.login', { username: matched.username, outcome: 'ok', sourceKey });

    sendJson(res, 200, {
      authenticated: true,
      username: matched.username,
      displayName: matched.displayName,
      peerId: matched.peerId,
      csrfToken: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  async function noteFailure(username, sourceKey, outcome) {
    const now = Date.now();
    if (username) userFailures.fail(username, config.loginMaxFailures, lockoutMs, now);
    sourceFailures.fail(sourceKey, config.loginMaxFailuresPerSource, lockoutMs, now);
    const globalCount = globalFailures.fail('*', config.loginMaxFailuresGlobal, lockoutMs, now);
    if (globalCount >= config.loginMaxFailuresGlobal) {
      logError('auth.global_lockout', { failures: globalCount, sourceKey });
    }
    logWarn('auth.login', { username: username || null, outcome, sourceKey });
    // Constant extra delay AFTER the scrypt work, so response time says nothing about whether
    // the username exists.
    await sleep(FAILED_LOGIN_DELAY_MS);
  }

  /** POST /api/auth/logout  (alias: POST /api/logout) */
  function handleLogout(req, res, principal) {
    if (String(req.method).toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
      return;
    }
    if (principal && principal.type === 'admin') {
      sessions.delete(principal.session.sid);
      sessionsDirty = true;
      logInfo('auth.logout', { username: principal.username, scope: 'one' });
    }
    clearSessionCookies(res);
    sendJson(res, 200, { authenticated: false });
  }

  /** POST /api/auth/logout-all — kills every session belonging to the calling username. */
  function handleLogoutAll(req, res, principal) {
    if (String(req.method).toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
      return;
    }
    if (principal && principal.type === 'admin') {
      let removed = 0;
      for (const [sid, s] of sessions) {
        if (s.username === principal.username) {
          sessions.delete(sid);
          removed++;
        }
      }
      sessionsDirty = true;
      logInfo('auth.logout', { username: principal.username, scope: 'all', removed });
    }
    clearSessionCookies(res);
    sendJson(res, 200, { authenticated: false });
  }

  /** GET /api/auth/session  (alias: GET /api/session) — public, never 401s. */
  function handleSession(req, res, principal) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (principal && principal.type === 'admin') {
      sendJson(res, 200, {
        authenticated: true,
        kind: 'admin',
        username: principal.username,
        displayName: principal.displayName,
        peerId: principal.peerId,
        csrfToken: principal.session.csrf,
        expiresAt: new Date(principal.session.expiresAt).toISOString(),
      });
      return;
    }
    if (principal && principal.type === 'device') {
      sendJson(res, 200, {
        authenticated: true,
        kind: 'device',
        deviceId: principal.id,
        displayName: principal.displayName,
      });
      return;
    }
    if (principal && principal.type === 'control') {
      sendJson(res, 200, { authenticated: true, kind: 'control' });
      return;
    }
    // The account list is NOT published by default. It would let an unauthenticated scanner
    // enumerate "ana / ion / maria", which buys an attacker the username half of the
    // credential for free. Set LOGIN_SHOW_ACCOUNTS=true only if the login page needs a picker;
    // password-only login (no username at all) works either way.
    sendJson(res, 200, {
      authenticated: false,
      loginRequired: true,
      usernameOptional: true,
      ...(config.loginShowAccounts
        ? {
          accounts: [...accounts.values()]
            .filter((a) => !a.disabled)
            .map((a) => ({ username: a.username, displayName: a.displayName })),
        }
        : {}),
    });
  }

  // NOTE: ICE / TURN credentials are NOT minted here. `ice.js` owns that end to end and is
  // wired up in server.js at `/api/ice` and `/api/turn-credentials`. This module's only job in
  // that flow is to publish the resolved principal on the request object (`req.frameoPrincipal`)
  // so ice.js can decide between the tailnet and the public ICE server list. Two implementations
  // of the same HMAC would be one too many.

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function start() {
    loadSessions();
    loadAccounts({ initial: true });
    startAccountsWatcher();
    pruneSessions();
    persistTimer = setInterval(() => {
      persistSessions().catch(() => {});
    }, SESSION_PERSIST_INTERVAL_MS);
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
    pruneTimer = setInterval(pruneSessions, SESSION_PRUNE_INTERVAL_MS);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  }

  function stop() {
    if (persistTimer) clearInterval(persistTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    if (accountsTimer) clearInterval(accountsTimer);
    persistSessionsSync();
  }

  function stats() {
    return {
      accounts: accounts.size,
      accountsEnabled: [...accounts.values()].filter((a) => !a.disabled).length,
      accountsLoadedAt,
      sessions: sessions.size,
      lockedUsernames: [...userFailures.map.entries()].filter(([, e]) => e.lockedUntil > Date.now()).length,
      lockedSources: [...sourceFailures.map.entries()].filter(([, e]) => e.lockedUntil > Date.now()).length,
      sessionStorePath: config.sessionStorePath,
      adminsPath: config.adminsPath,
    };
  }

  return {
    // lifecycle
    start,
    stop,
    loadAccounts,
    persistSessions,
    stats,
    // request-time
    authenticate,
    authenticateUpgrade,
    originAllowed,
    csrfOk,
    applySecurityHeaders,
    safeNextPath,
    sourceKeyOf,
    // endpoints
    handleLogin,
    handleLogout,
    handleLogoutAll,
    handleSession,
    // constants, exported so server.js never re-spells them
    COOKIE_SESSION,
    COOKIE_CSRF,
    COOKIE_DEVICE,
    CSRF_HEADER,
  };
}

module.exports = { createAuth, parseCookies, safeNextPath, USERNAME_RE };
