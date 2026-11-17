# Immich photo backend — operator notes

Photo/video store for the frameo-clone digital frames. One Immich server, one
Postgres, one Valkey. No machine-learning container.

| | |
|---|---|
| Compose file | `~/frameo/server/docker-compose.immich.yml` |
| Env file | `~/frameo/server/.env` (from `.env.example`) |
| Version | Immich **v3.1.0** (pinned; never `release`/`latest`) |
| Web UI | `http://127.0.0.1:2283` on the server (e.g. through `ssh -L 2283:127.0.0.1:2283`) |
| Library | `~/frameo/data/immich` |
| Database | `~/frameo/data/postgres` |
| Memory ceiling | 2 GiB + 1 GiB + 256 MiB = **3.25 GiB hard** |
| cgroup | `frame.slice` (per-service, no daemon changes) |

---

## 1. Why there is no machine-learning container

The `immich-machine-learning` container is the heaviest part of a normal Immich
install: it loads CLIP and face-recognition ONNX models and sits at roughly
1.5–3 GiB RSS while saturating several cores during a library scan. The server
may run other services you care about, and if those are plain user processes
rather than systemd units they cannot be protected by drop-ins — the only
defence is to keep the machine out of memory pressure entirely.

It also buys nothing here. The frames show hand-curated albums. Smart search,
face clustering, OCR and duplicate detection are never used. So the service is
**removed from the compose file**, not commented out, and the `model-cache`
volume goes with it.

`IMMICH_MACHINE_LEARNING_ENABLED=false` is set on the server. On Immich v3 the
*binding* switch is the admin setting, so also do this once after first boot:

> **Administration → Settings → Machine Learning → uncheck "Enabled" → Save**

Skip it and the server logs a connection error to a non-existent ML host every
time an asset is uploaded. To enforce it without the UI, mount a config file
and set `IMMICH_CONFIG_FILE=/config/immich.json` on the server:

```json
{ "machineLearning": { "enabled": false } }
```

Caveat: `IMMICH_CONFIG_FILE` makes **all** settings read-only in the web UI, so
prefer the checkbox unless you want config-as-code.

---

## 2. The Postgres image — read this before changing anything

The most common way an Immich deploy fails is using the wrong database image.

Immich stores embeddings in vector columns and requires **VectorChord**
(`vchord`), **pgvector** and **earthdistance**. Plain `postgres:16`, `pgvector/pgvector`
and `ankane/pgvector` are all wrong. Use exactly:

```
ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf6335719...
```

(pinned by tag **and** digest in the compose file, as shipped in the upstream
v3.1.0 release).

`shared_preload_libraries` can only be set at postmaster start, and the image
carries it in a tuned config file rather than in `PGDATA`:

```
shared_preload_libraries = 'vchord.so'   # plus 'vectors.so' on the pgvectors tags
search_path              = '"$user", public, vectors'
```

which is why the image's own CMD is
`postgres -c config_file=/etc/postgresql/postgresql.conf`.

> **If you override `command:` and drop that `-c config_file=` flag, Postgres
> silently falls back to the config inside the data directory, `vchord.so` is
> never preloaded, and Immich dies with
> `Failed to activate VectorChord extension`.**

Our `command:` keeps `-c config_file=...` **first** and only appends memory
overrides after it (later `-c` flags win). Preserve that ordering.

Other database settings that matter:

- `POSTGRES_INITDB_ARGS: --data-checksums` — only takes effect on the very first
  start with an empty data dir. Immich's healthcheck reads checksums to detect
  silent corruption. It cannot be added later without a dump/restore.
- `DB_STORAGE_TYPE=SSD` — set on the **postgres** service; it selects
  `postgresql.ssd.conf` vs `postgresql.hdd.conf` inside the image.
- `DB_VECTOR_EXTENSION=vectorchord` — set on the **server**; pinned rather than
  auto-detected so a mismatched image fails loudly at startup.
- `shm_size: 128mb` — Docker's 64 MB default causes
  `could not resize shared memory segment` under parallel query.
- Tuning is sized for the 1 GiB cgroup cap (`shared_buffers=256MB`,
  `effective_cache_size=640MB`, `work_mem=8MB`, `max_connections=50`).
  Postgres cannot see the cgroup limit, so it has to be told.

---

## 3. First deploy

`deploy.sh` does all of this for you (see [`INSTALL.md`](../INSTALL.md)). The
manual steps, for reference or for running Immich on its own:

```bash
cd ~/frameo/server

# 3.1 One-off: dedicated network, shared by Immich and the signalling server
#     and by nothing else.
docker network create frameo            # idempotent-ish; ignore "already exists"

# 3.2 Data directories
mkdir -p ~/frameo/data/immich ~/frameo/data/postgres
chown -R "$USER:$USER" ~/frameo/data   # only while empty: never recurse into
                                       # data/postgres once it is initialised

# 3.3 Secrets
cp .env.example .env && chmod 600 .env
tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40; echo     # paste into DB_PASSWORD

# 3.4 Validate before pulling anything
docker compose -f docker-compose.immich.yml config >/dev/null && echo "compose OK"

# 3.5 Up
docker compose -f docker-compose.immich.yml pull
docker compose -f docker-compose.immich.yml up -d
```

Then open `http://127.0.0.1:2283`, create the admin account, and turn off
Machine Learning (§1).

### `frame.slice`

Every service sets `cgroup_parent: frame.slice`. Docker creates that cgroup on
demand, but installing `server/frame.slice` as a systemd slice (which
`deploy.sh` does) adds the project-wide ceiling: `MemoryHigh=4G`,
`MemoryMax=5G`, no swap. This does **not** touch the Docker daemon. If you run
Immich without `deploy.sh`, install it by hand:

```bash
sudo install -m 0644 -o root -g root frame.slice /etc/systemd/system/frame.slice
sudo systemctl daemon-reload && sudo systemctl enable --now frame.slice
```

`MemoryHigh` throttles before `MemoryMax` kills, so the stack degrades rather
than dying. Do not restart `docker.service` to apply anything here; nothing
needs it. See `README-ops.md` §6 for the full budget.

---

## 4. Health verification — exact commands

Run these in order. Every one should succeed before you call the stack up.

```bash
cd ~/frameo/server

# 4.1 All three containers healthy
docker compose -f docker-compose.immich.yml ps
docker inspect --format '{{.Name}} {{.State.Status}} {{.State.Health.Status}}' \
  immich-server immich-postgres immich-redis
# expect: /immich-server running healthy   (etc. for all three)

# 4.2 API liveness  -> {"res":"pong"}
curl -fsS http://127.0.0.1:2283/api/server/ping; echo

# 4.3 Version       -> {"major":3,"minor":1,"patch":0}
curl -fsS http://127.0.0.1:2283/api/server/version; echo

# 4.4 Web UI reachable (HTTP 200)
curl -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:2283/

# 4.5 Postgres accepting connections
docker exec immich-postgres pg_isready -U postgres -d immich
# expect: /var/run/postgresql:5432 - accepting connections

# 4.6 THE IMPORTANT ONE: vector library actually preloaded
docker exec immich-postgres psql -U postgres -d immich \
  -c "SHOW shared_preload_libraries;"
# expect output containing: vchord.so

# 4.7 Extensions present
docker exec immich-postgres psql -U postgres -d immich -c '\dx'
# expect rows for: vchord, vector, cube, earthdistance

# 4.8 Valkey answering
docker exec immich-redis redis-cli ping        # expect: PONG

# 4.9 Job queues draining (no permanent backlog)
curl -fsS http://127.0.0.1:2283/api/server/statistics 2>/dev/null | head -c 200; echo

# 4.10 Memory ceilings are real, not aspirational
docker stats --no-stream --format \
  'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  immich-server immich-postgres immich-redis
cat /sys/fs/cgroup/frame.slice/memory.current 2>/dev/null   # bytes, whole slice

# 4.11 Port is NOT world-exposed
ss -ltnp | grep 2283
# expect 127.0.0.1:2283 ONLY. If you see 0.0.0.0:2283, stop and fix the compose file.
```

Logs:

```bash
docker compose -f docker-compose.immich.yml logs -f --tail=100 immich-server
docker compose -f docker-compose.immich.yml logs --tail=50 immich-postgres
```

---

## 5. Moving the library to a quota-ed filesystem later

The library grows without bound; the database does not. Only
`UPLOAD_LOCATION` needs to move. Nothing in the Immich database stores the host
path, so the move is a bind-mount swap.

**Option A — separate filesystem (cleanest).** Give the library its own LVM
logical volume or partition; its size *is* the quota, and a full library cannot
fill `/` and take everything else on the server down with it.

```bash
docker compose -f docker-compose.immich.yml down
sudo mkdir -p /srv/frameo-photos
sudo mkfs.xfs /dev/mapper/vg0-frameo     # or ext4
echo '/dev/mapper/vg0-frameo /srv/frameo-photos xfs defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount /srv/frameo-photos
sudo rsync -aHAX --info=progress2 ~/frameo/data/immich/ /srv/frameo-photos/
sudo chown -R "$USER:$USER" /srv/frameo-photos
# edit .env:  UPLOAD_LOCATION=/srv/frameo-photos
docker compose -f docker-compose.immich.yml up -d
# verify §4, spot-check a few photos in the UI, then delete the old directory
```

**Option B — XFS project quota on an existing XFS filesystem.** No repartition.

```bash
# mount option: pquota   (e.g. /etc/fstab: ... xfs defaults,pquota 0 1), then remount
echo 'frameo:100' | sudo tee -a /etc/projid
echo '100:/srv/frameo-photos' | sudo tee -a /etc/projects
sudo xfs_quota -x -c 'project -s frameo' /srv
sudo xfs_quota -x -c 'limit -p bhard=300g frameo' /srv
sudo xfs_quota -x -c 'report -h -p' /srv          # check usage
```

**Option C — ext4 project quota.** `tune2fs -O project,quota /dev/…` (unmounted),
mount with `prjquota`, then `chattr -p 100 +P /srv/frameo-photos` and
`setquota -P 100 0 300G 0 0 /srv`.

Once a hard quota exists, Immich reports "no space left on device" on upload
instead of filling the root filesystem — which is the failure mode you want.

Also set a soft cap inside Immich: **Administration → Users → *user* → Quota**.
That is per-user bookkeeping only, not a filesystem guarantee; use it together
with, not instead of, the above.

To move the **database** (rarely needed), stop the stack, `rsync -aHAX` the
`postgres` directory to a local POSIX filesystem, update `DB_DATA_LOCATION`, and
start. Never put `PGDATA` on NFS/SMB/sshfs.

---

## 6. Backup

The library is just files — `rsync`/`restic` `UPLOAD_LOCATION`. The database
needs a logical dump; copying `PGDATA` from a running container is not a backup.

```bash
docker exec -t immich-postgres pg_dumpall --clean --if-exists -U postgres \
  | gzip > ~/frameo/backups/immich-db-$(date +%F).sql.gz
```

Restore into an **empty** data directory:

```bash
docker compose -f docker-compose.immich.yml down
sudo rm -rf ~/frameo/data/postgres/*
docker compose -f docker-compose.immich.yml up -d immich-postgres
gunzip < immich-db-YYYY-MM-DD.sql.gz \
  | docker exec -i immich-postgres psql -U postgres -d postgres
docker compose -f docker-compose.immich.yml up -d
```

Back up `.env` too — losing `DB_PASSWORD` after initdb means locking yourself
out of the database.

---

## 7. Upgrading

1. Read the release notes for breaking changes.
2. Back up (§6). Migrations run automatically on first start of a new version
   and are **not** reversible — you cannot roll the tag backwards.
3. Bump `IMMICH_VERSION` in `.env`.
4. `docker compose -f docker-compose.immich.yml pull && up -d`
5. Re-run §4.

If a release also bumps the Postgres image tag/digest upstream, update the
`immich-postgres` image line to match. Mismatched VectorChord versions are the
usual cause of post-upgrade breakage.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Failed to activate VectorChord extension` | Wrong Postgres image, or a `command:` override that dropped `-c config_file=/etc/postgresql/postgresql.conf`. Verify with §4.6. |
| `getaddrinfo ENOTFOUND database` / `ENOTFOUND redis` | `DB_HOSTNAME` / `REDIS_HOSTNAME` not set. Our services are `immich-postgres` / `immich-redis`, not Immich's defaults `database` / `redis`. |
| `network frameo declared as external, but could not be found` | `docker network create frameo` |
| Server restart-loops, exit 137 | OOM-killed against `mem_limit: 2g`. Check `docker inspect immich-server \| grep -i oom`. Do not raise past the 4 GiB project budget — reduce concurrent job workers in Administration → Settings → Job Concurrency instead. |
| Postgres won't start after editing `.env` | `DB_PASSWORD` was changed after initdb. The password lives in `PGDATA`. Restore the old value, or `ALTER USER postgres WITH PASSWORD '…';` inside the container, then update `.env`. |
| `could not resize shared memory segment` | `shm_size` missing/too small on `immich-postgres`. |
| Repeated ML connection errors in the log | Machine Learning still enabled in the admin settings — see §1. |
| Uploads fail with permission errors | `ls -ln ~/frameo/data`. `data/immich` must be writable by the user `immich-server` runs as (root inside the container, unless you add a `user:`). Never `chown -R` `data/postgres`: its files belong to the postgres uid inside the container. |
| Port 2283 refused from a tablet | Expected — it is bound to `127.0.0.1`, and the tablets never talk to Immich directly: they get photos through the signalling server's `/api/photos` proxy. Use an SSH tunnel to reach the Immich UI; do not rebind to `0.0.0.0`. |

---

## 9. Constraints

- Do not restart `docker.service` and do not write `/etc/docker/daemon.json`;
  other containers on the box would be bounced with it. cgroup placement is
  done per-service with `cgroup_parent`, which needs neither.
- Total memory authored here is capped at 3.25 GiB, inside the 4 GiB project
  budget shared with the signalling server and coturn. Do not raise the limits
  without re-checking that sum (`README-ops.md` §6).
- Bind host ports to `127.0.0.1`. This stack uses 2283 only; 8080 is the
  signalling service. Check that nothing else on the box already uses them.
- No `:latest` tags. Images are pinned by version, and by digest where upstream
  publishes one.
