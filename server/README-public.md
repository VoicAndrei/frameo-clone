# README-public.md — public exposure and the TURN relay

How this stack becomes reachable from a phone on mobile data, how the video path works when a
direct connection is impossible, and how to take all of it back off the internet in one command.

Implements [`ARCHITECTURE-PUBLIC.md`](./ARCHITECTURE-PUBLIC.md) §1, §3 and §5. Where this document
and that one disagree, the disagreements are listed explicitly in
[§7 Deviations](#7-deviations-from-architecture-publicmd) below, with the reason and the evidence.

---

## 1. The shape of it

```
  phone, anywhere on the public internet                tablet at a grandparent's house
              │                                                      │  (tailnet node)
              │  https://your-machine.your-tailnet.ts.net/      │
              │  wss://…/ws                                          │
              ▼                                                      │
   ┌──────────────────────────┐                                      │
   │  Tailscale Funnel        │  TLS terminated here, with the       │
   │  ingress (443, 10000)    │  node's own Let's Encrypt cert       │
   └───────────┬──────────────┘                                      │
               │ plaintext, inside the tailnet tunnel                │
               ▼                                                     │
   ┌───────────────────────────────────────────────┐                 │
   │  the server                                   │                 │
   │                                               │                 │
   │  127.0.0.1:8080  frameo-signalling  ◄─────────┼─────────────────┘  tailnet path,
   │  127.0.0.1:3478  frameo-coturn                │                    no Funnel involved
   │  100.x.y.z:3478  frameo-coturn (tailnet)      │
   │  127.0.0.1:2283  immich-server  (NEVER funnelled)
   └───────────────────────────────────────────────┘
```

Two public entry points, and only two:

| Public endpoint | Terminated by | Backend | Carries |
|---|---|---|---|
| `https://your-machine.your-tailnet.ts.net/` (TCP 443) | tailscaled | `http://127.0.0.1:8080` | the web app, `/api/*`, `wss://…/ws` |
| `turns:your-machine.your-tailnet.ts.net:10000?transport=tcp` | tailscaled | `tcp://127.0.0.1:3478` | relayed WebRTC media |

Nothing else is published. Immich is on loopback and stays there; the only route to a photo is
through the signalling server's authenticated proxy endpoints.

### Why Funnel and not a port forward

The requirements are: works from any phone, on any network, with no Tailscale app on the family's
phones, and without touching the router. Funnel is the only option that satisfies all three. tailscaled already holds an auto-renewing Let's Encrypt certificate for the `ts.net` name
(that is why `tailscale cert` is banned in `README-ops.md` — it writes a certificate *once* and
never renews it). Funnel reuses exactly that certificate for both ports.

Funnel accepts **only ports 443, 8443 and 10000**. Other ports do not error; they hang. We use 443
and 10000 and keep 8443 as a spare.

---

## 2. How the video call actually connects

WebRTC tries three things, in this order, and stops at the first that works.

1. **Direct, over IPv6.** Many home ISPs hand out real IPv6 and most mobile networks have it. This is as
   good as a LAN call. Nothing in this document is involved.
2. **Direct, over IPv4, via STUN hole-punching.** Works when the mobile carrier's NAT is
   endpoint-independent. Mobile carrier CGNAT often is not, so treat this as a coin flip.
3. **Relayed through coturn.** The fallback. This is what the rest of this section is about.

The relay looks impossible at first glance: a TURN server has to hand out a *relayed address that
the far peer can reach*, and this host has no publicly reachable UDP at all. It works because the
far peer is always a tailnet node:

* The phone opens **one TLS connection** to `…ts.net:10000`. Funnel terminates the TLS and hands
  coturn a plain TURN-over-TCP session. All of the phone's media rides that single connection, in
  both directions. The phone never needs to reach the relay address itself.
* coturn allocates the relay socket on the **tailnet** address (`relay-ip=100.x.y.z`) and returns
  `100.x.y.z:<port>` as the relayed candidate.
* The tablet is a tailnet node, so `100.x.y.z:<port>` is directly routable for it over WireGuard
  (or DERP if both NATs are hostile). Connectivity checks pass and media flows.

So the relayed address only ever has to be reachable *by a tailnet member*, and it always is.

### Honest expectations for the relayed case

TURN over TCP is worse than TURN over UDP, and it is worth knowing how before someone reports "the
call was choppy":

* **Head-of-line blocking.** One lost packet stalls everything queued behind it, so a glitch shows
  up as freeze-then-catch-up rather than a graceful blur.
* **Useless retransmissions.** TCP will faithfully redeliver a video frame that is already too old
  to display, spending bandwidth to increase latency.
* **Extra hops.** phone → Tailscale ingress → this box → coturn → tailnet → tablet. Budget +40 to
  +90 ms one way, i.e. 150–250 ms mouth-to-ear. Conversational, with the occasional talk-over.
* **Funnel's undisclosed bandwidth limit** sits squarely in this path.

Which is why the client caps the phone's video at 600 kbps / 24 fps / 640×480 and prefers dropping
video over dropping audio. Do not raise those caps to "improve quality" — on the relayed path they
are what keeps the call usable at all.

If the relayed path turns out to be genuinely unusable in practice, there is exactly one good fix
and it is not clever: **a €4/month VPS running coturn with public UDP**
(`listening-ip=<vps ip>`, `external-ip=<vps ip>`, `turn:<vps>:3478?transport=udp`). Point
`TURN_PUBLIC_URL` at it and change nothing else. UDP relaying removes every problem in the list
above.

---

## 3. The files

| File | What it is |
|---|---|
| `expose-public.sh` | Configures both Funnel mappings, verifies them, prints the URLs. Idempotent. Also `--status` and `--off`. |
| `render-turnserver-conf.sh` | Substitutes the secrets from `.env` into `turnserver.conf` and writes `${FRAMEO_ROOT}/config/turnserver.conf` (0600). |
| `turnserver.conf` | The coturn config **template**, with `${…}` placeholders. Lives in git. Contains no secrets. |
| `docker-compose.turn.yml` | The `frameo-coturn` container: host networking, `frame.slice`, 128 MB, read-only root. |
| `signalling/ice.js` | Mints the short-lived TURN credentials and decides which ICE servers each caller gets. |

### `GET /api/ice`

Served by the signalling server; `GET /api/turn-credentials` is an alias for the same handler
(the first name is what the client calls, the second is the name in `ARCHITECTURE-PUBLIC.md` §3.5).

```
GET /api/ice
  auth: admin session cookie, or frameo_device cookie, or roster token
        (X-Frameo-Device + X-Frameo-Token headers, or ?device=&token=)

200 {
  "iceServers": [ … ],            // hand straight to new RTCPeerConnection({ iceServers })
  "iceTransportPolicy": "all",
  "ttl": 43200,
  "expiresAt": "2026-08-09T09:12:00.000Z",
  "profile": "public" | "tailnet",
  "principal": "family-ana"
}
401 {"error":"unauthenticated"}    // no valid principal — this endpoint never serves anonymously
503 {"error":"turn-not-configured"}// TURN_STATIC_AUTH_SECRET or a TURN URL is missing
```

The server decides which servers a caller gets; clients must never build the array themselves:

* **`profile: "public"`** (phones, admins) — public STUN first, then
  `turns:…:10000?transport=tcp`. STUN is what makes a *relay-free* call possible, so it is offered
  first and the relay is only the fallback.
* **`profile: "tailnet"`** (roster peers with `kind: "frame"`) — coturn on `100.x.y.z:3478` over
  UDP and TCP, and **no public STUN**. A frame's useful candidates are its tailnet and LAN
  addresses; a public STUN server would add nothing except a copy of the grandparents' home IP
  address sitting in someone else's logs.

Credentials are ephemeral, per the TURN REST scheme that coturn's `use-auth-secret` implements:

```
username = "<unix-expiry-seconds>:<roster-peer-id>"     e.g. "1786266393:family-ana"
password = base64( HMAC-SHA1( static-auth-secret, username ) )
```

TTL is 12 hours (`TURN_TTL_SECONDS`). coturn is never told about a client; it recomputes the same
HMAC and compares. A leaked credential expires on its own, and rotating
`TURN_STATIC_AUTH_SECRET` invalidates every outstanding one immediately.

The client should re-fetch when `expiresAt` is under 30 minutes away, and always immediately before
constructing an `RTCPeerConnection`. Never bake credentials into HTML.

> SHA-1 here is not a weakness. It is used inside an HMAC, not as a bare hash; the key is 32 random
> bytes; the output expires in hours. coturn implements no alternative for this scheme.

---

## 4. Turning it on

Run these in order, on the server, from `~/frameo/server`.

**Prerequisite that no script can do for you:** the tailnet policy file must grant the `funnel`
node attribute. Open <https://login.tailscale.com/admin/acls> and add:

```json
"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "attr":   ["funnel"]
  }
]
```

(Or use Access controls → Funnel → "Add Funnel to policy", which inserts exactly that.) Without it
every `tailscale funnel` command fails, and `--yes` does **not** help — that flag only suppresses
the interactive consent prompt, it grants nothing. `expose-public.sh` detects this failure and
prints the block above rather than leaving you to guess.

```bash
# 1. Secrets. Generate once, keep in a password manager, put in server/.env.
openssl rand -hex 32     # -> TURN_STATIC_AUTH_SECRET
openssl rand -hex 32     # -> SESSION_SECRET
tailscale ip -4          # -> TS_TAILNET_IP  (a 100.x address)

# 2. Render the coturn config from the template + .env.
./render-turnserver-conf.sh

# 3. Start coturn.
docker compose -f docker-compose.turn.yml up -d
docker logs frameo-coturn 2>&1 | grep -i 'listener opened'   # expect 127.0.0.1 and 100.x lines

# 4. Restart the signalling server so it picks up the TURN_* variables.
docker compose -f docker-compose.signalling.yml up -d

# 5. Go public.
./expose-public.sh
```

Step 5 replaces the tailnet-only `tailscale serve` mapping on 443 with a Funnel mapping, adds the
TLS-terminated TCP mapping on 10000, verifies both, and prints the URLs plus the exact `.env` lines
to copy. It refuses to publish port 10000 if nothing is listening on `127.0.0.1:3478`, because a
Funnel mapping to a dead port does not fail — it produces an endpoint that accepts TLS and then
hangs forever, which is the most confusing possible failure.

**The tablets need no reconfiguration.** Funnel on a port is Serve plus a public-ingress flag; the
same hostname still answers from inside the tailnet, and tablet traffic keeps taking the tailnet
path, so it does not consume Funnel bandwidth.

### Verifying, from a phone on mobile data

Not from home Wi-Fi, and not from a device with Tailscale installed — those take the tailnet path
and prove nothing.

1. `https://your-machine.your-tailnet.ts.net/` → the **login page**, not the photo app.
2. `…/api/photos` → `401`.
3. `…/api/health` → exactly `{"ok":true}`.
4. Log in, then `GET /api/ice` → two `iceServers` entries.
5. Paste the `turns:` URL with a freshly minted username/credential into the
   [Trickle-ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   and confirm a candidate of type **`relay`** appears. If only `srflx` appears, the credential or
   the 10000 mapping is wrong.
6. Place a real call and check the client's "relayed" indicator.

---

## 5. Turning it OFF again

```bash
./expose-public.sh --off
```

That removes both Funnel mappings **and restores `tailscale serve --bg --https=443`**, so the
tablets keep working over the tailnet. Restoring Serve is the important half: dropping Funnel
without it leaves the frames with no URL at all, which is a far worse outage than being publicly
reachable.

By hand, if the script is unavailable:

```bash
sudo tailscale funnel --https=443 http://127.0.0.1:8080 off
sudo tailscale funnel --tls-terminated-tcp=10000 tcp://127.0.0.1:3478 off
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080     # back to tailnet-only
```

`sudo tailscale funnel reset` clears every funnel mapping in one shot. It is the blunt version and
it does **not** restore Serve — run the third line afterwards.

To stop the relay as well:

```bash
docker compose -f docker-compose.turn.yml down
```

Only that one container stops. It shares no network, no volume and no dependency with the
signalling server, Immich, or anything else on the box.

**Never script a reset/re-enable loop.** Certificates are issued per `ts.net` name and Let's
Encrypt's rate limits are real: burning the issuance budget produces a ~34-hour window with no
certificate at all, which takes the *tablets* down too, since they use the same hostname. Configure
once, verify, stop touching it.

---

## 6. Security notes

**What is actually protecting the photos.** Not obscurity — the `ts.net` hostname is in
Certificate Transparency logs the moment a certificate is issued, so assume it is public and
indexed. The protection is the auth gate in front of every path except `/login`,
`POST /api/auth/login` and a stubbed `/api/health`. Everything else, including `/api/photos`,
`/api/photo/:id` and the WebSocket upgrade, requires a session cookie or a roster device token.

**TURN abuse is the interesting attack, and it is closed by two lines.** An open TURN server is a
free proxy and an internal port scanner. `turnserver.conf` denies **every** address in both
families and then allows back exactly `100.64.0.0/10`:

```conf
denied-peer-ip=0.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=100.64.0.0-100.127.255.255
```

coturn checks the allow-list first and returns "allowed" on a hit, then the deny-list, and defaults
to allowed for anything in neither (verified in `good_peer_addr()`, `src/server/ns_turn_server.c`).
That is why the deny ranges must be total: a deny-list of RFC1918 ranges alone — which is what
`ARCHITECTURE-PUBLIC.md` §3.4 spells out — would still leave the whole public internet reachable
through the relay. With the rules above, a stolen credential can relay to the tailnet and nowhere
else: not to the home LAN, not to `127.0.0.1:2283` where Immich lives, not to a third party.

Loopback peers are refused by coturn's own default (`allow-loopback-peers` is not set and must
never be), and multicast/broadcast peers by `no-multicast-peers`.

**coturn binds two addresses and only two.** `network_mode: host` means a default `0.0.0.0` bind
would put a TURN server on the home LAN. `listening-ip` names `127.0.0.1` (the Funnel target) and
the tailnet IP (the frames' path) explicitly. If the tailnet IP ever changes, coturn fails to bind
and restarts in a loop — noisy, but noisy in the correct direction.

**The telnet CLI is off.** coturn's admin CLI listens on `127.0.0.1:5766` **with an empty password**
by default, and with host networking that would be a real open port on the machine. `no-cli` is not
optional here.

**The config file must be readable by the container.** It is 0600 and owned by the deploy user,
and the container is pinned to `user: "${FRAMEO_UID}:${FRAMEO_GID}"` (the deploy user's uid/gid,
written into `.env` by `deploy.sh`) to match. This matters more than it looks: coturn does
not fail on an unreadable config — it logs "Cannot find config file" and starts **with its
defaults**, which is `0.0.0.0`, no authentication, and the CLI enabled. `render-turnserver-conf.sh`
warns loudly if the ownership is wrong.

**No source-IP trust anywhere.** Everything reaches the app from `127.0.0.1`, whether it came from
the tailnet or from the internet, so `req.socket.remoteAddress` carries no information and no
authorization decision may read it. `x-forwarded-for` is used for rate-limit bucketing only, and
only after being HMAC'd, so no raw IP lands in a log line.

**Secrets and logs.** `TURN_STATIC_AUTH_SECRET` appears in exactly two places: `server/.env` and
the rendered `${FRAMEO_ROOT}/config/turnserver.conf` (0600). It is never logged, never returned by
an API, and never passed on a command line — which is why `docker-compose.turn.yml` mounts a config
file instead of passing `--static-auth-secret=…` as an argument, where `ps` and `docker inspect`
would expose it to every user on the box. Minted TURN credentials are likewise never logged; the
*username* is (it is just an expiry and a roster id, and it is the audit trail we want in coturn's
own log). Never add `verbose` to `turnserver.conf`: it prints credentials.

**What this does not defend against**, stated plainly so nobody is surprised: a targeted attacker
who wants *this* family specifically will have better luck with a phishing email than with this
service; a compromise of the Tailscale account gives away the ingress, the certificate and the
tailnet, so **turn on 2FA for the Tailscale login** — that is the single highest-value thing you
can do outside this repository; and a weak password on one of the family accounts remains the
largest residual risk by a wide margin.

**Tailscale's terms.** Funnel traffic is subject to non-configurable, unpublished bandwidth limits,
and there is no SLA. If Tailscale throttles or disables the ingress, the tablets keep working over
the tailnet and only the phones stop — the correct failure ordering. A private, password-protected
family photo frame for a handful of people is squarely within the Acceptable Use Policy.

---

## 7. Deviations from `ARCHITECTURE-PUBLIC.md`

Everything here was verified against coturn 4.7.0's own sources and sample configuration before
being written. Four things in §3.4 do not survive that check.

| # | Architecture says | What ships | Why |
|---|---|---|---|
| 1 | `no-rfc5780`, `no-stun-backward-compatibility`, `response-origin-only-with-rfc5780` | omitted | In 4.7.0 the first is deprecated and parsed as a no-op (`case NO_RFC5780: break;`), the third likewise, and the second **does not exist** (the real flag is the positive `stun-backward-compatibility`). All three features are already off by default, so the security posture is identical. An unknown key in the config file is only a warning — which is precisely why it is worth removing: a warning logged forever is a warning people stop reading. |
| 2 | `denied-peer-ip=` the RFC1918/loopback/link-local/ULA ranges | deny **all** of both families, then allow back `100.64.0.0/10` | coturn defaults to *allowing* any address in neither list. The architecture's list would have left the entire public internet usable as a relay target — the exact abuse the section says it is preventing. |
| 3 | `max-bps=1500000`, described as "1.5 Mbit/s" | `max-bps=500000` | coturn's unit is **bytes** per second, per direction ("Max bytes-per-second bandwidth a TURN session is allowed to handle"). 1500000 would be 12 Mbit/s. 500000 B/s ≈ 4 Mbit/s is still ~6× what a capped 1:1 call uses, so it cannot degrade a real call. |
| 4 | coturn container on the external `frameo` network | `network_mode: host`, no networks block | §3.3 requires host networking so coturn can bind the tailnet IP for relay allocations, and Docker rejects `network_mode: host` combined with a network attachment. Nothing is lost: coturn talks to no other container. |

Two smaller additions, neither of which changes the design: the endpoint is reachable as both
`/api/ice` and `/api/turn-credentials`, and `render-turnserver-conf.sh` exists so that the
templated config in §3.4 has something that actually renders it, with validation that refuses to
write a config carrying an empty `static-auth-secret=`.

---

## 8. When something is broken

| Symptom | Look here |
|---|---|
| `tailscale funnel` says Funnel is not enabled | The ACL `nodeAttrs` block in §4. `--yes` does not grant it. |
| The public URL hangs, no certificate | First request also triggers issuance; wait a minute. Then `tailscale serve status`, and check that `127.0.0.1:8080` is actually listening. |
| Public URL works, calls never connect | `GET /api/ice` as a logged-in user. `503` means `TURN_STATIC_AUTH_SECRET` or a TURN URL is missing from the signalling container's env — the container needs a restart after an `.env` edit. |
| Trickle-ICE shows `srflx` but never `relay` | Wrong credential (the secret in `.env` must match the rendered `turnserver.conf` **exactly**), or 10000 is not funnelled: `./expose-public.sh --status`. |
| `relay` appears but media never flows | The relay candidate must be the `100.x` address. If it is `127.0.0.1`, `relay-ip` did not take — re-render and restart coturn. |
| coturn restart-loops | `docker logs frameo-coturn`. Usually the tailnet IP in the config no longer exists on the host (`tailscale ip -4`), or the config is unreadable by `FRAMEO_UID` (the deploy user). |
| coturn logs "A peer IP … denied in the range" | Expected and correct for any non-tailnet peer. If it names a `100.x` address, the `allowed-peer-ip` line is wrong. |
| Everything worked, then stopped after a reboot | `--bg` persists both mappings in tailscaled's state, so they should survive. `./expose-public.sh` is idempotent — just run it again. |
