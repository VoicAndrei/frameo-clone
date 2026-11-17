# Install

How to bring the whole stack up on your own server, from a fresh clone. Plan an evening for the
server and another hour per tablet ([docs/TABLET.md](docs/TABLET.md)).

Run everything as the user that should own the data (not root), on the server, unless a step says
otherwise. The examples use `your-machine.your-tailnet.ts.net` for the server's MagicDNS name.

Three rules that hold for every step:

* **Never** restart the Docker daemon, write `/etc/docker/daemon.json`, or run any `prune`. The
  stack is built to share a box with other services; `deploy.sh` only ever touches its own
  containers. If there is a neighbouring container you particularly care about, set
  `PROTECTED_CONTAINER=<name>` and `deploy.sh` fails loudly if it so much as restarts.
* **Never** publish a container port on `0.0.0.0`. Every port stays on `127.0.0.1`; `tailscaled`
  is the only ingress.
* Total container memory is budgeted at 3968m: immich 2048m + postgres 1024m + redis 256m +
  signalling 512m + coturn 128m. Changing any `mem_limit` means redoing this sum.

---

## 0. Requirements

* A Linux box that is on 24/7, with systemd and cgroup v2 (Ubuntu 24.04 is what this was built
  on), Docker with the Compose v2 plugin, `openssl`, `python3`, and about 4 GB of spare RAM.
  Your user must be in the `docker` group.
* A [Tailscale](https://tailscale.com) account. The server joins the tailnet; so do the tablets.
  Family phones do **not** need Tailscale: they reach the app through Funnel.
* One or two Android tablets that can be factory-reset (see [docs/TABLET.md](docs/TABLET.md)).

## 1. Get the code and join the tailnet

```bash
git clone https://github.com/VoicAndrei/frameo-clone.git ~/frameo
cd ~/frameo/server
chmod +x *.sh import-photos.js
```

Data, config and logs end up next to the code, in `~/frameo/{data,config,logs}` (all ignored by
git). To put them somewhere else, set `FRAMEO_ROOT` in your shell and in `.env`.

Install Tailscale on the server and bring it up (`sudo tailscale up`). In the
[admin console](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS
certificates**. Note the server's name (`tailscale status --self`) and tailnet IP
(`tailscale ip -4`).

## 2. Configuration (`.env`)

```bash
cd ~/frameo/server
cp -n .env.example .env
chmod 600 .env
sed -i -e "s#/home/youruser/frameo#$HOME/frameo#g" \
       -e "s#^FRAMEO_UID=.*#FRAMEO_UID=$(id -u)#" -e "s#^FRAMEO_GID=.*#FRAMEO_GID=$(id -g)#" .env
```

(If you skip this, `deploy.sh` creates `.env` from the template and fills those in for you.)

Generate the three secrets and append them. This does **not** overwrite existing lines: check the
file afterwards and delete any empty duplicates (the last one wins).

```bash
{
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  echo "CONTROL_TOKEN=$(openssl rand -hex 32)"
  echo "TURN_STATIC_AUTH_SECRET=$(openssl rand -hex 32)"
} >> .env
```

Then edit `.env` (`${EDITOR:-nano} .env`). Every variable is documented in the file. The ones
marked ⚠ fail silently when wrong:

| Variable | Value | Why |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://your-machine.your-tailnet.ts.net` | ⚠ No trailing slash. Feeds the WebSocket Origin check *and* the phones' TURN URL. Wrong ⇒ no video calls. |
| `TS_TAILNET_IP` | output of `tailscale ip -4` | ⚠ coturn binds this; the frames' TURN URL is derived from it. |
| `DB_PASSWORD` | a random string (`openssl rand -hex 24`) | Immich's Postgres password. |
| `COOKIE_SECURE` | `true` | |
| `REQUIRE_AUTH` | `true` | ⚠ Must be `true`. `false` + Funnel = your family photos on the open internet. |
| `EXTRA_ALLOWED_ORIGINS` | *(empty)* | ⚠ Must stay empty in production. |
| `WEATHER_LAT`, `WEATHER_LON` | the grandparents' town | Optional. Unset = no weather on the clock. |

The Immich values (`IMMICH_API_KEY`, `IMMICH_ALBUM_*`, `FRAME_ALBUM_MAP`) come in step 4.

Check that no key appears twice:

```bash
awk -F= '/^[A-Z_]+=/{print $1}' .env | sort | uniq -d   # must print NOTHING
```

## 3. First deploy

```bash
cd ~/frameo/server
./deploy.sh
```

Idempotent; safe to re-run. It creates `~/frameo/{config,logs,data}`, installs `frame.slice` (a
systemd slice that caps the stack's memory and CPU), creates the `frameo` Docker network, brings up
Immich and the signalling server, and configures a tailnet-only `tailscale serve` on 443. It
needs `sudo` for the slice and for `tailscale serve`.

On the first run it also writes `~/frameo/config/roster.json` from `roster.example.json`, with a
freshly generated token for every peer. The server refuses to start while any token is still a
`replace-me…` placeholder.

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'frameo|immich'
```

Expect `frameo-signalling`, `immich-server`, `immich-postgres` and `immich-redis` up. The frame
has no photos yet; that is the next step.

## 4. Immich: admin user, API key, albums

Immich is never exposed publicly. Reach its web UI through an SSH tunnel from your laptop:

```bash
ssh -L 2283:127.0.0.1:2283 you@your-machine.your-tailnet.ts.net
# then open http://localhost:2283 in the laptop's browser
```

1. Create the Immich admin account (first visit).
2. **Account settings → API keys → New API key.** Put it in `.env` as `IMMICH_API_KEY`.
3. Create three albums: one for each frame and one shared by both. The phone app labels them
   *Bunicii A*, *Bunicii B* and *Ambele*; the Immich names can be anything.

Get the album ids and put them in `.env`:

```bash
cd ~/frameo/server
set -a; . ./.env; set +a
curl -s -H "x-api-key: $IMMICH_API_KEY" http://127.0.0.1:2283/api/albums \
  | python3 -c 'import json,sys;[print(a["id"], a["albumName"]) for a in json.load(sys.stdin)]'
```

| Variable | Value |
|---|---|
| `IMMICH_ALBUM_A` | id of frame A's album |
| `IMMICH_ALBUM_B` | id of frame B's album |
| `IMMICH_ALBUM_ALL` | id of the shared album |
| `FRAME_ALBUM_MAP` | `frame-a:a,frame-b:b` ⚠ Without it both tablets show every album. |

With a single frame, leave `IMMICH_ALBUM_B` empty and use `FRAME_ALBUM_MAP=frame-a:a`.

Re-run `./deploy.sh` so the signalling server picks the values up.

## 5. Roster: who may call whom

`~/frameo/config/roster.json` is the whitelist the server enforces. The seeded file has two frames
(`frame-a`, `frame-b`) and three family members (`family-ana`, `family-ion`, `family-maria`) with
generated tokens. Edit the ids and display names to match your family; keep the tokens.

```bash
${EDITOR:-nano} ~/frameo/config/roster.json
python3 -m json.tool ~/frameo/config/roster.json >/dev/null && echo "roster JSON ok"
```

* **One peer per person, not per household.** The server allows one live connection per peer id;
  two phones sharing an id kick each other offline in a loop.
* **The allowlist is symmetric:** A may call B only if each is in the other's list. The server
  logs `roster.allowlist_asymmetric` for one-sided entries.
* If you rename a frame id, also update `FRAME_ALBUM_MAP` in `.env` and the `ALBUM_FRAMES` list
  near the top of `signalling/public/admin/app.js`.
* For a new peer, generate a token with `openssl rand -hex 24`.

The file is re-read within about 15 seconds of any change; no restart is needed.

## 6. Family accounts

Each family member logs in to the phone app with a username and passphrase. Pick passphrases of at
least 12 characters; four ordinary words are stronger than `Xk9!q` and easier to type on a phone.

The password is read from stdin, never from the command line, so it doesn't land in shell
history:

```bash
docker exec -i frameo-signalling node hash-password.js -u ana   -d 'Ana'   -p family-ana   --json
docker exec -i frameo-signalling node hash-password.js -u ion   -d 'Ion'   -p family-ion   --json
docker exec -i frameo-signalling node hash-password.js -u maria -d 'Maria' -p family-maria --json
```

Put the JSON objects into `~/frameo/config/admins.json`:

```json
{"accounts":[
  { …ana… },
  { …ion… },
  { …maria… }
]}
```

```bash
chmod 600 ~/frameo/config/admins.json
python3 -m json.tool ~/frameo/config/admins.json >/dev/null && echo "admins JSON ok"
```

`peerId` must match a `family-*` peer from step 5, and no two enabled accounts may share one (the
server logs `auth.accounts_share_peer_id` if they do). The file is hot-reloaded: setting
`"disabled": true` ends every session of that account within 15 s, which is the "phone was stolen"
procedure.

The login screen shows one button per family member. The server deliberately does not list
usernames, so the buttons come from `DEFAULT_ACCOUNTS` near the top of
`signalling/public/admin/app.js`: change it to your usernames and labels and re-run `./deploy.sh`.
The *Altcineva* ("someone else") button lets anyone type a username instead.

## 7. Seed the photos (optional)

Copy some photos to the server and import them into the shared album, so both frames have
something to show from day one:

```bash
# from your laptop
rsync -av ~/Pictures/family/ you@your-machine.your-tailnet.ts.net:~/frameo/photos-seed/

# on the server
cd ~/frameo/server
./import-photos.js ~/frameo/photos-seed --album "<name of the shared album>" --dry-run
./import-photos.js ~/frameo/photos-seed --album "<name of the shared album>"
```

Duplicates are detected by content hash, so re-running is free. See
[server/README-import.md](server/README-import.md).

## 8. coturn (the relay that makes calls work over mobile data)

```bash
cd ~/frameo/server
./render-turnserver-conf.sh
docker compose -f docker-compose.turn.yml up -d
docker logs --tail 40 frameo-coturn
```

`render-turnserver-conf.sh` refuses to write a config that would weaken the server (missing or
short secret, non-tailnet IP, leftover placeholders).

⚠ Check the log says it loaded `/config/turnserver.conf` and listens on `127.0.0.1:3478` and on the
tailnet IP. coturn does **not** fail on an unreadable config: it logs "Cannot find config file" and
starts with its defaults (`0.0.0.0`, no authentication). The container runs as `FRAMEO_UID`, so the
file must belong to your user (`ls -l ~/frameo/config/turnserver.conf`).

```bash
docker logs frameo-coturn 2>&1 | grep -Ei 'cannot find|config file|listener|relay addr' | head -20
```

## 9. Allow Funnel and open the public ingress

Funnel needs a node attribute that only a tailnet admin can grant. In the
[access controls](https://login.tailscale.com/admin/acls), add:

```json
"nodeAttrs": [
  { "target": ["your-machine.your-tailnet.ts.net"], "attr": ["funnel"] }
]
```

Then:

```bash
cd ~/frameo/server
./expose-public.sh
```

This publishes:

* `https://your-machine.your-tailnet.ts.net` (port 443) → the web app on `127.0.0.1:8080`
* port 10000 (TLS-terminated TCP) → coturn on `127.0.0.1:3478`

Funnel only allows ports 443, 8443 and 10000, which is why TURN is on 10000. tailscaled terminates
TLS with its own auto-renewing Let's Encrypt certificate. No router port-forwarding is involved.

```bash
tailscale funnel status
curl -s -o /dev/null -w '%{http_code}\n' https://your-machine.your-tailnet.ts.net/api/health
```

To go back to tailnet-only at any time: `./expose-public.sh --off`.

## 10. Verify

```bash
cd ~/frameo/server
./healthcheck.sh
```

And the checks that catch the usual configuration mistakes:

```bash
# (a) No configuration errors at boot. Any hit here is a real problem.
docker logs frameo-signalling 2>&1 | grep -E \
 'accounts_share_peer_id|allowlist_asymmetric|session_secret_missing|gate_disabled|no_per_frame_map|frame_map_|public_origin_missing|account_peer_unknown|trust_tailscale_header'

# (b) Which albums each frame will show, and that TURN is armed.
set -a; . ./.env; set +a
curl -s -H "authorization: Bearer $CONTROL_TOKEN" http://127.0.0.1:8080/api/health | python3 -m json.tool
#   turn.enabled, publicTurn and tailnetTurn must be true; rejectedUrls 0.

# (c) Nothing listens on a public interface except tailscaled.
sudo ss -tlnp | grep -E ':8080|:2283|:3478'
#   8080 and 2283 must show 127.0.0.1 only. 3478 shows 127.0.0.1 and the 100.x tailnet IP.

# (d) The gate is closed from the public internet.
curl -s -o /dev/null -w 'anonymous / -> %{http_code}\n' https://your-machine.your-tailnet.ts.net/
#   Expect 302 or 401. NEVER 200 with the app HTML.
curl -s -H 'accept: application/json' https://your-machine.your-tailnet.ts.net/api/admin/photos
#   Expect {"error":"unauthenticated"}.
```

## 11. The family's phones

Send everyone the same link:

```
https://your-machine.your-tailnet.ts.net/admin/
```

They log in with the username and passphrase from step 6, then use **Share → Add to Home Screen**
so it opens as an app. On each phone, check:

1. **Poze** (photos): the photos appear and the album tabs work.
2. **Incarca** (upload): pick several photos, choose a frame, and they appear under **Poze**.
3. **Apel video** (video call): press **Suna**, the tablet rings, answer it. The browser asks for
   camera and microphone permission once per phone, and it must be allowed; a refusal is silent
   afterwards.

## 12. The tablets

See [docs/TABLET.md](docs/TABLET.md). Each frame loads one URL:

```
https://your-machine.your-tailnet.ts.net/?device=frame-a&token=<frame-a's token from roster.json>
```

## 13. Optional: get told when a frame goes offline

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * ALERT_URL=https://ntfy.sh/<your-private-topic> $HOME/frameo/server/frame-heartbeat-alert.sh") | crontab -
```

The tablets report a heartbeat once a minute over the public URL (see
[server/tablet/README-watchdog.md](server/tablet/README-watchdog.md)), so the alert can tell
"tablet switched off" apart from "tablet fine, but its Tailscale didn't come back after a reboot".
Without `ALERT_URL` the script only prints.

---

## Rollback

```bash
cd ~/frameo/server
./expose-public.sh --off                                # public ingress off, tailnet still works
docker compose -f docker-compose.turn.yml down          # coturn only
docker compose -f docker-compose.signalling.yml restart
```

Never `docker compose down --remove-orphans`, never any `prune`, never `systemctl restart docker`.

## Quick reference

| Thing | Where |
|---|---|
| Phone app | `https://your-machine.your-tailnet.ts.net/admin/` |
| Frame URL | `https://your-machine.your-tailnet.ts.net/?device=<id>&token=<token>` |
| Immich | `http://127.0.0.1:2283` (SSH tunnel only, never funnelled) |
| Roster / accounts | `~/frameo/config/{roster.json,admins.json}` (hot-reloaded) |
| Call log | `~/frameo/logs/calls.jsonl` |
| Frame liveness | `~/frameo/logs/frame-heartbeats.json` |
| Logs | `docker logs -f frameo-signalling` / `frameo-coturn` |
| Day-to-day operations | [server/README-ops.md](server/README-ops.md) |
| Security design | [server/ARCHITECTURE-PUBLIC.md](server/ARCHITECTURE-PUBLIC.md) |
