# Operator runbook — self-hosted Frameo replacement

Day-to-day operation of the server side: what runs, where it lives, how to update, back up and
debug it. First-time installation is in [`INSTALL.md`](../INSTALL.md); tablet setup is in
[`docs/TABLET.md`](../docs/TABLET.md).

Conventions used below: the project lives in **`~/frameo`** of the deploy user (the user that ran
`deploy.sh`; override with `FRAMEO_USER` / `FRAMEO_ROOT`), and the server's MagicDNS name is
**`your-machine.your-tailnet.ts.net`**. Requirements: a 24/7 Linux box with systemd, cgroup v2,
Docker with Compose v2, and Tailscale. 16 GB RAM is plenty; the whole stack is capped at ~4 GB.

> Read [Things to avoid on the server](#things-to-avoid-on-the-server) before you change anything.
> The stack is built to share the box with other services you care about, and most of the rules
> below exist to keep it that way.

---

## 1. What is running

| Component | Container | Host port | Purpose |
|---|---|---|---|
| Signalling + web apps | `frameo-signalling` | `127.0.0.1:8080` | WebSocket signalling, roster enforcement, ringing, the frame page, the family admin PWA, the Immich photo proxy |
| Immich server | `immich-server` | `127.0.0.1:2283` | Photo library and albums |
| Immich Postgres | `immich-postgres` | — | Immich database |
| Immich Redis (Valkey) | `immich-redis` | — | Immich job queue |
| TURN relay | `frameo-coturn` | `127.0.0.1:3478` + tailnet IP `:3478` (host networking) | Fallback media relay for calls; see [`README-public.md`](./README-public.md) |
| TLS front door | *(none — `tailscaled`)* | `:443` (and `:10000` when public) | `tailscale serve` (tailnet only) or `tailscale funnel` (public) terminates HTTPS and proxies to `127.0.0.1:8080` |

All containers sit inside the systemd slice **`frame.slice`**; all except coturn are on the
external Docker network **`frameo`**. Call media is **peer-to-peer** whenever ICE finds a direct
path, so a call normally costs this box almost nothing; only relayed calls pass through coturn.

**URL the tablets load:** `https://your-machine.your-tailnet.ts.net/`

---

## 2. Files and where things live

### Deployment directory — `~/frameo/server`

| File | Purpose |
|---|---|
| `frame.slice` | systemd slice: the resource cage for this whole project |
| `docker-compose.signalling.yml` | The signalling server + web apps |
| `docker-compose.immich.yml` | Immich (server + postgres + redis, **no** machine-learning container) |
| `docker-compose.turn.yml` | coturn |
| `deploy.sh` | Idempotent deploy. Safe to re-run any time |
| `healthcheck.sh` | Read-only verification of every component. Exit 0 = all good |
| `expose-public.sh` | Turns public access (Tailscale Funnel) on, off, or reports status |
| `frame-heartbeat-alert.sh` | Cron job: alerts when a tablet stops reporting in |
| `import-photos.js` | Bulk import of a folder into Immich; see [`README-import.md`](./README-import.md) |
| `.env.example` | Template for `.env`. Never commit the real `.env` |
| `.env` | Real secrets, mode `0600`. Created by `deploy.sh` from the template |
| `signalling/` | Node source + `Dockerfile` + `public/` (the web apps) |
| `README-immich.md` | Immich-specific notes (albums, upgrades, moving the library) |
| `README-public.md` | Public exposure and the TURN relay |

### Data — `~/frameo`

| Path | What | Back up? |
|---|---|---|
| `data/immich/` | **The photo and video library.** Originals, thumbnails, encoded video. This is the irreplaceable part | **Yes** |
| `data/postgres/` | Immich Postgres data directory: albums, metadata | **Yes** (dump, see §5) |
| `config/roster.json` | The family whitelist: peer ids, display names, auth tokens, who may call whom. Each tablet is provisioned with one of these ids + its `authToken` | **Yes** |
| `config/admins.json` | Family accounts for the admin PWA (scrypt hashes) | **Yes** |
| `config/turnserver.conf` | Rendered coturn config (contains the TURN secret) | No — regenerated from `.env` |
| `logs/calls.jsonl` | Append-only JSONL audit trail of every call | Optional |
| `logs/sessions.json`, `logs/frame-heartbeats.json` | Login sessions, last tablet heartbeat | No |
| `server/.env` | DB password, `CONTROL_TOKEN`, TURN and session secrets | **Yes** (secrets!) |

Everything is owned by the deploy user. `config/` is mode `0750`; `.env`, `roster.json` and
`turnserver.conf` are `0640` or tighter because they contain secrets.

---

## 3. Day-to-day operations

### Deploy / update everything

```bash
cd ~/frameo/server
./deploy.sh
```

`deploy.sh` is idempotent: it checks the desired state of every step and does nothing if it is
already satisfied. It records the Docker daemon's PID before it starts and re-checks it on every
exit path, including failures and Ctrl-C. If the box runs another container that must not be
disturbed, name it:

```bash
PROTECTED_CONTAINER=<name> ./deploy.sh
```

That container's id, PID and start time are then snapshotted too. If either it or the daemon
changed in any way, the script exits **90** with a red banner. If the protected container is not
running at the start, the deploy refuses to proceed unless you set `ALLOW_PROTECTED_DOWN=1`.

### Start / stop / restart individual pieces

```bash
cd ~/frameo/server

# Signalling
docker compose -f docker-compose.signalling.yml up -d          # start / apply config changes
docker compose -f docker-compose.signalling.yml up -d --build  # after editing signalling/*.js
docker restart frameo-signalling                               # plain bounce
docker compose -f docker-compose.signalling.yml stop           # stop, keep the container

# Immich
docker compose -f docker-compose.immich.yml up -d
docker compose -f docker-compose.immich.yml stop

# TURN
docker compose -f docker-compose.turn.yml up -d
```

**Do not** use `docker compose down --remove-orphans`. Plain `down` on one of these stacks is
survivable (the `frameo` network is declared `external`, so it will not be deleted), but
`--remove-orphans` can reach containers outside the stack.

### Update the roster (add or remove a family member)

```bash
openssl rand -hex 24                                    # generate that peer's authToken
${EDITOR:-nano} ~/frameo/config/roster.json
```

On first deploy `deploy.sh` seeds this file from `signalling/roster.example.json` and replaces every
placeholder token with a random one. The server refuses to start while any `authToken` still starts
with `replace-me`.

The server polls the file's mtime every 15 s (`ROSTER_RELOAD_MS`) and reloads it in place — **no
restart needed**. If the new file is invalid it keeps the previous roster and logs
`roster.reload_failed_keeping_previous`; check with `docker logs frameo-signalling`.

Whitelisting is symmetric and enforced server-side: *A may call B* only if B is in A's `allowlist`
**and** A is in B's. One-sided entries are logged as warnings and do not work.

### Provision a tablet (once per device)

All tablets load the same page, so each one is told who it is through its kiosk URL:

```
https://your-machine.your-tailnet.ts.net/?device=frame-a&token=<that peer's authToken>
```

`device` must be an `id` from `roster.json` and `token` its `authToken`. Both are stored in the
tablet's `localStorage` on first load. A tablet with no identity cannot fetch photos and never
opens the signalling socket, so it cannot ring and cannot be rung. The full tablet setup (kiosk
browser, Tailscale, watchdog) is in [`docs/TABLET.md`](../docs/TABLET.md).

### Point the frames at photos

The tablets never talk to Immich. They fetch `/api/photos` and `/api/photo/<id>` from the
signalling server, which proxies Immich over the internal `frameo` network. That needs two values
in `server/.env`:

```bash
# Immich -> Account Settings -> API Keys -> New API Key
IMMICH_API_KEY=...
# Album id(s), copied out of the album URL. Empty = newest images in the whole library.
IMMICH_ALBUM_IDS=<album-id>[,<album-id>]
```

then `docker compose -f docker-compose.signalling.yml up -d`. Check it with `./healthcheck.sh` (the
**photo feed** row), or by hand:

```bash
CONTROL_TOKEN=$(sed -n 's/^CONTROL_TOKEN=//p' ~/frameo/server/.env)
curl -s -H "Authorization: Bearer $CONTROL_TOKEN" 'http://127.0.0.1:8080/api/photos?limit=1' | jq
```

`total` must be non-zero and `error` must be `null`. `/api/photos` requires a credential, so an
anonymous request gets `401`. Until this is set the frames have nothing to show and fall back to
the "Rama se repara singura" screen.

Which album each frame shows is set with `FRAME_ALBUM_MAP` and `IMMICH_ALBUM_A` / `_B` / `_ALL`
(see the comments in `docker-compose.signalling.yml`).

### Weather on the frame

Off unless both `WEATHER_LAT` and `WEATHER_LON` are set in `.env`. Use the coordinates of the town
where the frames are, not the server's.

### Update Immich

Immich runs irreversible database migrations on the first start of a new version.

1. Read the release notes for breaking changes.
2. **Back up first** (§5) — especially `data/postgres`.
3. Bump `IMMICH_VERSION` in `.env`.
4. `docker compose -f docker-compose.immich.yml pull && docker compose -f docker-compose.immich.yml up -d`
5. Never roll the tag backwards afterwards.

### Health and alerting

```bash
cd ~/frameo/server && ./healthcheck.sh
```

Prints a PASS/FAIL table and exits non-zero if anything failed. Wire it to any ntfy-style endpoint
you control:

```cron
*/5 * * * * ~/frameo/server/healthcheck.sh >/tmp/frameo-health.txt 2>&1 \
  || curl -s -H 'Title: Frameo stack unhealthy' -d @/tmp/frameo-health.txt https://ntfy.sh/<your-private-topic>
```

`frame-heartbeat-alert.sh` does the same for the tablets: each tablet's watchdog posts a heartbeat
once a minute, and the script reports frames that have gone quiet. It only prints unless you set
`ALERT_URL`; there is no default.

---

## 4. Reading logs

```bash
# Application logs (json-file driver, capped at 3 x 10 MB per container)
docker logs -f --tail 200 frameo-signalling
docker logs -f --tail 200 immich-server
docker logs -f --tail 200 frameo-coturn

# The call audit trail (one JSON object per line)
tail -f ~/frameo/logs/calls.jsonl
tail -n 200 ~/frameo/logs/calls.jsonl | jq -r '[.ts,.event,.from,.to,.state] | @tsv'

# Live signalling state: who is connected, what calls are up.
# Anonymous callers only get {"ok":true}; the full body needs a credential.
CONTROL_TOKEN=$(sed -n 's/^CONTROL_TOKEN=//p' ~/frameo/server/.env)
curl -s -H "Authorization: Bearer $CONTROL_TOKEN" http://127.0.0.1:8080/api/health | jq

# The resource cage
systemctl status frame.slice
systemd-cgls /frame.slice                     # tree of everything inside it
systemd-cgtop -M frame.slice                  # live CPU/mem/IO for the slice
cat /sys/fs/cgroup/frame.slice/memory.pressure  # PSI: is it being squeezed?
journalctl -u frame.slice --since '1 hour ago'

# Tailscale
tailscale serve status
tailscale funnel status
tailscale status
journalctl -u tailscaled --since '1 hour ago'
```

---

## 5. Backups — restic to a USB drive

Only the irreplaceable data is worth backing up: the photo library, the Immich database, the
config directory and `.env`. Container images are reproducible.

### One-time setup

```bash
sudo apt install -y restic
lsblk -f                                      # find the USB drive
sudo mkdir -p /mnt/frameo-backup
sudo mount /dev/sdX1 /mnt/frameo-backup       # substitute the real device
sudo chown "$USER:$USER" /mnt/frameo-backup

# Repository password: store it in a root-readable file, not in your shell history
printf '%s\n' 'a-long-random-passphrase' | sudo tee /root/.frameo-restic-pass >/dev/null
sudo chmod 600 /root/.frameo-restic-pass

export RESTIC_REPOSITORY=/mnt/frameo-backup/restic
export RESTIC_PASSWORD_FILE=/root/.frameo-restic-pass
restic init
```

**Write the passphrase down somewhere physical.** A restic repository without its password is
indistinguishable from random noise; there is no recovery path.

### The backup run

Postgres must be dumped, not copied — copying a live data directory yields a corrupt database.

```bash
#!/usr/bin/env bash
# ~/frameo/server/backup.sh   (create this, chmod +x)
set -euo pipefail
export RESTIC_REPOSITORY=/mnt/frameo-backup/restic
export RESTIC_PASSWORD_FILE=/root/.frameo-restic-pass
STAGE=~/frameo/data/_dump
mkdir -p "$STAGE"

# Consistent logical dump of the Immich database.
docker exec immich-postgres pg_dumpall --clean --if-exists -U postgres \
  | gzip > "$STAGE/immich-db.sql.gz"

restic backup \
  ~/frameo/data/immich \
  ~/frameo/config \
  ~/frameo/server/.env \
  "$STAGE/immich-db.sql.gz" \
  --tag frameo --exclude-caches

restic forget --tag frameo --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
restic check --read-data-subset=5%          # cheap ongoing integrity sampling
```

Schedule it while nobody is calling:

```cron
30 3 * * * ~/frameo/server/backup.sh >> ~/frameo/logs/backup.log 2>&1
```

To run it under the `frame.slice` budget, so a backup cannot starve the rest of the machine:

```bash
sudo systemd-run --slice=frame.slice --unit=frameo-backup --wait ~/frameo/server/backup.sh
```

### Restore

```bash
restic snapshots --tag frameo
restic restore <snapshot-id> --target ~/frameo/restore-test   # ALWAYS to a scratch dir first
zcat ~/frameo/restore-test/.../immich-db.sql.gz \
  | docker exec -i immich-postgres psql -U postgres
```

**Test the restore twice a year.** A backup you have never restored is a hypothesis, not a backup.
Unmount or physically disconnect the USB drive between runs when you can — a permanently mounted
backup drive is inside the blast radius of anything that deletes files on this host.

---

## 6. Memory limits — what each one is and why

The box may run other services you care about, and those may be plain user processes rather than
systemd units, so they cannot be given `MemoryMin=` or `OOMScoreAdjust=` protection of their own.
The protection that always works is the inverse: **cap this stack hard enough that the machine
never enters memory pressure because of it.**

### The budget

| Scope | Limit | Kind | Why this number |
|---|---|---|---|
| `frame.slice` | `MemoryHigh=4G` | soft (throttle) | The limit that should normally bite. Crossing it triggers aggressive reclaim, not kills — the photo stack degrades instead of dying |
| `frame.slice` | `MemoryMax=5G` | hard (OOM) | Absolute ceiling. The in-cgroup OOM killer fires here and can only kill processes in this stack. 1 G of headroom above `MemoryHigh` absorbs a burst such as a large video import |
| `frame.slice` | `MemorySwapMax=0` | hard | Swapping these containers would cause disk I/O and stalls that hurt the whole machine more than simply reclaiming would |
| `frame.slice` | `TasksMax=4096` | hard | A fork bomb in a container exhausts this budget and gets `EAGAIN`, instead of exhausting the machine's PID space |
| `frame.slice` | `CPUWeight=50`, `IOWeight=50` | relative | Half the default share of 100 **only under contention**. On an idle box nothing is throttled at all |
| `immich-server` | `2g` | hard | Immich's own recommendation with machine learning disabled. Thumbnail and video transcode jobs are the peak |
| `immich-postgres` | `1g` | hard | Comfortable for a family-sized library; leaves room for `shared_buffers` plus a vacuum |
| `immich-redis` | `256m` | hard | It is a job queue, not a cache of anything large |
| `frameo-signalling` | `512m` | hard | Idles at 60–80 MB; all state is in memory but the state is tiny (a handful of peers, max 2 calls) |
| `frameo-coturn` | `128m` | hard | Idles at ~10 MB; a relayed 1:1 call adds almost nothing |
| **Sum of containers** | **3968m** | | Under the 4 G slice soft limit, and never above 5 G even in the worst case |

`systemd-oomd` is also told (`ManagedOOMMemoryPressure=kill`) to pick **this slice** as the victim
under sustained pressure, so these services are killed before the machine ever has to make a
global decision.

### Changing a limit

```bash
${EDITOR:-nano} ~/frameo/server/frame.slice
sudo install -m 0644 -o root -g root ~/frameo/server/frame.slice /etc/systemd/system/frame.slice
sudo systemctl daemon-reload            # re-applies live, stops nothing
```

Temporary, non-persistent tweak: `sudo systemctl set-property --runtime frame.slice MemoryHigh=3G`.

Container limits live in the compose files; change one and re-run
`docker compose -f <file> up -d` (the container is recreated, which is expected and safe). Re-check
the sum against the slice when you do.

---

## 7. HTTPS: why `tailscale serve`/`funnel` and never `tailscale cert`

Both can obtain a genuine, publicly trusted Let's Encrypt certificate for
`your-machine.your-tailnet.ts.net`. The difference is **renewal**:

- **`tailscale cert`** writes a certificate/key pair to disk **once**. It does **not** renew them.
  Let's Encrypt certificates last ~90 days. You would have to remember to re-run it and reload
  whatever holds the files — forever.
- **`tailscale serve`** (and `tailscale funnel`, which is Serve plus public ingress) makes
  `tailscaled` itself the TLS terminator. It fetches the certificate, keeps it in its own state,
  and **renews it automatically**. With `--bg` the configuration is persistent: it comes back after
  a reboot or a `tailscaled` restart.

Why that distinction is fatal rather than merely annoying: the tablets use `getUserMedia()` for
camera and microphone, and browsers only grant that on a **secure context**. The day an unrenewed
certificate expires, the page stops being a valid secure origin and **the camera silently stops
working** — no visible error, nothing the grandparents could report, roughly 90 days after
everything "just worked".

Two corollaries:

- The tablets **must** load `https://your-machine.your-tailnet.ts.net/`. A raw `100.x.y.z`
  Tailscale IP is **not** a secure origin, so the camera fails just as silently.
- `deploy.sh` sets up **`serve`** (tailnet only). Making the stack reachable from phones on the
  public internet is a separate, deliberate step with `./expose-public.sh`, which switches 443 to
  **`funnel`** — see [`README-public.md`](./README-public.md).

Commands:

```bash
tailscale serve status                                          # what is configured
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080     # (re)configure — deploy.sh does this
sudo tailscale serve --https=443 http://127.0.0.1:8080 off      # remove this one mapping
./expose-public.sh --status                                     # public (Funnel) state
```

If `serve` fails with a certificate error, the usual cause is that **HTTPS Certificates** are not
enabled for the tailnet: admin console → DNS → HTTPS Certificates → Enable, then re-run `deploy.sh`.

Also make sure this node has **key expiry disabled** in the admin console. Default node keys expire
after 180 days, and that is the most likely way this project quietly dies about six months after
setup.

---

## 8. Troubleshooting

| Symptom | First thing to check |
|---|---|
| Tablet shows the "frame is repairing itself" screen | `./healthcheck.sh`, then `docker logs frameo-signalling` |
| Camera does not turn on during a call | Is the page loaded over `https://<magicdns>/` (not an IP, not `http://`)? Then `tailscale serve status` and the cert expiry line in `healthcheck.sh` |
| A frame does not ring | Ringing goes over the frame's own WebSocket connection to the signalling server. Check that the frame appears as connected in `/api/health` (with a credential, see §4); if not, its kiosk URL is missing `device`/`token`, the token does not match `roster.json`, or the tablet has lost its tailnet path |
| `POST /api/call` returns `503 control-api-disabled` | `CONTROL_TOKEN` is empty in `.env`. It is only needed for scripted calls via `/api/call` and `/api/hangup` |
| "callee-not-in-roster" / calls refused | The whitelist is symmetric — both peers must list each other in `allowlist` |
| Signalling container exits right after start | `docker logs frameo-signalling`. "still has the placeholder authToken" means a roster entry was left as `replace-me…`; generate a real token |
| Roster edit had no effect | `docker logs frameo-signalling` and look for `roster.` lines — a parse error keeps the previous roster. The roster is mounted as a *directory*, so editors that rename-on-save still work |
| A container keeps restarting | `docker inspect -f '{{.State.OOMKilled}}' <name>`. If `true`, it hit its own `mem_limit`; raise it **and** re-check the 4 G slice budget |
| Everything on the box is slow | `systemd-cgtop -M frame.slice` and `cat /sys/fs/cgroup/frame.slice/memory.pressure`. If the slice is at `MemoryHigh`, something in this stack is leaking — restart it, do not raise the ceiling |
| Disk filling up | `du -sh ~/frameo/data/*`. It is almost always the photo library. Move it to another disk (see `README-immich.md`); **do not** run `docker system prune` |
| Immich will not start after an upgrade | Version mismatch between `IMMICH_VERSION` and the existing database. Restore the dump (§5) and go back to the working tag |

---

## Things to avoid on the server

The server may also run other containers and services you care about. These rules keep this stack
from disturbing them, and keep the stack itself alive.

1. **Do not restart the Docker daemon** for this project.
   Not `systemctl restart docker`, not `systemctl reload docker`. Restarting dockerd bounces every
   container on the box, not just these. Nothing in this project needs it.

2. **Do not write `/etc/docker/daemon.json`** for this project.
   Changing it only takes effect after a daemon restart. Containment here is done with per-service
   `cgroup_parent: frame.slice` inside the compose files, which needs no daemon changes at all. If
   you find yourself wanting a global `cgroup-parent`, you want `cgroup_parent` instead.

3. **Do not run `docker system prune`** (or `docker volume prune`, `docker network prune`,
   `docker image prune -a`, `docker builder prune --all`).
   These are machine-wide. They delete other stacks' stopped containers, volumes, networks and
   images. If disk space is tight, delete something you can name, by name.

4. **Leave other containers alone.** If the box runs a container that must not be disturbed, pass
   it to `deploy.sh` as `PROTECTED_CONTAINER=<name>` (§3) and treat a failed check (exit 90) as an
   incident.

5. **Do not bind a service to `0.0.0.0`** when `127.0.0.1` will do. This project uses **2283**
   (Immich), **8080** (signalling) and **3478** plus the relay range 49160–49260 (coturn, on
   loopback and the tailnet IP only). Make sure nothing else on the box already uses them.

6. **Expose the stack publicly only through `./expose-public.sh`**, never with a router port
   forward and never by funnelling Immich directly. See [`README-public.md`](./README-public.md).

7. **Do not use `tailscale cert`** for this project's HTTPS — see §7. An expired certificate kills
   camera access silently, months later.

8. **Do not raise `frame.slice`'s limits to "make it work".**
   The 4 G / 5 G ceiling is what guarantees the rest of the box keeps its memory. If this stack
   needs more than 4 G, find out what is leaking instead of widening the cage.

9. **Do not `systemctl daemon-reload` or edit other services' unit files** as a fix for something
   unexplained. Use a drop-in if you must change a unit.
