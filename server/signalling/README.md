# Signalling server (WebRTC, plain P2P)

Serves the web client over HTTP and relays WebRTC signalling between exactly two peers over a
WebSocket on the **same port** (8080). There is no SFU in this process: audio and video go
peer-to-peer, falling back to the separate coturn relay when no direct path exists
(`../ARCHITECTURE-PUBLIC.md` §3). The server only carries SDP and ICE.

Sized for this project: at most **2 concurrent 1:1 calls**, a handful of peers, no database.

* Runtime dependency: `ws`. Nothing else.
* Call and presence state is in memory. A restart drops sockets; clients reconnect and re-register.
  On disk: the roster and admins files (input), the call log, the session store and the frame
  heartbeat file (output).
* Every inbound frame is parsed and dispatched inside `try/catch`. Malformed input is logged and
  ignored; it can never crash the process.

---

## 1. Files

| File                  | Purpose                                                        |
|-----------------------|----------------------------------------------------------------|
| `server.js`           | Static host, WebSocket signalling, control API, request gate     |
| `auth.js`, `scrypt.js` | Admin accounts, sessions, cookies, login rate limits (§10)      |
| `admin.js`, `immich.js`, `multipart.js` | Admin API: photo upload/delete, frame status, ring (§10.4) |
| `ice.js`              | STUN/TURN `iceServers` and ephemeral TURN credentials            |
| `weather.js`          | Optional weather reading for the frame's clock screen            |
| `hash-password.js`    | CLI that hashes an admin password (§10.6)                        |
| `package.json`        | Single dependency (`ws`), `npm start`                           |
| `Dockerfile`          | `node:22-alpine`, non-root                                      |
| `roster.example.json` | Template for the peer list + whitelist                          |
| `admins.example.json` | Template for the admin accounts                                 |
| `.env.example`        | Every environment variable, with the secrets marked             |

---

## 2. Configuration

All configuration is environment variables; see `.env.example` for the annotated list.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP **and** WebSocket |
| `BIND_ADDR` | `0.0.0.0` | inside the container; publish as `127.0.0.1:8080` on the host |
| `PUBLIC_DIR` | `./public` | static client files |
| `ROSTER_PATH` | `./roster.json` | **required** in production |
| `CONTROL_TOKEN` | *(unset)* | **secret**; without it the control API returns `503` |
| `CALL_LOG_PATH` | `./data/calls.jsonl` | JSONL audit trail |
| `WS_PATH` | `/ws` | WebSocket path |
| `RING_TIMEOUT_MS` | `45000` | unanswered ring becomes `missed` |
| `HEARTBEAT_INTERVAL_MS` | `30000` | ping/pong sweep; a peer that misses a round is dropped |
| `REGISTER_TIMEOUT_MS` | `10000` | a new socket must `register` within this window |
| `MAX_CONCURRENT_CALLS` | `2` | hard cap |
| `ROSTER_RELOAD_MS` | `15000` | mtime poll for hot reload; `0` disables (SIGHUP still works) |
| `IMMICH_URL` | `http://immich-server:2283` | Immich, over the internal `frameo` network |
| `IMMICH_API_KEY` | *(unset)* | **secret**; without it `/api/photos` returns an empty manifest |
| `IMMICH_ALBUM_IDS` | *(unset)* | comma-separated album ids; empty = newest images in the library |
| `PHOTO_LIMIT` | `300` | manifest size cap (matches the client's cache cap) |
| `PHOTO_MANIFEST_TTL_MS` | `300000` | how long the manifest is cached before Immich is re-asked |
| `WEATHER_LAT`, `WEATHER_LON` | *(unset)* | weather is **off** unless both are set; use the frame's location, not the server's |

Auth, admin, upload and TURN variables are listed in `.env.example` and described in §10 and
`../ARCHITECTURE-PUBLIC.md` §5.

---

## 3. Roster and the whitelist

`deploy.sh` seeds `~/frameo/config/roster.json` from `roster.example.json` on first deploy and
replaces every placeholder `authToken` with a random one. To write the file by hand instead, copy
`roster.example.json` to wherever `ROSTER_PATH` points and replace every `authToken`:

```bash
openssl rand -hex 24
```

```json
{
  "peers": [
    { "id": "frame-a", "displayName": "Bunicii A", "kind": "frame",
      "authToken": "…", "allowlist": ["family-ana", "family-ion"] },
    { "id": "family-ana", "displayName": "Ana", "kind": "family",
      "authToken": "…", "allowlist": ["frame-a"] }
  ]
}
```

* `kind` is `"frame"` (a tablet at the grandparents) or `"family"` (a phone/laptop).
* `authToken` must be at least 8 characters. It is the peer's WebSocket credential.
* The server refuses to start while any `authToken` still starts with `replace-me` (the
  placeholders in `roster.example.json`), because those values are public.
* One peer per person: a second socket registering the same id closes the first (§4), so two
  people sharing an id would knock each other offline.

### The rule the server enforces

```
A may call B   <=>   B ∈ A.allowlist   AND   A ∈ B.allowlist
```

Because the check is symmetric, **a frame can call exactly the peers in its own allowlist, and can
be called by exactly those same peers.** A missing or empty allowlist means the peer can neither
call nor be called.

This is enforced in one place — `canCall()` — which every call path goes through, including the
HTTP control API. The control token does **not** grant a whitelist bypass. The UI is never trusted:
even a client that fabricates a `call-request` for an arbitrary target is rejected, and the
rejection is written to both the process log (`call.rejected_by_allowlist`) and the call log with
the concrete reason (`callee-not-in-caller-allowlist` / `caller-not-in-callee-allowlist` /
`caller-not-in-roster` / `callee-not-in-roster` / `self-call`).

The roster is validated on load. A one-sided allowlist entry is legal but logged as
`roster.allowlist_asymmetric`, because it silently blocks calls in both directions. If the roster
is unreadable at startup the process exits `1`; if a **reload** fails, the previous roster is kept
and the error is logged.

Peers can be added or removed without a restart: edit the file (the mtime poll picks it up within
`ROSTER_RELOAD_MS`) or send `SIGHUP`.

---

## 4. WebSocket protocol

Connect to `ws://<host>:8080/ws`. Every frame is a JSON object with a string `type`. Maximum frame
size is 256 KB. `register` is the only message accepted before authentication; anything else gets
`{"type":"error","code":"not-registered"}`.

### Client → server

| Type | Payload | Meaning |
|---|---|---|
| `register` | `{ id, authToken }` | Authenticate. Replaces any previous socket for the same `id`. |
| `call-request` | `{ to }` | Ring another peer. Whitelist + busy checked server-side. |
| `call-accept` | `{ callId }` | Callee accepts. Only the callee may send this. |
| `call-decline` | `{ callId, reason? }` | Callee declines. Only the callee may send this. |
| `call-cancel` | `{ callId }` | Caller gives up while still ringing. Only the caller. |
| `offer` | `{ callId, sdp }` | SDP offer. Caller only, after `call-accepted`. |
| `answer` | `{ callId, sdp }` | SDP answer. Callee only. |
| `ice-candidate` | `{ callId, candidate }` | Trickle ICE. `candidate: null` = end of candidates. |
| `hangup` | `{ callId, reason? }` | End a ringing or connected call. Either side. |
| `heartbeat` | `{}` | Application-level keepalive; answered with `heartbeat-ack`. |

`sdp` may be a string or a full `RTCSessionDescription`-shaped object; it is relayed verbatim and
never parsed by the server.

### Server → client

| Type | Payload | When |
|---|---|---|
| `registered` | `{ id, displayName, kind, contacts[], serverTime, heartbeatIntervalMs }` | after successful `register`. `contacts` is the resolved, mutually-allowed call list with `online` / `busy` flags — the client should render only these. |
| `presence` | `{ id, displayName, kind, online, busy }` | a contact connected or disconnected |
| `incoming-call` | `{ callId, from, fromName, fromKind, origin, ringTimeoutMs }` | you are being called |
| `call-ringing` | `{ callId, to, toName, origin, ringTimeoutMs }` | your outgoing call is ringing |
| `call-accepted` | `{ callId, by, byName, role, shouldCreateOffer }` | both sides. **The peer with `shouldCreateOffer: true` (always the caller) creates the offer.** |
| `call-declined` | `{ callId, by, byName, reason }` | callee declined |
| `call-cancelled` | `{ callId, by, byName }` | caller cancelled while ringing |
| `offer` / `answer` | `{ callId, from, sdp }` | relayed SDP |
| `ice-candidate` | `{ callId, from, candidate }` | relayed candidate |
| `hangup` | `{ callId, by, byName, reason }` | the other side hung up |
| `call-ended` | `{ callId, outcome, reason, by, durationSeconds }` | authoritative end-of-call for your own bookkeeping |
| `call-failed` | `{ to, code, detail }` | your `call-request` was refused (`not-allowed`, `busy`, `callee-offline`, `server-busy`) |
| `heartbeat-ack` | `{ serverTime, callId }` | reply to `heartbeat` |
| `error` | `{ code, detail, … }` | protocol error (`auth-failed`, `bad-json`, `bad-message`, `not-registered`, `no-such-call`, `bad-state`, `bad-role`, `not-callee`, `not-caller`, `session-replaced`, `unknown-type`, `internal-error`) |

### Happy path

```
caller                     server                      callee
  |-- register ----------->|<---------- register ---------|
  |<-- registered ---------|----------- registered ------>|
  |-- call-request{to} --->| whitelist + busy check
  |<-- call-ringing -------|-- incoming-call ------------>|
  |                        |<---------- call-accept ------|
  |<-- call-accepted ------|-- call-accepted ------------>|
  |   (shouldCreateOffer)  |                              |
  |-- offer -------------->|-- offer -------------------->|
  |<-- answer -------------|<--------- answer ------------|
  |<-> ice-candidate ------|<-> ice-candidate ----------->|
  |======== media flows directly, peer to peer ==========|
  |-- hangup ------------->|-- hangup ------------------->|
```

### Edge cases the server handles

* **Reconnect** — registering again with the same `id` closes the old socket with code `4000`
  (`session-replaced`) and tears down any call it was in, because the underlying peer connection is
  gone. The other side receives `call-ended`.
* **Stale sockets** — a WebSocket ping goes out every `HEARTBEAT_INTERVAL_MS`; a socket that did
  not pong during the previous round is terminated and its peer removed.
* **Already in a call** — a `call-request` from or to a peer that is ringing or connected is
  refused with `call-failed{code:"busy"}`. This covers a second inbound call while ringing.
* **Capacity** — beyond `MAX_CONCURRENT_CALLS`, new calls get `code:"server-busy"`.
* **Unanswered** — after `RING_TIMEOUT_MS` the call is closed as `missed` and both sides are told.
* **Cross-call injection** — SDP and ICE are accepted only from a peer that is genuinely a party to
  the referenced `callId`, only in the right state, and only in the correct role (caller sends the
  offer, callee sends the answer).
* **Late ICE** — candidates for an already-ended call are dropped silently, not surfaced as errors.

---

## 5. HTTP API

### `GET /api/health`

Anonymous callers get exactly `{"ok":true}`. An authenticated principal (including
`Authorization: Bearer $CONTROL_TOKEN`) gets the full payload:

```json
{
  "status": "ok",
  "startedAt": "2026-01-01T10:00:00.000Z",
  "uptimeSeconds": 3600,
  "peers": { "connected": 3, "inRoster": 5, "list": [ { "id": "frame-a", "kind": "frame", "inCall": null } ] },
  "calls": { "active": 1, "ringing": 0, "max": 2, "list": [ { "callId": "c_…", "from": "…", "to": "…", "state": "active" } ] },
  "roster": { "path": "/config/roster.json", "loadedAt": "…" },
  "callLog": { "path": "/data/calls.jsonl", "writable": true },
  "controlApi": { "enabled": true },
  "memoryRssMb": 34
}
```

### `POST /api/call` — ring a frame from a script on the server

```bash
curl -s -X POST http://127.0.0.1:8080/api/call \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"from":"family-ana","to":"frame-a"}'
```

Rings `to` on behalf of `from`, exactly as if `from` had sent a `call-request` — same whitelist,
same busy rules. The ring reaches the frame as an `incoming-call` message on the frame's own
WebSocket; the server never calls into the tablet or its kiosk browser.

| Status | Meaning |
|---|---|
| `202` | `{"status":"ringing","callId":"c_…"}` |
| `400` | missing `from`/`to`, or unparseable body |
| `401` | missing or wrong bearer token |
| `403` | blocked by the whitelist |
| `409` | caller or callee offline, or busy |
| `503` | `CONTROL_TOKEN` unset, or the concurrent-call cap is reached |

### `GET /api/photos?limit=N` (device or admin) — the slideshow manifest

```json
{ "photos": [ { "id": "9f3c…", "url": "/api/photo/9f3c…" } ],
  "count": 300, "total": 300, "cachedAt": "…", "source": "albums", "error": null }
```

Newest first. Built from Immich (`IMMICH_ALBUM_IDS` if set, otherwise the newest images in the
library) and cached for `PHOTO_MANIFEST_TTL_MS`. If Immich is unreachable the **previous** manifest
is served with `error` set, because blanking the frames is worse than serving stale ids. With no
`IMMICH_API_KEY` the manifest is an empty list and HTTP 200 — never an error status, so the tablet
keeps showing its cached photos instead of falling into the fault screen.

### `GET /api/photo/<assetId>` (device or admin) — one preview image

Streams Immich's `size=preview` thumbnail through this origin, so the tablets hold no Immich
credentials and every photo URL is same-origin (which is what makes the service-worker cache work).
Asset ids are validated against `^[A-Za-z0-9_-]{8,64}$` before they are put in an upstream URL.

### `POST /api/hangup` — operational escape hatch

```bash
curl -s -X POST http://127.0.0.1:8080/api/hangup \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"callId":"c_…"}'      # or {"peer":"frame-a"}
```

Ends a stuck call remotely. Returns `200` with `{"status":"ended","callId":"…"}`, or `404` if there
is no matching active call.

---

## 6. Call audit log

Every call attempt appends one JSON object to `CALL_LOG_PATH` (and is echoed to stdout as
`call.record`, so `docker logs` has it too):

```json
{"ts":"2026-01-01T10:04:11.002Z","event":"call","callId":"c_9f…","from":"family-ana",
 "fromName":"Ana","fromKind":"family","to":"frame-a","toName":"Bunicii A",
 "toKind":"frame","origin":"peer","outcome":"accepted-ended","reason":"hangup",
 "endedBy":"family-ana","startedAt":"2026-01-01T10:03:48.771Z",
 "answeredAt":"2026-01-01T10:03:55.310Z","ringSeconds":7,"durationSeconds":16}
```

`origin` is `peer` or `control-api`. `outcome` is one of:

| Outcome | Meaning |
|---|---|
| `accepted-ended` | connected, then ended (see `durationSeconds`) |
| `declined` | callee declined |
| `missed` | rang until `RING_TIMEOUT_MS`, or the callee vanished while ringing |
| `cancelled` | caller hung up before it was answered |
| `busy` | one of the two was already in a call |
| `rejected` | blocked by the whitelist or the capacity cap — `reason` says which |
| `unreachable` | callee is not connected |
| `failed` | the peer disappeared mid-negotiation |

Useful one-liners:

```bash
tail -f ~/frameo/logs/calls.jsonl | jq -c '[.ts,.from,.to,.outcome,.durationSeconds]'
jq -r 'select(.outcome=="rejected") | [.ts,.from,.to,.reason] | @tsv' calls.jsonl   # whitelist denials
jq -r 'select(.outcome=="missed")   | [.ts,.from,.to]         | @tsv' calls.jsonl   # missed calls
```

The file only grows; rotate it with logrotate if it ever matters (it will not at this volume).

---

## 7. Running it

### Docker (how it is deployed)

The image is built from this directory. Compose is expected to supply:

* port publish `127.0.0.1:8080:8080`
* `./roster.json` mounted read-only at `/config/roster.json`
* a writable volume at `/data` for `calls.jsonl`
* the client bundle mounted at `/app/public`
* `CONTROL_TOKEN` from the stack `.env`
* a hard memory limit — this process idles around 40 MB RSS, so **128 MB is generous**; it must
  stay small so the server never enters memory pressure

The compose service uses `cgroup_parent: frame.slice` rather than any `/etc/docker/daemon.json`
change, so deploying never requires restarting the Docker daemon (which would also restart any
other containers on the server).

### Bare metal (for a quick test)

```bash
npm install
ROSTER_PATH=./roster.json \
CONTROL_TOKEN=$(openssl rand -hex 32) \
CALL_LOG_PATH=./data/calls.jsonl \
PUBLIC_DIR=./public \
PORT=8080 BIND_ADDR=127.0.0.1 \
npm start
```

---

## 8. Security notes

* **Transport.** There is no TLS in this process. Browsers restrict `getUserMedia` to secure
  contexts, so the client must be reached over HTTPS or via a `localhost`-equivalent origin.
  Tailscale Serve (tailnet only) or Funnel (public) terminates TLS in front of this port; the
  server deliberately stays plain HTTP on `127.0.0.1` behind it.
* **Auth.** Peer tokens come from the roster only (admin sessions: §10). Unknown id and wrong token return the *same*
  `auth-failed` error, so the roster cannot be enumerated. Token comparison is constant-time over
  SHA-256 digests. The control token is checked the same way.
* **Whitelist.** Enforced server-side on every path, control API included. See §3.
* **Static files.** Path traversal is blocked by resolving against `PUBLIC_DIR` and rejecting
  anything outside it; the SPA fallback is limited to top-level extension-less routes, so nested
  or extensioned misses return an honest `404`. Responses carry `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer`; HTML is served `no-cache` so tablets pick up client updates.
* **Container.** Runs as the unprivileged `node` user; only `/data` needs to be writable.

---

## 9. Behaviour tested

Exercised end-to-end against a live instance with three scripted peers: bad-token rejection,
register + resolved contact list, whitelist denial of an unlisted caller *and* of an unlisted
target, ring delivery, busy-while-ringing, accept with correct offer/answer roles, SDP and ICE
relay, wrong-role rejection, malformed JSON and unknown-call-id handling, health output during a
call, heartbeat ack, hangup, control API auth (401) and whitelist enforcement (403), control API
ring (202), decline, socket replacement on reconnect, static serving, traversal rejection, control
hangup, and no leaked call state afterwards. Zero errors logged; peers and calls both returned to
zero after disconnect.

---

## 10. Admin auth and the admin API

Contract: `../ARCHITECTURE-PUBLIC.md` §2. Modules: `auth.js`, `admin.js`, `immich.js`,
`multipart.js`, `scrypt.js`, `hash-password.js`.

### 10.1 Principals

| Principal | Credential | Established by |
|---|---|---|
| `admin` | username + scrypt password | `POST /api/auth/login` -> `frameo_sid` cookie |
| `device` | roster `authToken` | `?device=<id>&token=<tok>` on any URL -> `frameo_device` cookie, or the `register` message |
| `control` | `CONTROL_TOKEN` | `Authorization: Bearer` |

`REQUIRE_AUTH=true` (default) closes everything except: `GET /login`, `/login.css`, `/login.js`,
`/favicon.ico`, `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/frame-heartbeat`,
`POST /api/call`, `POST /api/hangup`, and a reduced `GET /api/health` that answers exactly
`{"ok":true}` to an anonymous caller. Everything else: `302 /login?next=…` for a browser,
`401 {"error":"unauthenticated"}` otherwise.

### 10.2 Auth endpoints

```
POST /api/auth/login          (alias POST /api/login)          PUBLIC, rate-limited
     content-type: application/json, body <= 1 KiB
     { "password": "...", "username": "ana" (optional), "label": "Ana iPhone" (optional) }
  200 { authenticated, username, displayName, peerId, csrfToken, expiresAt }
  401 { "error": "invalid-credentials" }        identical for unknown user and wrong password
  429 { "error": "rate-limited" } + Retry-After
  415 when the content-type is not application/json

  Omitting "username" is supported on purpose: the password alone is checked against every
  enabled account (at most 16), so the parents type one thing instead of two.

POST /api/auth/logout         (alias POST /api/logout)         admin, CSRF
POST /api/auth/logout-all                                      admin, CSRF
GET  /api/auth/session        (alias GET /api/session)         PUBLIC
  { authenticated: false, loginRequired: true, usernameOptional: true }
  { authenticated: true, kind: "admin"|"device"|"control", ... , csrfToken }
```

### 10.3 CSRF

Every non-GET request to `/api/admin/*` and `/api/auth/logout*` must send

```
X-Frameo-CSRF: <value of the frameo_csrf cookie>
```

The `frameo_csrf` cookie is deliberately readable by JavaScript; `frameo_sid` and
`frameo_device` are `HttpOnly`. Missing or mismatched -> `403 {"error":"csrf"}`.
Multipart uploads are not exempt: the header is what makes that endpoint safe.

### 10.4 Admin API

```
GET    /api/admin/albums
  { albums: [ { key: "a"|"b"|"all", id, name, count } ] }

GET    /api/admin/photos?album=<sel>&page=1&pageSize=60&refresh=0
  <sel> = a | b | all | both (a+b) | any (every album) | comma-separated keys. Default: every album.
  { ok, photos: [ { id, filename, date, favorite, albums: ["a","all"],
                    thumbnailUrl, previewUrl } ],
    page, pageSize, pageCount, total, albums, cachedAt, error }

POST   /api/admin/photos            multipart/form-data, CSRF
  Any number of file parts (field name is irrelevant; a `filename` in the part is what
  makes it a file). No 10-photo cap. Files are streamed to UPLOAD_TMP_DIR, then streamed
  on to Immich, then unlinked - nothing is buffered in memory.
  Optional text fields:
    album           one of the selectors above. Default: the "all" album, else every album.
    lastModified    epoch ms, sent IMMEDIATELY BEFORE a file part; becomes that asset's
                    fileCreatedAt. Multipart preserves order, so this pairs reliably.
  200 { ok, uploaded, failed, albums, albumResults,
        results: [ { filename, ok, assetId, duplicate, bytes } |
                   { filename, ok:false, error, detail, bytes } ] }
  Per-file failures never fail the request; 502 only when every file failed.
  HEIC/HEIF from iPhones is accepted. Immich generates the thumbnails (no ML container needed).

DELETE /api/admin/photos            JSON body, CSRF
POST   /api/admin/photos/delete     same, for clients that cannot send a body on DELETE
  { "ids": [uuid,...], "mode": "album"|"library", "album": "<sel>", "force": false }
  mode=album    -> removed from the selected album(s); the asset itself is untouched
  mode=library  -> DELETE /api/assets with force:false, i.e. moved to the IMMICH TRASH and
                   restorable from the Immich UI. force:true is permanent and is refused
                   unless ALLOW_PERMANENT_DELETE=true.
  Ids are validated as UUIDs; at most 1000 per request; batched 100 at a time upstream.

POST   /api/admin/call              { "to": "frame-a" }   CSRF
  Rings the frame AS the logged-in admin's roster peer. Goes through the same startCall()
  the WebSocket handler uses, so canCall() is enforced identically - the admin API grants
  no whitelist bypass. 202 ringing / 403 not-allowed / 409 busy|caller-offline / 503 at capacity.
  409 caller-offline means the phone has no live WebSocket yet, not that it lacks permission.

GET    /api/admin/frames
  { me: {...}, frames: [ { id, displayName, online, lastSeen, lastSeenSecondsAgo,
                           connectedForSeconds, inCall, call, battery, callable,
                           notCallableReason } ] }
```

`battery` is populated when a client reports it on `register` or `heartbeat`:

```json
{ "type": "heartbeat", "battery": { "level": 73, "charging": true } }
```

### 10.5 WebSocket authentication

The upgrade now performs, in order: path check, **mandatory `Origin` check** against
`PUBLIC_ORIGIN` (a missing `Origin` is allowed - non-browser clients do not send one), then
cookie parsing. `register` then accepts whichever of these applies:

| Cookie present at upgrade | `register` accepts |
|---|---|
| valid `frameo_sid` | `id` omitted, or `id === session.peerId`. `authToken` is neither needed nor consulted. |
| valid `frameo_device` | `id` omitted, or `id === <that roster id>` |
| neither | the original path: roster lookup + constant-time `authToken` compare |

The id must still resolve to a live roster entry in every case. Failure is always the same
generic `auth-failed`. Tablets using `?device=&token=` are completely unaffected.

The query string on the WebSocket URL is ignored on purpose - `tailscale serve`/`funnel` has an
open bug that strips it (tailscale/tailscale#18651), so no credential may ever live there.

### 10.6 Passwords

```bash
# interactive, echo off, asks twice
docker exec -it frameo-signalling node hash-password.js -u ion -d "Ion" -p family-ion
# non-interactive, from a password manager
printf '%s' "$PW" | docker exec -i frameo-signalling node hash-password.js -u ana -q
# tools/hash-password.js is a shim for the same CLI
docker exec -i frameo-signalling node tools/hash-password.js
```

scrypt, `N=32768, r=8, p=1, keylen=32`, `maxmem` passed explicitly (Node's 32 MiB default is
*just* below what these parameters need and throws `ERR_CRYPTO_INVALID_SCRYPT_PARAM` without
it). Minimum 12 characters, enforced by the CLI. The password is read from stdin, never argv.

### 10.7 Operational notes

* `admins.json` is hot-reloaded on mtime change. `"disabled": true` drops every live session for
  that account within `ACCOUNTS_RELOAD_MS` - that is the stolen-phone procedure and it needs no
  restart. A malformed file is refused and the previous good copy is kept.
* Sessions are mirrored to `SESSION_STORE_PATH` (mode 0600, atomic write, flushed on SIGTERM),
  so a container restart does not log everyone out.
* Rate-limit counters are in memory and reset on restart. Accepted; see ARCHITECTURE §4.2 item 10.
* If `SESSION_SECRET` is unset the server still boots and the gate stays CLOSED, using a random
  per-process secret; it logs `auth.session_secret_missing` as an error. Sessions then die on
  every restart. Set it.
* `GET /api/photo/<id>` gained an optional `?size=thumbnail`. No parameter still means `preview`,
  so every existing tablet URL is byte-for-byte unchanged. It is the one endpoint under `/api/`
  that is not `no-store`: it sends `Cache-Control: private, max-age=86400`, deliberately, because
  `no-store` there would destroy the frames' offline photo cache.
* `healthcheck.sh` must now send `Authorization: Bearer $CONTROL_TOKEN` to keep seeing the full
  health payload. Docker's own HEALTHCHECK only reads the status code and is unaffected.
