# Seeding the carousel - `import-photos.js`

One command puts a folder of photos into Immich **and** into the album the
photo frames actually display. It is safe to run again, and again, and again:
re-running an unchanged folder uploads nothing.

```bash
cd ~/frameo/server
./import-photos.js ~/frameo/photos-seed
```

Nothing to install. It is a single dependency-free Node 22 script, and it talks
to Immich over HTTP only. It never touches docker, the roster, the tablets, or
any container, so it cannot disturb anything else running on the server.

---

## 0. Get the photos onto the server

Run this on the computer that has the photos, not on the server. The trailing
slash on the source matters (it copies the contents, not the folder itself):

```bash
rsync -av --info=progress2 \
  ~/Pictures/family/ \
  you@your-machine.your-tailnet.ts.net:~/frameo/photos-seed/
```

More folders can go into the same destination with further rsync runs; the
importer de-duplicates by content anyway.

## 1. Prerequisites, once

1. **An album exists in Immich.** Create it in the Immich web UI first. The
   default target is the album named `Toti` (the default label of the "all
   frames" album); pick another with `--album "Bunici A"` or `--album <uuid>`.
2. **`IMMICH_ALBUM_IDS` in `~/frameo/server/.env` contains that
   album's id.** The frames only ever show the albums listed there. The
   importer checks this and prints a loud `WARN` if the album you are importing
   into is not one of them.
3. **An API key with write permission.** The key the signalling server uses can
   stay read-only; give the importer its own via `IMMICH_IMPORT_API_KEY` in
   `.env`. Create it in Immich → *Account Settings → API Keys*. Permissions
   needed:

   | Permission           | Used for                                   |
   |----------------------|--------------------------------------------|
   | `asset.upload`       | `POST /api/assets`, `bulk-upload-check`    |
   | `album.read`         | resolving the album name to an id          |
   | `albumAsset.create`  | adding the photos to the album             |
   | `asset.delete`       | only with `--restore-trashed`              |

   `all` works too.

## 2. Look before you leap

```bash
./import-photos.js ~/frameo/photos-seed --dry-run
```

This scans, hashes, asks Immich what it already has, and prints exactly what it
*would* upload - including the capture date it parsed for every file - without
sending a single byte. Example output:

```
Immich   http://127.0.0.1:2283  (user you@example.com)
Source   ~/frameo/photos-seed
Album    Toti  (2f0c…, 0 assets now)

Found 120 images (310.0 MiB), 112 dated from the filename, 8 from mtime, 0 skipped.
Oldest 2021-05-05   newest 2026-02-13   timezone Europe/Bucharest
```

## 3. Import

```bash
./import-photos.js ~/frameo/photos-seed
```

Ends with a summary and a meaningful exit code:

```
----------------------------------------------------------------
import-photos summary
  source        ~/frameo/photos-seed
  album         Toti (2f0c…)
  considered    120
  uploaded      120 (310.0 MiB)
  duplicate     0
  failed        0
  skipped       0
  album adds    120 new, 0 already there, 0 failed
  elapsed       1m 12s
----------------------------------------------------------------
```

| exit | meaning                                                        |
|------|----------------------------------------------------------------|
| 0    | everything is in Immich and in the album                       |
| 1    | at least one file hard-failed (listed by name), or the source folder held no importable image at all |
| 2    | it could not run at all: no API key, no Immich, no album, …    |
| 130  | you pressed Ctrl-C                                             |

## 4. Confirm the frames will see it

The signalling server caches the photo manifest for `PHOTO_MANIFEST_TTL_MS`
(5 minutes by default), so give it that long, then on the server:

```bash
CONTROL_TOKEN=$(sed -n 's/^CONTROL_TOKEN=//p' ~/frameo/server/.env)
curl -s -H "Authorization: Bearer $CONTROL_TOKEN" http://127.0.0.1:8080/api/photos | head -c 400
```

(`/api/photos` needs a credential; an anonymous request gets `401`.) You want
`"total"` to have grown. To skip the wait, restart just the signalling
container - that is the only container this whole flow ever needs restarted:

```bash
docker restart frameo-signalling
```

The tablets then pick up the new manifest on their next poll and cache the
images in their service worker.

---

## Options

```
./import-photos.js [SOURCE_DIR] [options]
```

| Option | Meaning |
|---|---|
| `SOURCE_DIR` | folder to import. Default `~/frameo/photos-seed` |
| `--album <name\|uuid>` | target album. Default `Toti`, or `$IMMICH_IMPORT_ALBUM` |
| `--no-album` | upload only, do not add to any album |
| `--url <base>` | Immich base URL. Default: probe `$IMMICH_URL`, `127.0.0.1:2283`, `localhost:2283`, `immich-server:2283` |
| `--env-file <path>` | which `.env` to read. Default `./.env`, then `~/frameo/server/.env` |
| `--concurrency <1-4>` | parallel uploads. Default 3, hard-capped at 4 |
| `--max-size <MB>` | skip files bigger than this. Default 50 |
| `--timezone <IANA>` | how to read `YYYYMMDD_HHMMSS` names. Default `Europe/Bucharest` |
| `--limit <N>` | import at most N files - handy for a first smoke test |
| `--no-recursive` | do not descend into sub-directories |
| `--restore-trashed` | un-trash assets that already exist but are in Immich's trash |
| `--dry-run` | scan and report, upload nothing |
| `--json` | append a machine-readable summary object |
| `--quiet` | only warnings, errors, and the final summary |
| `-h`, `--help` | usage |

Environment (all optional, read from `.env`; a real shell variable wins):
`IMMICH_IMPORT_API_KEY`, `IMMICH_IMPORT_URL`, `IMMICH_IMPORT_ALBUM`,
`IMMICH_IMPORT_TZ`. See `.env.example`.

---

## How it decides things

### Which files it takes

* Extensions: `jpg jpeg jpe jfif png gif webp bmp tif tiff heic heif hif avif
  dng`. Everything else is skipped and counted - **videos are not imported.**
* The first 16 bytes must actually look like an image, so a `.txt` renamed to
  `.jpg` never reaches Immich.
* Skipped: files over `--max-size` (50 MB), empty files, dotfiles, `@eaDir`,
  `.DS_Store`, `Thumbs.db`, broken symlinks.
* Filenames with spaces, diacritics and emoji are fine end to end - the
  original name is preserved as the asset's filename in Immich.

### Capture dates (this is what orders the slideshow)

Parsed from the filename, interpreted as **local wall-clock time** in
`--timezone` (default `Europe/Bucharest`; DST is handled correctly, so there a
March photo is sent as `+02:00` and an August one as `+03:00`), and sent as both
`fileCreatedAt` and `fileModifiedAt`.

| Filename shape | Example | Result |
|---|---|---|
| `YYYYMMDD_HHMMSS[_NN]` | `20250202_115132_10.jpeg` | `2025-02-02T11:51:32+02:00` |
| with junk suffix | `20240822_185646(0).jpg` | `2024-08-22T18:56:46+03:00` |
| with a prefix | `IMG_20240310_165804.jpg` | `2024-03-10T16:58:04+02:00` |
| Pixel, with ms | `PXL_20231225_083012345.jpg` | `2023-12-25T08:30:12+02:00` |
| dashes / dots | `2024-03-10 16.58.04.jpg` | `2024-03-10T16:58:04+02:00` |
| date + `HHMM` | `20260213_1239.jpg` | `2026-02-13T12:39:00+02:00` |
| date only | `IMG-20210505-WA0003.jpg` | `2021-05-05T12:00:00+03:00` (noon) |
| nothing usable | `IMG_2690.jpg` | the file's mtime |

Impossible dates (`20240231_120000`), dates before 1990 and dates more than two
days in the future are rejected and fall back to mtime.

Immich runs its own metadata job after each upload; if a photo carries EXIF
`DateTimeOriginal`, that wins later. That is correct - EXIF beats a filename.

### Why re-running is cheap and safe

Before uploading anything the script SHA1-hashes every file and asks
`POST /api/assets/bulk-upload-check` which of those checksums Immich already
has. Known files are never uploaded again; they are counted as `duplicate` and
are still added to the album (so a run that failed halfway through fixes itself
on the next run). If that endpoint is unavailable, it falls back to uploading
and relying on Immich's own duplicate response - slower, same end state.

Immich v3 de-duplicates on the **content hash**, not on `deviceAssetId`.
A stable `deviceAssetId` of `<filename>-<size>` is still sent for older
servers, and the script drops that field automatically if a server rejects it.

Consequence worth knowing: renaming a file and re-importing it changes nothing,
because the bytes are the same. Editing a photo does create a second asset.

---

## Troubleshooting

| Message | What to do |
|---|---|
| `IMMICH_API_KEY is not set` | put it in `~/frameo/server/.env`, or run with `--env-file`. It says which file it looked in. |
| `no Immich responded to GET /api/server/ping` | `docker ps \| grep immich-server`. It lists every URL it tried. Inside a container, pass `--url http://immich-server:2283`. |
| `the API key was rejected … HTTP 401` | the key is wrong or was deleted. Regenerate it in Immich. |
| `HTTP 403 … asset.upload permission` | the key is read-only. Make a second key with upload rights and set `IMMICH_IMPORT_API_KEY`. |
| `no album named "Toti"` | it prints every album with its id. Create the album in Immich, or pass `--album <uuid>`. |
| `album "X" is NOT in IMMICH_ALBUM_IDS` | the import will work but the frames will not show it. Add the printed id to `IMMICH_ALBUM_IDS` in `.env` and `docker restart frameo-signalling`. |
| `HTTP 507` / out of quota | Immich's storage quota or the disk is full. `df -h ~/frameo/data/immich`. |
| some files `FAILED` | they are listed by name with the reason. Just run the command again - the successful ones are skipped automatically. |
| `N matching asset(s) are in the Immich trash` | those photos exist but were deleted earlier. Re-run with `--restore-trashed` to bring them back. |
| photos are there but the frame still shows the old set | wait out `PHOTO_MANIFEST_TTL_MS` (5 min) or `docker restart frameo-signalling`. The tablet also caches aggressively; pull-to-refresh on the frame. |
| import is slowing the box down | it is capped at 3 parallel uploads (4 max) on purpose. Use `--concurrency 1` if the server is busy with other work. |

## Undoing an import

The script never deletes anything, so undo is manual. From the server, with
`KEY` set to an API key that has the matching permissions:

```bash
# Remove assets from the album only (they stay in Immich):
curl -X DELETE "http://127.0.0.1:2283/api/albums/<ALBUM_ID>/assets" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"ids":["<ASSET_ID>","…"]}'

# Move assets to Immich's trash (recoverable for trashDays):
curl -X DELETE "http://127.0.0.1:2283/api/assets" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"ids":["<ASSET_ID>","…"]}'
```

Deleting from the album is almost always what you want: the frames stop showing
the photo immediately (after the manifest TTL) and nothing is lost.

## Using it as a drop folder

Because it is idempotent, it is safe on a timer - drop new files into
`~/frameo/photos-seed` and let cron pick them up:

```cron
17 * * * * ~/frameo/server/import-photos.js --quiet >>~/frameo/logs/import.log 2>&1
```

That is a convenience for the operator, not the family-facing path: family
members upload photos from their phones through the admin web app, which
streams them to Immich through the signalling server.

## API surface it depends on (verified against Immich v3.1.0)

| Call | Notes |
|---|---|
| `GET /api/server/ping` | unauthenticated; used to find a working base URL |
| `GET /api/users/me` | validates the API key before anything is uploaded |
| `GET /api/albums` | album name → id. Note `GET /api/albums/{id}` does **not** return assets in v3 |
| `POST /api/assets/bulk-upload-check` | `{assets:[{id,checksum}]}`, hex SHA1 → `accept` / `reject:duplicate` |
| `POST /api/assets` | multipart `assetData`, `fileCreatedAt`, `fileModifiedAt`, `filename`, `isFavorite` → `201 {"id","status":"created"}` or `200 {"id","status":"duplicate"}` |
| `PUT /api/albums/{id}/assets` | `{"ids":[…]}` → per-id `success` / `error:"duplicate"` (already in the album, harmless) |
| `POST /api/trash/restore/assets` | only with `--restore-trashed` |

The `x-immich-checksum` header would also short-circuit duplicates, but the
server answers it before reading the request body, which can reset the
connection mid-upload. The `bulk-upload-check` pre-flight gets the same result
without that hazard, so the script does not send that header.
