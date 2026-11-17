# ARCHITECTURE-PUBLIC.md

**Public exposure and security architecture for the frameo-clone stack.**

This document is a *contract*. Everything below is decided, not proposed. Other builders code
against it. Where a value is written as a literal (a port, a header name, a cookie name, a JSON
field), that literal is normative — do not rename it "because it reads better".

Scope: this document covers the optional public exposure step (`expose-public.sh`). A deploy that
stops after `deploy.sh` is tailnet-only and uses `tailscale serve`, as described in `README-ops.md`
§7. Once Funnel is enabled, this document takes precedence over any "never use `funnel`" wording
there. Install steps are in `INSTALL.md` at the repo root.

---

## 0. Decision summary

| # | Question | Decision |
|---|---|---|
| D1 | How does the app reach the public internet? | `tailscale funnel --bg --https=443` on the existing node. No router port-forwarding, no reverse proxy, no second TLS terminator. |
| D2 | What happens to `tailscale serve --https=443`? | It is **removed**. Serve and Funnel cannot share a port. Funnel on 443 remains reachable from inside the tailnet, so the tablets keep the same URL. |
| D3 | Public hostname | `https://your-machine.your-tailnet.ts.net/` — unchanged from today. |
| D4 | Admin auth | Username + password, scrypt-hashed, HTTP-only session cookie, server-side session store persisted to disk. Named accounts, not one shared password. |
| D5 | Tablet auth | **Unchanged.** `?device=<rosterId>&token=<authToken>` → localStorage → WS `register`. One additive change: the same pair also mints a long-lived `frameo_device` cookie so plain HTTP requests (static files, `/api/photo/*`) are authenticated too. |
| D6 | WebSocket auth | Cookie validated at the HTTP upgrade, plus `Origin` check. Roster devices continue to authenticate in the `register` message body. Never in the query string. |
| D7 | WebRTC media when a phone is on the public internet | STUN first (direct P2P preferred), coturn TURN-over-TLS as fallback, published via `tailscale funnel --bg --tls-terminated-tcp=10000`. Relay candidates are allocated on the **tailnet** IP, which the tablets can reach directly. |
| D8 | TURN credentials | Ephemeral, `use-auth-secret` / `static-auth-secret` (the TURN REST scheme), minted by the signalling server per authenticated session, 12 h TTL. No static TURN users. |
| D9 | Source-IP trust | **None.** Everything arrives at the app from `127.0.0.1` whether it came from the tailnet or the public internet. No authorization decision may read `req.socket.remoteAddress`. |

### 0.1 Port and hostname map after this change

| Public endpoint | Terminated by | Backend | Purpose |
|---|---|---|---|
| `https://your-machine.your-tailnet.ts.net/` (TCP 443) | tailscaled (Funnel, Let's Encrypt) | `http://127.0.0.1:8080` | Web app, `/api/*`, `wss://…/ws` |
| `turns:your-machine.your-tailnet.ts.net:10000?transport=tcp` (TCP 10000) | tailscaled (Funnel, `--tls-terminated-tcp`, same cert) | `tcp://127.0.0.1:3478` | coturn TURN relay for public clients |
| `turn:<TS_IP4>:3478?transport=udp` (tailnet only) | nothing | coturn | TURN for tablets, UDP, tailnet path |
| `http://127.0.0.1:2283` | — | immich-server | **Never** funnelled. Not published, not proxied except through `/api/photo*` in the signalling server. |

`<TS_IP4>` is the node's tailnet IPv4, obtained with `tailscale ip -4` at deploy time and written to
`TS_TAILNET_IP` in `.env`. It is a `100.64.0.0/10` address.

---

## 1. Tailscale Funnel

### 1.1 What must be true before any command works

Funnel is gated by three independent things. All three are required.

1. **HTTPS certificates enabled for the tailnet.** Admin console → DNS → HTTPS Certificates → Enable.
   This is already true today, because `tailscale serve --https=443` is working and is producing a
   real Let's Encrypt certificate for `your-machine.your-tailnet.ts.net`.
2. **A `funnel` node attribute in the tailnet policy file (ACL).** Without it, `tailscale funnel`
   errors out with "Funnel is not enabled on your tailnet".
3. **MagicDNS enabled.** Already true (the node is addressed by its MagicDNS name).

### 1.2 The literal ACL JSON

Admin console → **Access controls**. Add the `nodeAttrs` block below to the tailnet policy file. If a
`nodeAttrs` key already exists, append the object to the existing array rather than replacing it.

```json
{
  "nodeAttrs": [
    {
      "target": ["autogroup:member"],
      "attr":   ["funnel"]
    }
  ]
}
```

The admin console also offers a one-click path: **Access controls → Funnel → "Add Funnel to policy"**,
which inserts exactly the snippet above. Either route is fine; the JSON is the contract.

Tighter alternative, if you prefer not to grant Funnel to every member — grant it to one tagged
node instead. This requires the node to actually carry the tag, so it is **not** the default:

```json
{
  "tagOwners": {
    "tag:frameo-public": ["autogroup:admin"]
  },
  "nodeAttrs": [
    {
      "target": ["tag:frameo-public"],
      "attr":   ["funnel"]
    }
  ]
}
```

> Decision: use the `autogroup:member` form. The expected tailnet is one person plus the frames;
> tagging buys nothing here and adds a re-authentication step (`tailscale up --advertise-tags=…`)
> that can knock the node off the tailnet in the middle of the night.

The very first `tailscale funnel` invocation on a node also opens an interactive browser consent
flow. Because deployment is scripted and headless, pass `--yes` (see §1.3) — but be aware that the
**ACL attribute is still mandatory**; `--yes` only suppresses the interactive prompt, it does not
grant the capability.

### 1.3 The exact commands

Run on the server as root. Order matters: the old Serve mapping on 443 must be removed first,
because "the same port number cannot be used for Serve … and Funnel … at the same time".

```bash
# 0. Sanity: what is configured right now
tailscale serve status
tailscale funnel status

# 1. Remove the tailnet-only Serve mapping that currently owns 443.
sudo tailscale serve --https=443 http://127.0.0.1:8080 off

# 2. Publish the web app on the public internet, port 443, background/persistent.
sudo tailscale funnel --bg --yes --https=443 http://127.0.0.1:8080

# 3. Publish coturn as a TLS-terminated TCP forwarder on port 10000.
#    tailscaled terminates TLS with the node's Let's Encrypt cert and hands
#    coturn plaintext TURN-over-TCP on 127.0.0.1:3478.
sudo tailscale funnel --bg --yes --tls-terminated-tcp=10000 tcp://127.0.0.1:3478

# 4. Verify
tailscale funnel status
curl -fsS https://your-machine.your-tailnet.ts.net/api/health
openssl s_client -connect your-machine.your-tailnet.ts.net:10000 \
  -servername your-machine.your-tailnet.ts.net </dev/null 2>/dev/null | head -20
```

Do **not** pass `--proxy-protocol=1|2` on step 3. coturn does not speak the PROXY protocol and will
treat the PROXY header as a malformed STUN message.

Rollback, if any of this goes wrong at 03:00:

```bash
sudo tailscale funnel --https=443 http://127.0.0.1:8080 off
sudo tailscale funnel --tls-terminated-tcp=10000 tcp://127.0.0.1:3478 off
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080     # back to tailnet-only
```

`sudo tailscale funnel reset` clears **all** funnel configuration in one shot and is the blunt
version of the above.

Persistence: `--bg` writes the mapping into `tailscaled`'s state, so it survives reboots and
`tailscaled` restarts. `deploy.sh` must be idempotent about this — re-running the two `funnel --bg`
commands on an already-configured node is a no-op, so just run them unconditionally.

### 1.4 Does Funnel still serve the tailnet?

Yes. Enabling Funnel on a port is Serve plus a public ingress flag on the same mapping; the mapping
still answers requests from inside the tailnet at the same hostname and port. **The tablets keep
their existing URL and do not need reconfiguring.** Their traffic now takes the tailnet path (WireGuard
direct or DERP), not the public Funnel ingress, so it does not consume Funnel bandwidth.

### 1.5 Hostname format

`<machine-name>.<tailnet-name>.ts.net` → **`your-machine.your-tailnet.ts.net`**.

Funnel can only serve names in the tailnet's own `ts.net` domain. A custom domain
(`frame.example.com`) is **not** possible through Funnel; a CNAME to the `ts.net` name would break
TLS, because Funnel's ingress routes on the SNI and only holds a certificate for the `ts.net` name.
If a pretty URL is ever wanted, the answer is a redirect from `example.com`, not a CNAME.

### 1.6 Ports

Funnel accepts **only 443, 8443 and 10000**. This is a hard, undocumented-but-enforced constraint in
the ingress; other ports fail silently (the connection hangs — upstream bug
tailscale/tailscale#14625, still open). We use 443 and 10000 and leave 8443 free as a spare.

### 1.7 TLS and SNI — the part that determines the coturn design

Funnel "only works over TLS-encrypted connections". The ingress accepts a TCP connection, reads the
**SNI** from the TLS ClientHello, and uses it to decide which tailnet node to route to. Consequences:

* `--https=<port>` — tailscaled terminates TLS and reverse-proxies HTTP to the backend. This is what
  the web app uses.
* `--tls-terminated-tcp=<port>` — tailscaled terminates TLS and forwards **plaintext TCP** to the
  backend. The client must speak TLS with the correct SNI. This is what coturn uses, and it is why
  **coturn needs no certificate of its own** and must be configured for plain TURN-over-TCP.
* `--tcp=<port>` — tailscaled forwards the still-encrypted bytes; the backend terminates TLS itself.
  Rejected: it would require giving coturn a copy of the certificate and a renewal mechanism, which
  is exactly the `tailscale cert` failure mode `README-ops.md` §7 already forbids.
* **Raw, non-TLS TCP over Funnel is impossible.** (Upstream feature request tailscale/tailscale#14240
  is open and unimplemented.) So `turn:…?transport=tcp` on port 10000 will never work; only
  `turns:…?transport=tcp` will.

### 1.8 WebSockets

**Funnel supports WebSockets.** `--https=` mode is an HTTP reverse proxy that performs the
`Upgrade: websocket` handshake correctly and then pipes the connection; `wss://your-machine.your-tailnet.ts.net/ws`
works from the public internet with no extra configuration on either side.

One reported caveat matters to us: **tailscale/tailscale#18651** ("Tailscale serve strips query
parameters from WebSocket upgrade requests", open, `waiting-for-info`) claims the backend sees
`/ws` instead of `/ws?token=…`. Whether or not that reproduces on the current version, we do not
care, and **must not start caring**:

* The existing protocol already authenticates in the first WS **message body**
  (`{"type":"register","id":…,"authToken":…}`), not in the URL. Keep it that way.
* No builder may add a query parameter to the WebSocket URL for any purpose that matters. The path
  is `/ws` (env `WS_PATH`), full stop.

Regular (non-WebSocket) HTTP query strings are **not** affected; `GET /?device=…&token=…` and
`GET /api/photos?limit=…` are fine.

### 1.9 Limits, bandwidth, terms

Summary, so nobody is surprised later:

* **"Traffic sent over a Funnel is subject to non-configurable bandwidth limits."** Tailscale does
  not publish the number. Community reports range from "never hit it" to occasional throttling on
  sustained multi-megabit streams. Plan for it: our steady-state Funnel traffic is a few hundred KB
  of app assets plus ~1–3 MB of photo thumbnails per admin session, which is nothing. The risk is
  concentrated entirely in **relayed video** (§3), which is why §3.6 caps the bitrate.
* **Let's Encrypt rate limits.** Certificates are issued per `ts.net` name. Thrashing
  `funnel reset` / re-enable in a loop can burn the issuance budget and produce a ~34 hour lockout
  with no certificate at all — which takes down the tablets too, since they use the same hostname.
  **Never script a reset loop.** Configure once, verify, stop touching it.
* **Acceptable Use Policy.** Tailscale's AUP (last updated 2025-06-30) prohibits the obvious things:
  phishing, spam, malware distribution, infringing content, unauthorized access attempts. A private,
  password-protected family photo frame for three people is squarely within normal use. There is no
  published per-account data cap and no prohibition on personal media. There is also no SLA for
  Funnel — Tailscale may throttle or disable ingress, and if they do, the tablets keep working over
  the tailnet while the phones stop. That is the correct failure ordering.
* **Platform.** Funnel requires a node that can run the Tailscale CLI. Ubuntu 24.04 with the
  official `tailscaled`: fine.
* Funnel state is per-node. If the server is ever re-keyed or re-registered, the funnel
  configuration and the certificate are re-created; budget 60 seconds of downtime.

---

## 2. Authentication and authorization

### 2.1 Principals

There are exactly three kinds of caller. Nothing else may be granted access.

| Principal | Who | Credential | Where it lives |
|---|---|---|---|
| `device` | The tablets (`frame-a`, `frame-b` in the examples) | roster `authToken` | `~/frameo/config/roster.json` |
| `admin` | Family members (`ana`, `ion`, `maria` in the examples) — on phones, over the public internet | username + password | `~/frameo/config/admins.json` |
| `control` | The local ring script on the server | `CONTROL_TOKEN` bearer | `.env` |

An `admin` account is **bound to a roster peer**, so all existing `canCall()` logic keeps working
untouched. Every account needs its **own** `family` row in the roster:

```json
{"id":"family-ana","displayName":"Ana","kind":"family","authToken":"<32+ chars>","allowlist":["frame-a","frame-b"]}
{"id":"family-ion","displayName":"Ion","kind":"family","authToken":"<32+ chars>","allowlist":["frame-a","frame-b"]}
{"id":"family-maria","displayName":"Maria","kind":"family","authToken":"<32+ chars>","allowlist":["frame-a","frame-b"]}
```

One peer per person, not one per household: the server allows exactly one live socket per peer id,
and a second socket registering the same id closes the first with `session-replaced`. Two phones
sharing a peer id would knock each other offline in a loop. The `authToken` on a `family` row still
exists (so a laptop can register the old way over the tailnet) but the phones never use it — they
register with a session cookie instead (§2.7).

### 2.2 The admins file

Path from env `ADMINS_PATH`, default `/config/admins.json` inside the container, mounted from
`~/frameo/config/admins.json` on the host, mode `0600`, owned by the container user.
Loaded and hot-reloaded with the **same** mechanism as `roster.json` (`readRosterFile` /
`startRosterWatcher` pattern in `signalling/server.js`) so adding an account needs no restart.

```json
{
  "accounts": [
    {
      "username": "ana",
      "displayName": "Ana",
      "peerId": "family-ana",
      "passwordHash": "scrypt$N=32768,r=8,p=1$<salt-base64url>$<hash-base64url>",
      "disabled": false
    },
    {
      "username": "ion",
      "displayName": "Ion",
      "peerId": "family-ion",
      "passwordHash": "scrypt$N=32768,r=8,p=1$<salt-base64url>$<hash-base64url>",
      "disabled": false
    },
    {
      "username": "maria",
      "displayName": "Maria",
      "peerId": "family-maria",
      "passwordHash": "scrypt$N=32768,r=8,p=1$<salt-base64url>$<hash-base64url>",
      "disabled": false
    }
  ]
}
```

Validation on load, mirroring the roster loader's strictness — refuse to start on a malformed file
and keep the previous good copy on a bad hot-reload:

* `username`: `/^[a-z0-9_-]{2,32}$/`, unique, compared case-insensitively (lowercase the input).
* `peerId`: must exist in the roster and have `kind === "family"`.
* `passwordHash`: must parse as the format in §2.3.
* `disabled: true` → the account authenticates never, and all its live sessions are dropped on
  reload.

**Why named accounts instead of one shared password:** revoking one leaked phone must not force the
other two people to learn a new password at 07:00, and the call log should say who rang. The cost is
one extra field on a login form. Each account has its own `peerId` (see §2.1), so a call rings on
the frame under that person's own name.

### 2.3 Password hashing

**Algorithm: scrypt, from `node:crypto`. No new dependencies.** (Argon2id would be marginally better
but every Node binding for it is a native module, and this stack's whole point is a
zero-native-dependency container.)

Parameters — normative:

| Parameter | Value | Why |
|---|---|---|
| `N` | `32768` (2^15) | ~33 MB and roughly 80–150 ms per hash on a laptop-class CPU. Two orders of magnitude above Node's default cost. |
| `r` | `8` | Standard. |
| `p` | `1` | Standard. |
| `keylen` | `32` | 256-bit output. |
| `salt` | `crypto.randomBytes(16)` | Per-account, stored in the hash string. |
| `maxmem` | `64 * 1024 * 1024` | **Must be passed explicitly.** `128 * N * r` is 33 554 432 bytes, which exceeds Node's 32 MiB default `maxmem` and makes `scrypt` throw `ERR_CRYPTO_INVALID_SCRYPT_PARAM`. Passing 64 MiB is the fix. |

Storage format (a single line, no ambiguity, self-describing so the cost can be raised later without
invalidating old hashes):

```
scrypt$N=32768,r=8,p=1$<salt base64url, no padding>$<derived key base64url, no padding>
```

Verification:

```js
const crypto = require('node:crypto');

const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, 32, SCRYPT_OPTS);
  return `scrypt$N=${SCRYPT_OPTS.N},r=${SCRYPT_OPTS.r},p=${SCRYPT_OPTS.p}`
    + `$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

/** Constant-time. Returns false for any malformed stored hash rather than throwing. */
function verifyPassword(password, stored) {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (!(N >= 16384 && N <= 1048576 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const salt = Buffer.from(m[4], 'base64url');
  const expected = Buffer.from(m[5], 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, expected.length,
      { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) });
  } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
```

`scryptSync` blocks the event loop for ~100 ms. That is acceptable *only* because §2.6 caps login
attempts hard. Use the async `crypto.scrypt` if it costs nothing to do so; if the code is simpler
sync, sync is permitted.

**Hash generation tool** — `signalling/hash-password.js`, run on the server, reads the password
from stdin (never `argv`, which leaks into `ps` and shell history):

```bash
docker exec -it frameo-signalling node hash-password.js -u ion -d 'Ion' -p family-ion
# prompts for the password, prints the scrypt$… string (or a ready-made account entry), exits
```

**Logging rules, absolute:**
* Never log a password, not even truncated, not even at debug level.
* Never log a `passwordHash`, a session id, a cookie value, a roster `authToken`, `CONTROL_TOKEN`,
  `SESSION_SECRET`, `TURN_STATIC_AUTH_SECRET`, or a minted TURN credential.
* Login events log `{event, username, outcome, sourceKey}` and nothing else. `outcome` is one of
  `ok | bad-password | unknown-user | disabled | locked-out | rate-limited`. `sourceKey` is the
  hashed rate-limit key from §2.6, not a raw IP.

### 2.4 Endpoint access matrix

Enforced by a single gate at the top of `handleHttpRequest`, before any route dispatch. Fail closed:
anything not listed as PUBLIC requires an authenticated principal.

| Path | PUBLIC | `device` | `admin` | `control` |
|---|---|---|---|---|
| `GET /login`, `GET /login.css`, `GET /login.js` | ✅ | ✅ | ✅ | — |
| `POST /api/auth/login` | ✅ (rate-limited) | — | — | — |
| `POST /api/auth/logout` | — | — | ✅ | — |
| `GET /api/auth/session` | ✅ (returns `{"authenticated":false}` when anonymous) | ✅ | ✅ | — |
| `GET /api/health` | ✅ **reduced** — `{"ok":true}` only | full | full | full |
| `GET /` and all other static assets | — | ✅ | ✅ | — |
| `GET /api/photos` | — | ✅ | ✅ | — |
| `GET /api/photo/:id` | — | ✅ | ✅ | — |
| `POST /api/admin/photos` (upload) | — | — | ✅ | — |
| `DELETE /api/admin/photos/:id` | — | — | ✅ | — |
| `GET /api/turn-credentials` | — | ✅ | ✅ | — |
| `WS /ws` | — | ✅ | ✅ | — |
| `POST /api/call`, `POST /api/hangup` | — | — | — | ✅ Bearer |

Two changes to today's behaviour are load-bearing and must not be skipped:

1. **`/api/photos` and `/api/photo/:id` are currently unauthenticated.** On the tailnet that was
   fine. On the public internet it is the entire family photo library behind a guessable URL. They
   are now gated.
2. **`/api/health` is currently unauthenticated and verbose.** Publicly it must return exactly
   `{"ok":true}` with `Cache-Control: no-store`. The full payload (peer list, roster size, Immich
   status, uptime, version) is returned only to an authenticated principal. `healthcheck.sh` runs on
   the server and must be updated to send `Authorization: Bearer $CONTROL_TOKEN`, which grants the
   full payload.

Unauthenticated requests to a non-PUBLIC path:
* `Accept:` contains `text/html` → `302` to `/login?next=<url-encoded original path+query>`.
  `next` must be validated on use: accept only values matching `/^\/(?!\/)/` — a single leading
  slash, no scheme, no `//`. Anything else → `/`.
* otherwise → `401` with `{"error":"unauthenticated"}` and `Cache-Control: no-store`.

### 2.5 Sessions and cookies

**Session store: server-side, in memory, persisted to disk.** `Map<sid, {username, peerId, createdAt, expiresAt, lastSeenAt, label}>`.

* Persistence file from env `SESSION_STORE_PATH`, default `/data/sessions.json`, host path
  `~/frameo/logs/sessions.json` (compose mounts `~/frameo/logs` at `/data`), mode `0600`. Written atomically (write
  `.tmp`, `fsync`, `rename`) at most once every 30 s and once on `SIGTERM`. Expired entries are
  pruned on load and every 10 minutes.
* Rejected alternative: a stateless signed JWT-ish token. It cannot be revoked without adding a
  revocation list, which is a session store with extra steps. With three users and a handful of
  devices, a `Map` is smaller, faster and easier to reason about.

`SESSION_SECRET` (env, 32 random bytes hex, `openssl rand -hex 32`) is still required: session ids
are `crypto.randomBytes(32).toString('base64url')` and the cookie carries `<sid>.<hmac>` where
`hmac = HMAC-SHA256(SESSION_SECRET, sid)`, base64url. The HMAC lets the server reject garbage
cookies without a store lookup, which keeps a flood of forged cookies from touching the Map.
Compare with `crypto.timingSafeEqual`.

Cookies:

| Cookie | Value | Attributes | Lifetime |
|---|---|---|---|
| `frameo_sid` | `<sid>.<hmac>` | `HttpOnly; Secure; SameSite=Lax; Path=/` | `Max-Age=7776000` (90 days) |
| `frameo_csrf` | `crypto.randomBytes(16).toString('base64url')` | `Secure; SameSite=Lax; Path=/` — **not** HttpOnly, on purpose | same as the session |
| `frameo_device` | `<rosterId>.<hmac>` where `hmac = HMAC-SHA256(SESSION_SECRET, "device:" + rosterId + ":" + authToken)` | `HttpOnly; Secure; SameSite=Lax; Path=/` | `Max-Age=31536000` (365 days) |

Notes on each attribute, because these are the ones people get wrong:

* `Secure` is unconditional. The app is only ever reachable over HTTPS (Funnel terminates TLS; the
  container's plaintext 8080 is bound to `127.0.0.1` only). A cookie without `Secure` on a site that
  is also reachable over plain HTTP on the LAN would leak.
* `SameSite=Lax`, **not** `Strict`. The parents will open this link from WhatsApp. `Strict` withholds
  the cookie on cross-site top-level navigation, so the link from WhatsApp would dump them on the
  login page every single time. `Lax` sends the cookie on top-level `GET` navigations and withholds
  it on cross-site `POST`, which is exactly the behaviour we want.
* `HttpOnly` on `frameo_sid` and `frameo_device` so an XSS in our own JS cannot exfiltrate them.
  `frameo_csrf` is deliberately readable by JS — that is the double-submit pattern.
* No `Domain` attribute. Host-only cookie for `your-machine.your-tailnet.ts.net`. This matters:
  a `Domain=.ts.net` cookie would be sent to every other Tailscale user's funnel. (`ts.net` is on the
  Public Suffix List so browsers would reject it anyway — do not rely on that, just never set
  `Domain`.)

**Session lifetime: 90 days, sliding.** On any authenticated request, if `expiresAt - now < 89 days`
(i.e. the session was last refreshed more than 24 h ago), extend `expiresAt` to `now + 90 days` and
re-issue the cookie. Rationale: the parents must not be asked for a password on a schedule; being
logged out is, for this user population, a worse failure than a stale session. An absolute cap is
deliberately **not** imposed — revocation is the escape hatch.

Revocation:
* `POST /api/auth/logout` deletes the current `sid`.
* `POST /api/auth/logout-all` deletes every session for the calling username.
* Setting `"disabled": true` in `admins.json`, or removing the account, drops all of its sessions on
  the next hot-reload. This is the "my phone was stolen" procedure and it needs no restart.
* Changing `SESSION_SECRET` invalidates every session and every device cookie at once. Document that
  in `.env.example` next to the variable.

### 2.6 Brute-force protection

Two independent counters, both in memory, both keyed on a **salted hash** of the identifier so no raw
IP ever lands in a log line:

```js
const sourceKey = crypto.createHmac('sha256', SESSION_SECRET).update(sourceIp).digest('base64url').slice(0, 16);
```

`sourceIp` is `req.headers['x-forwarded-for']`'s **first** hop if the header is present, else
`req.socket.remoteAddress`. tailscaled sets `x-forwarded-for` on proxied requests. Treat it as a
best-effort signal only — see the threat model, §4.4.

| Counter | Window | Limit | Action on exceed |
|---|---|---|---|
| per username | 15 min sliding | 5 failures | Lock the username for 15 min. `429`, `Retry-After: 900`. Successful password does **not** unlock early. |
| per `sourceKey` | 15 min sliding | 20 failures | `429`, `Retry-After: 900`, for all usernames from that source. |
| global | 15 min sliding | 100 failures | `429` for everyone, and one `logError('auth.global_lockout')`. This is the "we are being scanned" alarm. |

Plus:
* A fixed **300 ms** delay on every failed login response, applied *after* the scrypt work, so that
  the response time carries no information about whether the username exists.
* Identical response body and status for unknown-username and wrong-password:
  `401 {"error":"invalid-credentials"}`. Never "no such user".
* A successful login clears that username's failure counter.
* `POST /api/auth/login` accepts `application/json` only, body limit 1 KiB (reuse `readJsonBody`),
  and rejects a password longer than 256 bytes before hashing it (scrypt on a 10 MB "password" is a
  free CPU DoS).
* Counters are in memory and reset if the container restarts. Accepted — see §4.4.

**Password strength requirement**, enforced by `hash-password.js`, not by the login endpoint:
minimum 12 characters. Recommend a four-word passphrase (e.g. three lowercase words plus
a digit) — the grandparents' generation types those far more reliably than `Xk9!q` on a phone
keyboard, and at 12+ characters with a 5-attempt lockout the online-guessing risk is negligible.

### 2.7 WebSocket upgrade authentication

`server.on('upgrade')` currently only checks the path. It gains three checks, in this order, before
`wss.handleUpgrade`:

1. **Path.** `url.pathname === CONFIG.wsPath` (`/ws`). Unchanged. Ignore the query string entirely —
   see §1.8.
2. **Origin.** If an `Origin` header is present it must exactly equal `PUBLIC_ORIGIN`
   (`https://your-machine.your-tailnet.ts.net`) or one of the extra values in
   `EXTRA_ALLOWED_ORIGINS` (comma-separated env, empty by default; used only for local development
   against `http://localhost:8080`). A mismatch → `403`, socket destroyed, `logWarn('ws.bad_origin')`.
   A *missing* `Origin` is allowed, because non-browser clients (a future native app, `wscat`) do not
   send one and are still gated by step 3 / the `register` message.
   **This check is not optional.** Cookies are attached to cross-origin WebSocket handshakes by the
   browser, so without an `Origin` check any web page the parents visit could open an authenticated
   socket to our server (cross-site WebSocket hijacking). `SameSite=Lax` does *not* reliably cover
   the WebSocket handshake.
3. **Cookie.** Parse `frameo_sid`; if it validates, attach `{username, peerId}` to the request as
   `req.frameoAccount`. If it does not validate, parse `frameo_device`; if it validates, attach
   `req.frameoDevice = rosterId`. Neither is required at this stage — an anonymous socket is still
   allowed to connect and is still killed by the existing `REGISTER_TIMEOUT_MS` timer.

Then `handleRegister` gains one branch and loses nothing:

```
register { type:"register", id, authToken? }

  if ws.account exists (session cookie was valid at upgrade):
      accept iff id === ws.account.peerId          // no authToken needed or consulted
  else if ws.device exists (device cookie was valid at upgrade):
      accept iff id === ws.device
  else:
      existing path: roster lookup + tokenMatches(msg.authToken, entry.authToken)
```

Everything downstream — `peers`, `canCall`, presence, call state, the call log — is untouched. The
call log gains one optional field, `actor`, set to the admin `username` when the call was started by
a cookie-authenticated socket, so "who rang Bunica at 22:40" is answerable.

Failure response is the existing generic `sendError(ws, 'auth-failed', …)`. Do not differentiate.

### 2.8 CSRF

`SameSite=Lax` blocks cross-site `POST` with cookies, which covers the realistic case. Add
double-submit on top, because it is ten lines and it also covers the `<form method=GET>` and
`fetch(..., {mode:'no-cors'})` corners:

* Every non-`GET`/`HEAD` request to `/api/admin/*` and `/api/auth/logout*` must carry the header
  `X-Frameo-CSRF` whose value equals the `frameo_csrf` cookie. Compare with `timingSafeEqual`.
  Mismatch or missing → `403 {"error":"csrf"}`.
* `POST /api/auth/login` is exempt (there is no session yet) — it is protected by the rate limiter
  and by the fact that a forged login is not an attack.
* Uploads use `multipart/form-data`; the header requirement still applies and is what makes the
  endpoint safe. Do **not** accept a CSRF token in a form field.
* The control API (`/api/call`, `/api/hangup`) is exempt: it is bearer-authenticated, never
  cookie-authenticated, so it is not reachable by a cross-site request that could carry ambient
  credentials.

### 2.9 Security response headers

Set on every response from `handleHttpRequest` (one helper, called before the first `writeHead`):

```
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://your-machine.your-tailnet.ts.net; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

`Permissions-Policy` must allow `camera` and `microphone` for `self` or `getUserMedia` fails silently
in the call UI. No `'unsafe-inline'` anywhere: the client is plain files under
`signalling/public/`, so there is no reason to need it — inline `<style>`/`<script>` blocks and
`onclick=` attributes are therefore banned in the client code.

Also: `Cache-Control: no-store` on every `/api/*` response and on `/login`. Static assets keep
whatever `serveStatic` does today.

---

## 3. WebRTC media path

### 3.1 The topology, stated plainly

```
  phone (public internet, mobile or foreign Wi-Fi)          tablet (tailnet node, at a grandparent's house)
        │                                                             │
        │ 1. signalling: wss://…ts.net/ws  ──── Funnel:443 ────┐      │ 1'. signalling over the tailnet
        │                                                      ▼      │
        │                                            [ signalling server, 127.0.0.1:8080 ]
        │                                                             │
        │ 2. STUN / TURN                                              │ 2'. STUN / TURN over the tailnet
        │    turns:…ts.net:10000?transport=tcp                        │     turn:100.x.y.z:3478?transport=udp
        │           │                                                 │            │
        │           └── Funnel:10000 (TLS terminated) ──► coturn ◄────┴────────────┘
        │                                                  │
        │◄───────────── media, relayed ────────────────────┤
                                                           │
                        relay candidate is allocated on 100.x.y.z  ──► reachable by the tablet
                                                                        over WireGuard/DERP
```

### 3.2 Why this works when it looks like it should not

The usual objection to "TURN behind a tunnel with no port forwarding" is that a TURN server must
allocate a **relayed transport address that the remote peer can reach**, and a Funnel-only host has
no publicly reachable UDP.

That objection does not apply here, because **the remote peer is always on the tailnet**. Concretely:

* The phone opens a TLS connection to `your-machine.your-tailnet.ts.net:10000`. Funnel
  terminates TLS and hands coturn a plain TURN-over-TCP connection. The phone's media flows over
  *that one TCP connection* in both directions — the phone never needs to reach the relay address
  directly.
* coturn creates the allocation with its relay socket bound to the node's **tailnet** address
  `100.x.y.z`, and returns that as the relayed candidate.
* The phone signals `candidate: … typ relay … 100.x.y.z <port>` to the tablet.
* The tablet is a tailnet node, so `100.x.y.z:<port>` is directly routable for it (WireGuard direct
  path, or DERP if the NATs are hostile). Connectivity checks succeed and media flows.

So the relay address only ever has to be reachable by a tailnet member, and it is. No router
configuration, no public UDP, no port forwarding.

### 3.3 coturn deployment

* **Image:** `coturn/coturn:4.7.0-alpine` (pin the tag; do not use `latest`).
* **Network mode: `host`.** Non-negotiable. coturn must bind the host's tailnet IP `100.x.y.z` for
  relay allocations, and that address exists only in the host network namespace because `tailscaled`
  runs on the host. A bridge-network container cannot do this.
* Because it is on the host network, the config must pin **every** listening address explicitly.
  A default coturn binds `0.0.0.0` and would be exposed to the home LAN, which we do not want.
* Add the container to `frame.slice` exactly like the others (`cgroup_parent: frame.slice` or the
  equivalent already used in `docker-compose.signalling.yml`), so the CPU/memory budget still holds.
* Container name: `frameo-coturn`, in its own compose file `docker-compose.turn.yml`, so it can be
  restarted without dropping the signalling websockets.

### 3.4 `turnserver.conf` — normative

Host path `~/frameo/config/turnserver.conf`, mounted read-only at
`/etc/coturn/turnserver.conf`. The template is `server/turnserver.conf`; `${…}` values are
substituted from `.env` by `render-turnserver-conf.sh`, and the file written to disk contains
literals. The block below shows the intent; the template in the repo is authoritative.

```conf
# ---------------------------------------------------------------------------
# frameo-clone coturn.  Reached two ways:
#   * public phones  -> tailscale funnel --tls-terminated-tcp=10000 -> 127.0.0.1:3478 (plain TCP)
#   * tailnet frames -> 100.x.y.z:3478 directly (UDP and TCP)
# TLS is terminated by tailscaled, NOT here.  coturn holds no certificate.
# ---------------------------------------------------------------------------

listening-port=3478

# Bind ONLY these. Never 0.0.0.0 - this container is on the host network and
# must not answer on the LAN interface or on the public IPv4.
listening-ip=127.0.0.1
listening-ip=${TS_TAILNET_IP}

# Relay allocations live on the tailnet address so that the frames, which are
# tailnet nodes, can reach them directly.  This is the whole trick.
relay-ip=${TS_TAILNET_IP}

# No external-ip mapping: we deliberately do NOT want coturn advertising the
# home router's public IPv4, which has no port forwarding and would only
# produce dead candidates.

min-port=49160
max-port=49260

# --- Authentication --------------------------------------------------------
# Ephemeral credentials (the "TURN REST API" scheme).  The signalling server
# mints username/password pairs from the same shared secret.  No static users.
use-auth-secret
static-auth-secret=${TURN_STATIC_AUTH_SECRET}
realm=your-machine.your-tailnet.ts.net

# --- Hardening -------------------------------------------------------------
no-cli
no-tls
no-dtls
no-multicast-peers
no-software-attribute
no-rfc5780
no-stun-backward-compatibility
response-origin-only-with-rfc5780

# Do not let the relay be used to reach anything except the peers we care
# about.  Blocks the classic "open TURN server as an internal port scanner".
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
# ...then allow back exactly the tailnet, which is where the frames live.
allowed-peer-ip=100.64.0.0-100.127.255.255

# --- Quotas ----------------------------------------------------------------
# Everything arriving via Funnel appears to come from 127.0.0.1, so per-IP
# limits are useless.  These are global backstops.
user-quota=12
total-quota=48
max-bps=1500000

# --- Logging ---------------------------------------------------------------
log-file=stdout
simple-log
no-stdout-log=false
# NEVER enable verbose/extra logging in production: it prints credentials.
```

Notes for the implementer:

* `min-port`/`max-port` is a deliberately small range (100 ports ≈ 50 simultaneous allocations).
  These are UDP ports on the tailnet interface; nothing needs to be opened anywhere.
* `no-tls` / `no-dtls` are correct and intentional. tailscaled does the TLS. If coturn also listened
  on 5349 with a self-signed certificate, browsers would reject it and we would be back to managing
  certificate renewal by hand.
* The `denied-peer-ip` block plus the single `allowed-peer-ip` for `100.64.0.0/10` means a stolen
  TURN credential cannot be used to relay traffic to the home LAN, to Immich on localhost, or to
  arbitrary hosts on the internet. This is the single highest-value line in the file.
* UFW/nftables: coturn binds only `127.0.0.1` and `100.x.y.z`, so no firewall rule is needed. If the
  host firewall is default-deny on the `tailscale0` interface, allow `3478/tcp`, `3478/udp` and
  `49160-49260/udp` **on `tailscale0` only**.

### 3.5 Ephemeral TURN credentials

coturn's `use-auth-secret` mode implements the TURN REST credential scheme:

* `username = "<unix-expiry-seconds>:<opaque-id>"`
* `password = base64( HMAC-SHA1( static-auth-secret, username ) )`

New endpoint on the signalling server:

```
GET /api/turn-credentials
  auth: session cookie (admin) or frameo_device cookie / registered device
  200 {
    "iceServers": [ … ],          // ready to hand straight to new RTCPeerConnection
    "ttl": 43200,
    "expiresAt": "2026-08-09T09:12:00.000Z"
  }
  Cache-Control: no-store
```

Implementation:

```js
const TURN_TTL_SECONDS = 12 * 3600;

function mintTurnCredential(principalId) {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${principalId}`;
  const credential = crypto
    .createHmac('sha1', CONFIG.turnStaticAuthSecret)   // sha1 is mandated by the scheme, not a choice
    .update(username)
    .digest('base64');
  return { username, credential, expiry };
}
```

SHA-1 here is not a security weakness: it is an HMAC (not a bare hash), the secret is 32 random
bytes, and the credential expires in 12 hours. coturn implements no alternative.

`principalId` is the roster peer id (`family-ana`, `frame-a`). It appears in coturn's logs,
which is exactly the audit trail we want, and it is not a secret.

The client re-fetches credentials when `expiresAt` is less than 30 minutes away, and always
immediately before creating an `RTCPeerConnection`. Never bake TURN credentials into the HTML.

### 3.6 The exact `iceServers` arrays

The **server** decides which array a client gets, based on the principal, and returns it from
`/api/turn-credentials`. Clients must not construct these themselves.

**Family phones / admins (public internet):**

```json
[
  { "urls": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  {
    "urls": ["turns:your-machine.your-tailnet.ts.net:10000?transport=tcp"],
    "username": "<expiry:principalId>",
    "credential": "<base64 hmac>"
  }
]
```

**Frames / tablets (tailnet):**

```json
[
  {
    "urls": ["turn:100.x.y.z:3478?transport=udp", "turn:100.x.y.z:3478?transport=tcp"],
    "username": "<expiry:principalId>",
    "credential": "<base64 hmac>"
  }
]
```

Rules that go with those arrays:

* `iceTransportPolicy` is **`"all"`** on both sides. Never `"relay"`. The whole point is that ICE
  tries the direct path first and only falls back to the relay.
* The frames get **no public STUN server**. They are on the tailnet; their useful candidates are the
  tailnet host address and the LAN address. A public STUN server would only add a server-reflexive
  candidate for the grandparents' home router, which the phone might occasionally be able to use —
  marginal benefit, and it leaks the grandparents' IP to Google. Excluded deliberately.
* The phones get public STUN because their server-reflexive candidate is the one thing that can pair
  directly with the frame's, giving a relay-free call. Two providers for redundancy; both are
  plain `stun:` UDP and carry no data.
* IPv6: no special configuration. If both ends have working IPv6, ICE will find and prefer that pair
  on its own and the relay is never used. Many home and mobile connections now have IPv6, so this is
  a realistic and very good outcome.
* `turns:` requires a publicly-trusted certificate for the SNI host. Funnel presents the node's
  Let's Encrypt certificate for `your-machine.your-tailnet.ts.net`, so this validates in Chrome,
  Safari and Firefox with no extra work.
* Port 10000 is not on any browser's restricted-port list, so `turns:` on 10000 is dialable from
  Chrome, Safari and Firefox without launch flags. (Browsers block a fixed list of low/legacy ports;
  10000 is not among them.)

### 3.7 Will TURN-over-TCP be good enough? An honest answer.

**Usually yes for what this is, and it is not the common case anyway.**

Order of outcomes, best to worst:

1. **Direct IPv6 host-to-host.** Excellent — indistinguishable from a LAN call. Reasonably likely
   when the frame's home connection and the phone's network both have IPv6.
2. **Direct IPv4 via STUN hole punching.** Excellent. Works when the mobile carrier's NAT is
   endpoint-independent. Mobile CGNAT is frequently symmetric, so treat this as a coin flip.
3. **TURN over TCP through Funnel.** This is the fallback, and it is where the honesty is needed.

What TCP relaying costs:

* **Head-of-line blocking.** RTP over TCP means a lost packet stalls every packet behind it. Video
  shows up as a freeze-then-catch-up stutter rather than the graceful blur you get over UDP.
* **Retransmission of stale frames.** TCP will faithfully redeliver a video packet that is already
  useless, spending bandwidth to make latency worse.
* **Two extra hops.** phone → Tailscale ingress → the server → coturn → tailnet → tablet. Expect
  roughly +40 to +90 ms one-way versus a direct path, i.e. 150–250 ms mouth-to-ear. Conversational,
  but people will start talking over each other occasionally.
* **Funnel's undisclosed bandwidth limit** sits directly in this path.

Verdict: **acceptable for 1:1 video with grandparents at a capped bitrate, and not acceptable if you
try to run it at 720p.** Therefore the following client-side caps are **mandatory**, not optional
tuning, and apply to the *phone* side (which is the side that will be relaying):

```js
// after addTrack, on the video sender
const params = sender.getParameters();
params.encodings = [{
  maxBitrate: 600_000,          // 600 kbps ceiling
  maxFramerate: 24,
  scaleResolutionDownBy: 1,     // capture at 640x480; do not send 1080p and downscale
  networkPriority: 'high'
}];
params.degradationPreference = 'maintain-framerate';  // grandparents read faces, not pixels
await sender.setParameters(params);
```

* `getUserMedia` constraints on the phone: `{ width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }`.
* Audio is the thing that must never break. Opus at its default ~32 kbps with `echoCancellation`,
  `noiseSuppression` and `autoGainControl` all on. If the connection degrades, the UI should drop
  video and keep audio rather than freezing both.
* The client must read `RTCPeerConnection.getStats()` for the selected candidate pair, surface
  `candidateType === 'relay'` in the UI as a small "relayed" indicator, and log it. When the user
  reports "the call was bad", that indicator is the first diagnostic.

**If TURN-over-TCP turns out to be unusable in practice**, there are exactly three real fixes, in
increasing order of effort. Do not waste time on anything else:

1. **A €4/month VPS running coturn with public UDP.** One small box, `listening-ip=<vps public ip>`,
   `external-ip=<vps public ip>`, `turn:<vps>:3478?transport=udp` plus `turns:<vps>:443?transport=tcp`
   as a second-chance fallback. UDP relaying removes every problem listed above and is the standard
   answer. This is the recommended fix and should be the first thing tried.
2. **A router port-forward** of one UDP port range to the server, plus `external-ip=<your-public-ip>`
   in `turnserver.conf`. Out of scope for this design (no router changes), but it is free and it
   works, and it is worth considering if you can change the router.
3. **Tailscale on the phones.** Out of scope for this design (family members should not need to
   install anything). Would give a direct WireGuard path and the best possible quality with zero
   relay.

### 3.8 The tablet side keeps the tailnet path

Nothing about the tablets' media path changes. They:

* connect to the signalling server over the tailnet (same URL, now Funnel-backed but tailnet-routed);
* get an `iceServers` array containing only the tailnet coturn address;
* prefer their host candidates, which for a tablet↔tablet or tablet↔laptop call on the tailnet means
  a direct WireGuard path with no relay at all.

The only new thing on the tablet is that a phone's relay candidate (`100.x.y.z:<port>`) now appears
in its candidate list and works. That requires no client change — it is just another candidate.

---

## 4. Threat model

### 4.1 What we defend against

| Threat | Defence |
|---|---|
| Random internet scanner finds the `ts.net` hostname and browses the family photos | Every path except `/login`, `POST /api/auth/login` and a stubbed `/api/health` requires a session cookie or a device token. Fail-closed gate at the top of the request handler. |
| Password guessing against `ana` / `ion` / `maria` | scrypt at N=2^15, 5 failures per username per 15 min → 15 min lockout, 20 per source, 100 globally, uniform error responses, 300 ms constant delay. |
| Password database theft (someone gets `admins.json` or a backup) | Passwords are scrypt hashes with per-account salts. Recovering a 12-character passphrase from an N=2^15 scrypt hash is not economically interesting for this target. |
| Cookie theft over the wire | HTTPS everywhere (Funnel terminates TLS; the plaintext backend listens on `127.0.0.1` only), `Secure` on every cookie, HSTS for a year. |
| Cookie theft via JavaScript | `HttpOnly` on `frameo_sid` and `frameo_device`, plus a CSP with no `'unsafe-inline'`. |
| Cross-site request forgery from a page the parents visit | `SameSite=Lax` plus a double-submit `X-Frameo-CSRF` header on every state-changing request. |
| Cross-site WebSocket hijacking | Mandatory `Origin` check on the upgrade. This is the one browsers do *not* protect for you. |
| Clickjacking (an invisible iframe over the "delete all photos" button) | `X-Frame-Options: DENY` and `frame-ancestors 'none'`. |
| A stolen or lost phone | `logout-all`, or `"disabled": true` in `admins.json` — both take effect without a restart. Worst case, rotate `SESSION_SECRET`, which kills every session and device cookie at once. |
| A stolen TURN credential used to relay someone else's traffic, or to port-scan the home LAN | 12 h TTL; `denied-peer-ip` covers every RFC1918 range, loopback, link-local and ULA; a single `allowed-peer-ip` re-opens only `100.64.0.0/10`. `total-quota=48`, `max-bps=1500000`. |
| Someone points a hostname at us to fish for another site's cookies | Host-only cookies, no `Domain` attribute; `ts.net` is a public suffix. |
| Immich being reached directly from the internet | Immich is published on `127.0.0.1:2283` and is never funnelled. The only path to it is the signalling server's proxy endpoints, which are themselves authenticated. |
| Log-based credential leakage | Explicit deny-list in §2.3. Rate-limit keys are HMACs, not raw IPs. coturn runs without verbose logging. |
| Request-body DoS on login | 1 KiB JSON limit, 256-byte password cap checked before any scrypt call. |

### 4.2 What we deliberately do NOT defend against

These are conscious trade-offs, not oversights.

1. **A determined, targeted attacker.** This is a family photo frame for a handful of people. Someone
   specifically after the operator will do better attacking their phone, their email, or their
   Tailscale account than this service.
2. **Compromise of the Tailscale account.** Whoever controls the tailnet controls the ingress, the
   certificate, and the tailnet-side access to coturn and to the frames. **Mitigation, outside this
   codebase: turn on 2FA for the Tailscale login, and for the identity provider behind it.** This
   is the single highest-leverage thing you can do.
3. **Compromise of the server host.** Root on the server is game over — the Immich library, the
   roster tokens, `SESSION_SECRET`, the TURN secret, everything. No defence-in-depth against local
   root is attempted.
4. **Tailscale as a trusted third party.** Funnel means Tailscale's ingress sees the TLS connection
   and, for `--tls-terminated-tcp`, terminates it. Tailscale *can* see the relayed media and the
   HTTPS traffic if they choose to. We accept this. If that is unacceptable, the answer is the VPS in
   §3.7 option 1, or the router port-forward in option 2 — not a tweak to this design.
5. **Metadata exposure.** The hostname `your-machine.your-tailnet.ts.net` is in Certificate
   Transparency logs the moment a certificate is issued. It is public, permanently, and enumerable.
   The security of this system therefore rests **entirely on the password**, not on the URL being
   secret. Anyone who tells you "nobody will find the URL" is wrong.
6. **Traffic analysis.** An observer can see that a video call happened, roughly how long it lasted,
   and how much data it moved. Contents are encrypted (DTLS-SRTP end to end between the browsers,
   even through the relay — coturn cannot decrypt the media).
7. **Denial of service.** No CDN, no WAF, no upstream scrubbing. Anyone who wants the frames offline
   for an afternoon can have that. The failure mode is benign: the tablets keep showing their
   service-worker-cached photos and the tailnet path keeps working even if the public ingress is
   being hammered.
8. **A malicious admin.** All three accounts are fully trusted. Any of them can delete every photo.
   There are no roles, no per-album permissions, no approval workflow, and no undo beyond Immich's
   own trash. This is a deliberate simplification.
9. **Account recovery.** There is no "forgot password" flow, no email, no SMS. A forgotten password
   is fixed by the operator running `hash-password.js` on the server and editing `admins.json`.
   Self-service recovery would add an email dependency and a whole new attack surface for a few
   users who can simply message the operator.
10. **Rate-limit state loss on restart.** Failure counters live in memory. A determined attacker who
    could force container restarts could reset them — but they cannot force restarts, so this is
    theoretical. Accepted for simplicity.
11. **Browser/OS compromise on any endpoint.** Out of scope.
12. **Immich's own web UI.** It stays tailnet-only and is not part of the public surface. Do not
    funnel it "just for convenience"; it has its own auth, its own session handling, and its own
    CVE stream, and none of that has been reviewed here.

### 4.3 Residual risk, ranked

1. A weak or reused password on one of the three accounts. **Highest risk by a wide margin.** Enforce
   12 characters, recommend passphrases, and keep the passwords in a password manager.
2. Tailscale account takeover (mitigate with 2FA).
3. An XSS in the client code we are about to write, defanged but not eliminated by the CSP.
4. A vulnerability in Immich reachable through the two proxy endpoints. They pass only a validated
   asset id (`/^[A-Za-z0-9_-]{8,64}$/`) and a bounded `limit`, so the exposed surface is thin.

### 4.4 A note on IP addresses

Because tailscaled proxies everything to `127.0.0.1:8080`, `req.socket.remoteAddress` is always
loopback. `x-forwarded-for` is set by tailscaled on proxied requests, but the app is not the origin of
that header and must treat it as a hint: it is used for rate-limit bucketing and nothing else. **No
authorization decision may depend on any IP address or on any request header other than `Cookie`,
`Authorization`, `Origin` and `X-Frameo-CSRF`.**

One header *is* trustworthy and is worth knowing about, even though we do not use it: `tailscale
serve` injects `Tailscale-User-Login` / `Tailscale-User-Name` on **tailnet** traffic only, never on
Funnel traffic, and tailscaled strips any client-supplied copy of those headers before forwarding —
so their presence is a genuine "this came from an authenticated tailnet member" signal, valid only
because the backend listens on loopback. We do not use it, because (a) the tablets reach us through
Funnel:443, where the header is absent by design, and (b) one auth mechanism is easier to get right
than two. An env flag `TRUST_TAILSCALE_IDENTITY_HEADER` may be defined, but it **defaults to
`false` and must ship as `false`.**

---

## 5. New environment variables

Documented in `server/.env.example`. If the two disagree, `.env.example` and the code win.

| Variable | Required | Example / default | Meaning |
|---|---|---|---|
| `PUBLIC_ORIGIN` | yes | `https://your-machine.your-tailnet.ts.net` | Canonical public origin. Used for the `Origin` check on the WebSocket upgrade, for the CSP `connect-src`, and to build the `turns:` URL. No trailing slash. |
| `EXTRA_ALLOWED_ORIGINS` | no | *(empty)* | Comma-separated extra origins accepted on the WS upgrade. Development only. Must be empty in production. |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` | HMAC key for session cookies, device cookies and rate-limit key hashing. Changing it logs everyone out and invalidates every device cookie. |
| `ADMINS_PATH` | no | `/config/admins.json` | Admin account file inside the container. |
| `SESSION_STORE_PATH` | no | `/data/sessions.json` | Where sessions are persisted across restarts. Mode 0600. |
| `SESSION_TTL_SECONDS` | no | `7776000` (90 d) | Sliding session lifetime. |
| `LOGIN_MAX_FAILURES` | no | `5` | Per-username failures before lockout. |
| `LOGIN_LOCKOUT_SECONDS` | no | `900` | Lockout duration and rate-limit window. |
| `TURN_STATIC_AUTH_SECRET` | yes | `openssl rand -hex 32` | Shared with coturn's `static-auth-secret`. Must match exactly. |
| `TURN_PUBLIC_URL` | yes | `turns:your-machine.your-tailnet.ts.net:10000?transport=tcp` | TURN URL handed to public clients. |
| `TURN_TAILNET_URL` | yes | `turn:100.x.y.z:3478?transport=udp` | TURN URL handed to tailnet devices. `TS_TAILNET_IP` substituted at deploy time. |
| `TURN_TTL_SECONDS` | no | `43200` (12 h) | Ephemeral credential lifetime. |
| `STUN_URLS` | no | `stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478` | Public STUN servers offered to public clients only. |
| `TS_TAILNET_IP` | yes | `100.x.y.z` from `tailscale ip -4` | coturn `listening-ip` / `relay-ip`, and the tailnet TURN URL. |
| `TRUST_TAILSCALE_IDENTITY_HEADER` | no | `false` | Must remain `false`. See §4.4. |

`BIND_ADDR` stays `0.0.0.0` **inside the container**; the container's port publish
(`127.0.0.1:8080:8080`) is what keeps it off the network. Do not "fix" this by changing `BIND_ADDR`
to `127.0.0.1` — that would break the container's own port mapping.

---

## 6. Deployment order

The full procedure is in `INSTALL.md` at the repo root. In outline, all steps are safe to re-run:

1. Create `~/frameo/config/admins.json` (0600) from `signalling/admins.example.json`, with hashes
   from `hash-password.js`. The server refuses a file that fails validation.
2. `render-turnserver-conf.sh` writes `~/frameo/config/turnserver.conf` with `TS_TAILNET_IP` and
   `TURN_STATIC_AUTH_SECRET` substituted from `.env`, mode 0600.
3. Start / restart `frameo-coturn` with `docker compose -f docker-compose.turn.yml up -d`
   (`deploy.sh` does not start it). Verify with
   `docker logs frameo-coturn 2>&1 | grep -i 'Listener opened'`.
4. Restart `frameo-signalling` with the new env (`deploy.sh`).
5. `expose-public.sh` removes the tailnet-only `serve` mapping on 443 and adds the two Funnel
   mappings (§1.3).
6. Verify, from a machine that is **not** on the tailnet (phone on mobile data is the correct test):
   * `https://your-machine.your-tailnet.ts.net/` returns the login page, not the app;
   * `https://your-machine.your-tailnet.ts.net/api/photos` returns `401`;
   * `https://your-machine.your-tailnet.ts.net/api/health` returns exactly `{"ok":true}`;
   * login succeeds, the `/admin/` app loads, `GET /api/turn-credentials` returns two `iceServers` entries;
   * a Trickle-ICE test against the `turns:` URL with the minted credential returns a `relay`
     candidate. (`https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`)
7. Worth adding to `healthcheck.sh` (it does not check these yet): funnel status contains both
   mappings; `frameo-coturn` is running; the sessions file is 0600.

The standing rules that survive the switch to Funnel: **never `tailscale cert`**, **never funnel
Immich**, and **never funnel any port other than 443 and 10000**.

---

## 7. Open items explicitly closed

* **Custom domain (`frame.example.com`)** — not possible with Funnel (§1.5). Closed.
* **Cloudflare Tunnel instead of Funnel** — rejected: adds a second vendor, a second account and a
  second TLS terminator, and Cloudflare's free tier forbids sustained non-HTML media proxying, which
  is precisely what the TURN relay does. Funnel's `--tls-terminated-tcp` has no equivalent there.
* **Putting the tablets behind the password too** — rejected: a grandparent must never see a login
  form, and the tablets are on the tailnet with a per-device token already.
* **A dual-listener design (public on 8080, tailnet-only on 8081) to distinguish the two paths by
  socket** — rejected: it forces the tablets onto a different URL and port, doubles the surface to
  test at 03:00, and buys only a trust signal we decided in §4.4 not to use.
* **Basic-auth instead of a login form** — rejected: no lockout, no logout, an ugly native dialog on
  every device, and no way to bind a session to a roster peer for the call log.
