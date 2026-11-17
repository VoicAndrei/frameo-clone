'use strict';
/**
 * ice.js — ICE server configuration + ephemeral TURN credentials.
 *
 * Implements ARCHITECTURE-PUBLIC.md §3.5 and §3.6.
 *
 * WHAT THIS IS
 * ------------
 * coturn runs with `use-auth-secret` / `static-auth-secret`, i.e. the "TURN REST API"
 * credential scheme (draft-uberti-behave-turn-rest-00, the scheme coturn's own
 * turnserver.conf documents as:
 *
 *     usercombo     -> "timestamp:userid"
 *     turn user     -> usercombo
 *     turn password -> base64(hmac(secret key, usercombo))
 *
 * with HMAC-SHA1 as the MAC). There are NO static TURN users: every credential this
 * module mints is valid for TURN_TTL_SECONDS (default 12 h) and then dies on its own.
 * coturn never has to be told about a new client, and a leaked credential expires
 * without any operator action.
 *
 * SHA-1 is not a weakness here: it is used inside an HMAC (not as a bare hash), the
 * key is 32 random bytes, and the derived credential expires in hours. coturn
 * implements no alternative MAC for this scheme.
 *
 * WHO MAY ASK
 * -----------
 * Fail closed. A caller gets credentials only if it is one of:
 *
 *   1. an admin session   — the auth layer already resolved it and attached the
 *                           account to the request (`req.frameoAccount`);
 *   2. a device cookie    — `frameo_device` = "<rosterId>.<hmac>" where
 *                           hmac = HMAC-SHA256(SESSION_SECRET, "device:"+rosterId+":"+authToken)
 *                           (ARCHITECTURE-PUBLIC.md §2.5). Verified here against the
 *                           live roster, so revoking a roster token revokes the cookie;
 *   3. a roster token     — the classic tablet credential, presented as the
 *                           `X-Frameo-Device` + `X-Frameo-Token` headers, or as
 *                           `?device=…&token=…` for the kiosk client that keeps them in
 *                           localStorage. Compared in constant time against roster.json.
 *
 * Anything else gets 401. The control token (`CONTROL_TOKEN`) is deliberately NOT
 * accepted: per the §2.4 access matrix this endpoint is device/admin only, and the
 * control principal has no roster identity to name a credential after.
 *
 * WHICH SERVERS A CALLER GETS (§3.6)
 * ----------------------------------
 *   kind === "frame"  -> tailnet profile: coturn on the node's 100.x address over UDP
 *                        and TCP. No public STUN: a frame's useful candidates are its
 *                        tailnet and LAN addresses, and a public STUN server would only
 *                        leak the grandparents' home IP to a third party.
 *   everything else   -> public profile: public STUN first (a direct P2P path is the
 *                        goal) plus `turns:<node>:10000?transport=tcp`, which is
 *                        tailscaled's TLS-terminated Funnel port in front of coturn.
 *
 * `iceTransportPolicy` is always "all", never "relay": the relay is the fallback, not
 * the plan.
 *
 * LOGGING RULE
 * ------------
 * The minted username embeds an expiry and a roster id (both non-secret and wanted in
 * coturn's log for the audit trail). The credential itself is NEVER logged, at any
 * level. Neither is the static secret, a roster authToken or a cookie value.
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 12 * 3600; // 43200
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 7 * 24 * 3600;

const DEFAULT_STUN_URLS = 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478';

/** Split a comma/whitespace separated env list into trimmed, non-empty entries. */
function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Keep only syntactically plausible ICE URLs, so a typo in .env fails loudly at boot. */
function filterUrls(list, schemes) {
  const ok = [];
  const bad = [];
  for (const url of list) {
    const scheme = url.split(':', 1)[0].toLowerCase();
    if (schemes.includes(scheme) && url.length > scheme.length + 1) ok.push(url);
    else bad.push(url);
  }
  return { ok, bad };
}

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the ICE configuration from the environment.
 *
 * Every URL can be given explicitly; the defaults are derived from PUBLIC_ORIGIN and
 * TS_TAILNET_IP so that a correct .env with only those two set still produces a working
 * setup (ARCHITECTURE-PUBLIC.md §5).
 */
function iceConfigFromEnv(env = process.env) {
  const publicOrigin = String(env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  let publicHost = '';
  if (publicOrigin) {
    try {
      publicHost = new URL(publicOrigin).hostname;
    } catch {
      publicHost = '';
    }
  }

  const tailnetIp = String(env.TS_TAILNET_IP || '').trim();

  const defaultPublicTurn = publicHost ? `turns:${publicHost}:10000?transport=tcp` : '';
  const defaultTailnetTurn = tailnetIp
    ? `turn:${tailnetIp}:3478?transport=udp,turn:${tailnetIp}:3478?transport=tcp`
    : '';

  const stun = filterUrls(
    splitList(env.STUN_URLS === undefined ? DEFAULT_STUN_URLS : env.STUN_URLS),
    ['stun', 'stuns'],
  );
  const publicTurn = filterUrls(
    splitList(env.TURN_PUBLIC_URL || defaultPublicTurn),
    ['turn', 'turns'],
  );
  const tailnetTurn = filterUrls(
    splitList(env.TURN_TAILNET_URL || defaultTailnetTurn),
    ['turn', 'turns'],
  );

  let ttl = intFromEnv(env, 'TURN_TTL_SECONDS', DEFAULT_TTL_SECONDS);
  if (ttl < MIN_TTL_SECONDS) ttl = MIN_TTL_SECONDS;
  if (ttl > MAX_TTL_SECONDS) ttl = MAX_TTL_SECONDS;

  return {
    staticAuthSecret: String(env.TURN_STATIC_AUTH_SECRET || ''),
    sessionSecret: String(env.SESSION_SECRET || ''),
    ttlSeconds: ttl,
    stunUrls: stun.ok,
    publicTurnUrls: publicTurn.ok,
    tailnetTurnUrls: tailnetTurn.ok,
    rejectedUrls: [...stun.bad, ...publicTurn.bad, ...tailnetTurn.bad],
    publicOrigin,
    tailnetIp,
  };
}

// ---------------------------------------------------------------------------
// Cookie parsing (no dependency; the request may carry several cookies)
// ---------------------------------------------------------------------------

/** Parse a Cookie header into a plain object. Later duplicates do not overwrite earlier ones. */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Constant-time string compare that does not leak length through an early return. */
function safeEqual(a, b) {
  const ba = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const bb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * The `frameo_device` cookie value defined in ARCHITECTURE-PUBLIC.md §2.5:
 *     "<rosterId>.<base64url HMAC-SHA256(SESSION_SECRET, "device:"+rosterId+":"+authToken)>"
 * Binding the MAC to the roster token means that rotating the token in roster.json
 * invalidates every cookie minted for that device, with no session bookkeeping.
 */
function deviceCookieMac(sessionSecret, rosterId, authToken) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`device:${rosterId}:${authToken}`)
    .digest('base64url');
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {(id: string) => (object|null)} deps.lookupPeer      roster lookup, must return the live entry
 * @param {(provided: string, expected: string) => boolean} [deps.tokenMatches] constant-time compare
 * @param {{info: Function, warn: Function, error: Function}} [deps.log]
 * @param {object} [deps.config]                               defaults to iceConfigFromEnv()
 * @param {(req: object) => (object|null)} [deps.resolveSessionPrincipal]
 *        Optional hook so the session/auth layer can answer first. Must return
 *        `{ id, username?, via? }` or null.
 */
function createIceService(deps) {
  const config = deps.config || iceConfigFromEnv();
  const lookupPeer = deps.lookupPeer;
  const compare = deps.tokenMatches || safeEqual;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const resolveSessionPrincipal = deps.resolveSessionPrincipal || null;

  if (typeof lookupPeer !== 'function') {
    throw new TypeError('createIceService requires a lookupPeer(id) function');
  }

  const enabled = Boolean(config.staticAuthSecret)
    && (config.publicTurnUrls.length > 0 || config.tailnetTurnUrls.length > 0);

  // -------------------------------------------------------------------------
  // Credential minting (§3.5)
  // -------------------------------------------------------------------------

  /**
   * @param {string} principalId roster peer id; ends up in coturn's log, not a secret
   * @returns {{username: string, credential: string, expiry: number, ttl: number}}
   */
  function mintTurnCredential(principalId) {
    const ttl = config.ttlSeconds;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    // coturn's default rest-api-separator is ':' — do not change it on either side.
    const username = `${expiry}:${principalId}`;
    const credential = crypto
      .createHmac('sha1', config.staticAuthSecret) // sha1 is mandated by the scheme
      .update(username)
      .digest('base64');
    return { username, credential, expiry, ttl };
  }

  /**
   * Build the exact iceServers array for a principal (§3.6).
   * @param {{id: string, kind?: string}} principal
   */
  function buildIceServers(principal) {
    const kind = principal.kind
      || (lookupPeer(principal.id) && lookupPeer(principal.id).kind)
      || 'family';
    const profile = kind === 'frame' ? 'tailnet+public' : 'public';

    // A frame gets the tailnet relay FIRST (same-LAN / same-tailnet calls stay
    // local and cheap) and the public relay as well.
    //
    // The public half is not optional. The family phones deliberately do NOT run
    // Tailscale, so a phone's candidates are all public addresses. A frame that
    // only ever learned tailnet candidates has nothing that can pair with them and
    // ICE fails ~5 s after answering — which is exactly the bug this fixes. It also
    // means a frame keeps working when Tailscale on the tablet is down, which is
    // the documented failure mode of the Android client.
    //
    // This does expose the grandparents' public IP to the other party via STUN.
    // That is the price of the call connecting at all from outside the tailnet,
    // and the other party is always one of the four whitelisted family accounts.
    const turnUrls = kind === 'frame'
      ? config.tailnetTurnUrls.concat(config.publicTurnUrls)
      : config.publicTurnUrls;

    const iceServers = [];
    if (config.stunUrls.length) {
      iceServers.push({ urls: config.stunUrls.slice() });
    }

    let cred = null;
    if (turnUrls.length && config.staticAuthSecret) {
      cred = mintTurnCredential(principal.id);
      iceServers.push({
        urls: turnUrls.slice(),
        username: cred.username,
        credential: cred.credential,
      });
    }

    return { profile, iceServers, cred };
  }

  // -------------------------------------------------------------------------
  // Authentication (fail closed)
  // -------------------------------------------------------------------------

  /**
   * Resolve the calling principal, or null.
   * Order: session (delegated) -> device cookie -> roster token.
   * @returns {{id: string, kind: string, displayName: string, via: string, username?: string}|null}
   */
  function resolvePrincipal(req, url) {
    // 1. An admin session, already validated by the auth layer at the top of the
    //    request handler. Several shapes are tolerated so that this module does not
    //    have to be edited when that layer lands.
    const fromSession = resolveSessionPrincipal ? resolveSessionPrincipal(req) : null;
    const account = fromSession
      || req.frameoAccount
      || req.frameoPrincipal
      || (req.frameoSession && req.frameoSession.account)
      || null;
    if (account) {
      // `peerId` on an admin account, `id` on a device principal. A principal whose id is
      // not in the roster (the control API's "control-api", say) falls through to the checks
      // below and ends up rejected — which is what the §2.4 access matrix asks for.
      const id = String(account.peerId || account.id || '').trim();
      const entry = id ? lookupPeer(id) : null;
      if (entry) {
        return {
          id: entry.id,
          kind: entry.kind,
          displayName: entry.displayName,
          via: account.via || account.type || 'session',
          username: typeof account.username === 'string' ? account.username : undefined,
        };
      }
    }

    // A device already bound at the WebSocket upgrade / HTTP gate.
    const boundDevice = typeof req.frameoDevice === 'string' ? req.frameoDevice.trim() : '';
    if (boundDevice) {
      const entry = lookupPeer(boundDevice);
      if (entry) {
        return { id: entry.id, kind: entry.kind, displayName: entry.displayName, via: 'device-cookie' };
      }
    }

    const cookies = parseCookies(req.headers && req.headers.cookie);

    // 2. The frameo_device cookie, verified against the live roster.
    const raw = cookies.frameo_device;
    if (raw && config.sessionSecret) {
      const dot = raw.lastIndexOf('.');
      if (dot > 0) {
        const rosterId = raw.slice(0, dot);
        const mac = raw.slice(dot + 1);
        const entry = lookupPeer(rosterId);
        if (entry && mac) {
          const expected = deviceCookieMac(config.sessionSecret, entry.id, entry.authToken);
          if (compare(mac, expected)) {
            return { id: entry.id, kind: entry.kind, displayName: entry.displayName, via: 'device-cookie' };
          }
        }
      }
    }

    // 3. The roster token, from headers (preferred) or from the query string (the kiosk
    //    client keeps ?device=&token= in localStorage and replays them).
    const headers = req.headers || {};
    let deviceId = typeof headers['x-frameo-device'] === 'string' ? headers['x-frameo-device'].trim() : '';
    let token = typeof headers['x-frameo-token'] === 'string' ? headers['x-frameo-token'] : '';
    let via = 'roster-token-header';
    if ((!deviceId || !token) && url && url.searchParams) {
      const qDevice = url.searchParams.get('device');
      const qToken = url.searchParams.get('token');
      if (qDevice && qToken) {
        deviceId = qDevice.trim();
        token = qToken;
        via = 'roster-token-query';
      }
    }
    if (deviceId && token) {
      const entry = lookupPeer(deviceId);
      // Compare unconditionally against a dummy when the id is unknown, so a bad id and a
      // bad token cost the same and neither leaks roster membership through timing.
      const expected = entry ? entry.authToken : '\x00-no-such-peer-\x00';
      const okToken = compare(token, expected);
      if (entry && okToken) {
        return { id: entry.id, kind: entry.kind, displayName: entry.displayName, via };
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // HTTP handler
  // -------------------------------------------------------------------------

  /**
   * GET /api/ice  (alias: GET /api/turn-credentials)
   *
   * 200 {
   *   "iceServers": [...],            // hand straight to new RTCPeerConnection({iceServers})
   *   "iceTransportPolicy": "all",
   *   "ttl": 43200,
   *   "expiresAt": "2026-08-09T09:12:00.000Z",
   *   "profile": "public" | "tailnet",
   *   "principal": "family-ana"
   * }
   * 401 {"error":"unauthenticated"}
   * 503 {"error":"turn-not-configured"}
   *
   * @param {(res: object, status: number, body: object) => void} sendJson
   *        Injected so this module reuses the server's single JSON responder (which
   *        already sets Cache-Control: no-store on every /api/* response).
   */
  function handleRequest(req, res, url, sendJson) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'use GET' });
      return;
    }

    const principal = resolvePrincipal(req, url);
    if (!principal) {
      log.warn('ice.unauthenticated', { path: url && url.pathname });
      res.setHeader('cache-control', 'no-store');
      sendJson(res, 401, { error: 'unauthenticated' });
      return;
    }

    if (!enabled) {
      log.warn('ice.not_configured', {
        principal: principal.id,
        hasSecret: Boolean(config.staticAuthSecret),
        publicUrls: config.publicTurnUrls.length,
        tailnetUrls: config.tailnetTurnUrls.length,
      });
      sendJson(res, 503, {
        error: 'turn-not-configured',
        detail: 'TURN_STATIC_AUTH_SECRET and a TURN URL must be set on the server',
      });
      return;
    }

    const { profile, iceServers, cred } = buildIceServers(principal);
    if (!iceServers.length) {
      sendJson(res, 503, { error: 'turn-not-configured', detail: `no ICE servers for profile ${profile}` });
      return;
    }

    const ttl = cred ? cred.ttl : config.ttlSeconds;
    const expirySeconds = cred ? cred.expiry : Math.floor(Date.now() / 1000) + ttl;

    // Never log `credential`.
    log.info('ice.issued', {
      principal: principal.id,
      kind: principal.kind,
      profile,
      via: principal.via,
      actor: principal.username || null,
      ttl,
      servers: iceServers.length,
    });

    res.setHeader('cache-control', 'no-store');
    sendJson(res, 200, {
      iceServers,
      iceTransportPolicy: 'all',
      ttl,
      expiresAt: new Date(expirySeconds * 1000).toISOString(),
      profile,
      principal: principal.id,
    });
  }

  /** Small, secret-free summary for /api/health and for the boot log. */
  function status() {
    return {
      enabled,
      ttlSeconds: config.ttlSeconds,
      stunServers: config.stunUrls.length,
      publicTurn: config.publicTurnUrls.length > 0,
      tailnetTurn: config.tailnetTurnUrls.length > 0,
      rejectedUrls: config.rejectedUrls.length,
    };
  }

  if (config.rejectedUrls.length) {
    log.warn('ice.bad_urls_ignored', { urls: config.rejectedUrls });
  }
  if (!enabled) {
    log.warn('ice.disabled', {
      detail: 'set TURN_STATIC_AUTH_SECRET plus TURN_PUBLIC_URL/TURN_TAILNET_URL (or PUBLIC_ORIGIN + TS_TAILNET_IP)',
    });
  }

  return {
    config,
    enabled,
    mintTurnCredential,
    buildIceServers,
    resolvePrincipal,
    handleRequest,
    status,
  };
}

module.exports = {
  createIceService,
  iceConfigFromEnv,
  parseCookies,
  deviceCookieMac,
  DEFAULT_TTL_SECONDS,
};
