#!/usr/bin/env node
'use strict';
/*
 * import-photos.js - one-shot, idempotent bulk import of a folder of photos
 *                    into Immich, and into the album the frames actually show.
 *
 * RUN THIS ON THE SERVER, as the deploy user:
 *
 *     cd ~/frameo/server
 *     ./import-photos.js ~/frameo/photos-seed
 *
 * It needs nothing but Node 22 (no npm install, zero dependencies) and a
 * reachable Immich. It never touches docker, the roster, or any container.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Loads .env (IMMICH_API_KEY, IMMICH_ALBUM_IDS, IMMICH_URL).
 *   2. Finds a working Immich base URL by probing GET /api/server/ping.
 *      Note the host cannot resolve `immich-server` - that name only exists on
 *      the internal docker network - so 127.0.0.1:2283 is probed as well.
 *   3. Resolves the target album by NAME (default "Toti") against
 *      GET /api/albums, and warns loudly if that album is not one of the ids
 *      in IMMICH_ALBUM_IDS (i.e. the frames would never show the import).
 *   4. Scans the source directory, skipping non-images and files > 50 MB.
 *   5. SHA1-hashes every file and asks POST /api/assets/bulk-upload-check
 *      which ones Immich already has. That is what makes re-runs cheap and
 *      exactly idempotent: known files are never uploaded a second time.
 *   6. Uploads the rest with POST /api/assets, 3 at a time.
 *   7. Adds everything (new + pre-existing) to the album with
 *      PUT /api/albums/{id}/assets.
 *   8. Prints a summary and exits non-zero if anything hard-failed.
 *
 * CAPTURE DATES
 *   The slideshow orders by capture date, so filenames of the form
 *   YYYYMMDD_HHMMSS[_NN].jpg (what most Android phones produce) are parsed and sent as
 *   fileCreatedAt / fileModifiedAt, interpreted in --timezone
 *   (default Europe/Bucharest). Files whose name carries no usable date fall
 *   back to their mtime. Immich's own metadata job may later refine this from
 *   EXIF, which is fine - EXIF is more authoritative than a filename.
 *
 * VERIFIED AGAINST IMMICH v3.1.0 (server/src, tag v3.1.0):
 *   POST /api/assets            multipart: assetData (file), fileCreatedAt,
 *                               fileModifiedAt, filename, isFavorite.
 *                               -> 201 {"id","status":"created"}
 *                               -> 200 {"id","status":"duplicate"}
 *                               Duplicates are detected by SHA1 of the file
 *                               content, NOT by deviceAssetId (that field was
 *                               dropped from the DTO in v3; it is still sent
 *                               for compatibility with older servers and is
 *                               harmlessly ignored by v3 - unknown keys are
 *                               stripped, not rejected).
 *   POST /api/assets/bulk-upload-check
 *                               {"assets":[{"id","checksum"}]} (hex sha1)
 *                               -> {"results":[{"id","action":"accept"|"reject",
 *                                   "reason":"duplicate"|"unsupported-format",
 *                                   "assetId","isTrashed"}]}
 *   PUT  /api/albums/{id}/assets {"ids":[...]}
 *                               -> [{"id","success","error":"duplicate"|...}]
 *                               error "duplicate" = already in the album = fine.
 *   POST /api/trash/restore/assets {"ids":[...]}   (only with --restore-trashed)
 *   GET  /api/albums, GET /api/users/me, GET /api/server/ping
 *
 *   The x-immich-checksum request header would also short-circuit duplicates,
 *   but the server answers before reading the body, which can reset the
 *   connection mid-upload. The bulk-upload-check pre-flight above achieves the
 *   same thing without that hazard, so this script does not send that header.
 *
 * EXIT CODES
 *   0  everything imported (or was already there)
 *   1  at least one file hard-failed
 *   2  it could not run at all (no API key, no Immich, no album, no source dir)
 *   130 interrupted with Ctrl-C
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE = path.join(os.homedir(), 'frameo', 'photos-seed');
const DEFAULT_ALBUM = 'Toti';
const DEFAULT_TZ = 'Europe/Bucharest';
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 4;
const DEFAULT_MAX_SIZE_MB = 50;

const JSON_TIMEOUT_MS = 20000;
const PING_TIMEOUT_MS = 5000;
const UPLOAD_TIMEOUT_MS = 180000;
const UPLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 7000];

const BULK_CHECK_BATCH = 200;
const ALBUM_ADD_BATCH = 200;

/** Extensions Immich can ingest as a still image, and the MIME type we declare. */
const IMAGE_TYPES = new Map(Object.entries({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.hif': 'image/heif',
  '.avif': 'image/avif',
  '.dng': 'image/x-adobe-dng',
}));

/** Junk that shows up in synced folders and must never be uploaded. */
const IGNORED_NAMES = new Set([
  '.ds_store', 'thumbs.db', 'desktop.ini', '.picasa.ini', 'picasa.ini',
  '@eadir', '.thumbnails', '.trash', '.trashes', '.spotlight-v100', '.fseventsd',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = TTY
  ? { reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[1;31m', grn: '\x1b[1;32m', yel: '\x1b[1;33m', dim: '\x1b[2m' }
  : { reset: '', bold: '', red: '', grn: '', yel: '', dim: '' };

let progressLineOpen = false;

function clearProgress() {
  if (progressLineOpen) {
    process.stdout.write('\r\x1b[2K');
    progressLineOpen = false;
  }
}

function log(msg) {
  clearProgress();
  process.stdout.write(msg + '\n');
}
function warn(msg) {
  clearProgress();
  process.stdout.write(`${C.yel}WARN${C.reset}  ${msg}\n`);
}
function errline(msg) {
  clearProgress();
  process.stderr.write(`${C.red}ERROR${C.reset} ${msg}\n`);
}

/** Fatal, cannot-run-at-all exit. */
function die(msg, hint) {
  errline(msg);
  if (hint) process.stderr.write(`      ${C.dim}${hint}${C.reset}\n`);
  process.exit(2);
}

function progress(line) {
  if (!TTY) return;
  const width = Math.max(20, (process.stdout.columns || 80) - 1);
  const text = line.length > width ? line.slice(0, width - 1) + '…' : line;
  process.stdout.write('\r\x1b[2K' + text);
  progressLineOpen = true;
}

function humanBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GiB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KiB';
  return b + ' B';
}

function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
import-photos.js - seed Immich (and the frames' album) from a folder of photos

USAGE
  ./import-photos.js [SOURCE_DIR] [options]

  SOURCE_DIR                 folder to import (default ${DEFAULT_SOURCE})

OPTIONS
  --album <name|uuid>        target album, by name or id
                             (default "${DEFAULT_ALBUM}", or $IMMICH_IMPORT_ALBUM)
  --no-album                 upload only, do not add to any album
  --url <base-url>           Immich base URL (default: probe $IMMICH_URL,
                             http://127.0.0.1:2283, http://localhost:2283,
                             http://immich-server:2283)
  --env-file <path>          .env to read (default: ./.env next to this script,
                             then ~/frameo/server/.env)
  --concurrency <1-${MAX_CONCURRENCY}>        parallel uploads (default ${DEFAULT_CONCURRENCY})
  --max-size <MB>            skip files larger than this (default ${DEFAULT_MAX_SIZE_MB})
  --timezone <IANA>          how to read YYYYMMDD_HHMMSS filenames
                             (default ${DEFAULT_TZ})
  --limit <N>                import at most N files (smoke tests)
  --no-recursive             do not descend into sub-directories
  --restore-trashed          un-trash existing duplicates so they show again
  --dry-run                  scan, hash and report; upload nothing
  --json                     also print a machine-readable summary object
  --quiet                    only warnings, errors and the final summary
  -h, --help                 this text

EXIT CODES
  0 ok   1 some files failed   2 cannot run   130 interrupted
`.trimStart();

function parseArgs(argv) {
  // `album` and `timezone` stay null here; main() fills them in from the .env
  // file (IMMICH_IMPORT_ALBUM / IMMICH_IMPORT_TZ) once that has been read.
  const opts = {
    source: null,
    album: null,
    useAlbum: true,
    url: null,
    envFile: null,
    concurrency: DEFAULT_CONCURRENCY,
    maxSizeMb: DEFAULT_MAX_SIZE_MB,
    timezone: null,
    limit: 0,
    recursive: true,
    restoreTrashed: false,
    dryRun: false,
    json: false,
    quiet: false,
  };

  const need = (i, name) => {
    if (i + 1 >= argv.length) die(`option ${name} needs a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
      case '--album': opts.album = need(i, a); i++; break;
      case '--no-album': opts.useAlbum = false; break;
      case '--url': opts.url = need(i, a); i++; break;
      case '--env-file': opts.envFile = need(i, a); i++; break;
      case '--concurrency': opts.concurrency = Number(need(i, a)); i++; break;
      case '--max-size': opts.maxSizeMb = Number(need(i, a)); i++; break;
      case '--timezone': case '--tz': opts.timezone = need(i, a); i++; break;
      case '--limit': opts.limit = Number(need(i, a)); i++; break;
      case '--recursive': opts.recursive = true; break;
      case '--no-recursive': opts.recursive = false; break;
      case '--restore-trashed': opts.restoreTrashed = true; break;
      case '--no-restore-trashed': opts.restoreTrashed = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--source': opts.source = need(i, a); i++; break;
      default:
        if (a.startsWith('-')) die(`unknown option ${a}`, 'run with --help');
        if (opts.source !== null) die(`unexpected extra argument ${a}`, 'only one source directory is accepted');
        opts.source = a;
    }
  }

  if (opts.source === null) opts.source = DEFAULT_SOURCE;
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) opts.concurrency = 1;
  if (opts.concurrency > MAX_CONCURRENCY) {
    // Hard cap: the server may run other services that must not be starved.
    opts.concurrency = MAX_CONCURRENCY;
  }
  if (!Number.isFinite(opts.maxSizeMb) || opts.maxSizeMb <= 0) opts.maxSizeMb = DEFAULT_MAX_SIZE_MB;
  if (!Number.isFinite(opts.limit) || opts.limit < 0) opts.limit = 0;

  return opts;
}

// ---------------------------------------------------------------------------
// .env loading (same shape docker compose reads: KEY=VALUE, # comments)
// ---------------------------------------------------------------------------

function parseEnvText(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Real process env always wins over the file, so
 * `IMMICH_API_KEY=... ./import-photos.js` works for a one-off.
 */
function loadEnv(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [path.join(__dirname, '.env'), path.join(os.homedir(), 'frameo', 'server', '.env')];

  let fileEnv = {};
  let used = null;
  for (const p of candidates) {
    try {
      fileEnv = parseEnvText(fs.readFileSync(p, 'utf8'));
      used = p;
      break;
    } catch (err) {
      if (explicitPath) die(`cannot read --env-file ${p}: ${err.message}`);
    }
  }
  const merged = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') merged[k] = v;
  }
  return { env: merged, path: used };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Offset (ms) of `tz` at instant `ts`: how far local wall-clock leads UTC. */
function tzOffsetMs(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(ts))) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - ts;
}

/** Wall-clock in `tz` -> epoch ms. Two passes settle DST boundaries. */
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = naive - tzOffsetMs(naive, tz);
  for (let i = 0; i < 2; i++) {
    const next = naive - tzOffsetMs(ts, tz);
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** ISO 8601 with a real numeric offset, which is what Immich's zod expects. */
function isoWithOffset(ts, tz) {
  const offMin = Math.round(tzOffsetMs(ts, tz) / 60000);
  const local = new Date(ts + offMin * 60000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}` +
    `.${p(local.getUTCMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const MIN_PLAUSIBLE = Date.UTC(1990, 0, 1);

/**
 * Capture time out of names like:
 *   20250202_115132_10.jpeg   20240310_165804.jpg   20240822_185646(0).jpg
 *   IMG_20240310_165804.jpg   IMG-20240310-WA0001.jpg   2024-03-10 16.58.04.jpg
 * Returns { ts, source } or null.
 */
function parseFilenameTimestamp(basename, tz, now) {
  const stem = basename.replace(/\.[^.]*$/, '');

  // ...(\d{3})? swallows the milliseconds Pixel phones append (PXL_20231225_083012345).
  const withTime = stem.match(
    /(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?:\d{3})?(?![0-9])/,
  );
  if (withTime) {
    const ts = buildTs(withTime.slice(1).map(Number), tz, now);
    if (ts !== null) return { ts, source: 'filename' };
  }

  // Date + HH:MM but no seconds (20260213_1239.jpg).
  const hhmm = stem.match(/^(?:[A-Za-z]{2,10}[-_])?((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:]?(\d{2})(?![0-9])/);
  if (hhmm) {
    const [y, mo, d, h, mi] = hhmm.slice(1).map(Number);
    const ts = buildTs([y, mo, d, h, mi, 0], tz, now);
    if (ts !== null) return { ts, source: 'filename' };
  }

  // Date but no time (WhatsApp's IMG-20240310-WA0001, scanner exports, ...):
  // noon keeps the day ordering sane without pretending to know a time. Only
  // at the start of the name, optionally behind a short alphabetic prefix, so
  // that a stray 8-digit number inside a name is not mistaken for a date.
  const dateOnly = stem.match(/^(?:[A-Za-z]{2,10}[-_])?((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?![0-9])/);
  if (dateOnly) {
    const [y, mo, d] = dateOnly.slice(1).map(Number);
    const ts = buildTs([y, mo, d, 12, 0, 0], tz, now);
    if (ts !== null) return { ts, source: 'filename-date' };
  }

  return null;
}

function buildTs([y, mo, d, h, mi, s], tz, now) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ts = zonedToEpoch(y, mo, d, h, mi, s, tz);
  if (!Number.isFinite(ts)) return null;
  // Reject impossible calendar dates (2024-02-31 would silently roll over).
  const back = new Date(ts + tzOffsetMs(ts, tz));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
  if (ts < MIN_PLAUSIBLE || ts > now + 48 * 3600 * 1000) return null;
  return ts;
}

// ---------------------------------------------------------------------------
// HTTP against Immich
// ---------------------------------------------------------------------------

class Immich {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  async request(pathname, { method = 'GET', json, body, headers = {}, timeout = JSON_TIMEOUT_MS } = {}) {
    const init = {
      method,
      headers: { accept: 'application/json', 'x-api-key': this.apiKey, ...headers },
      signal: AbortSignal.timeout(timeout),
    };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }

    const res = await fetch(this.baseUrl + pathname, init);
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { /* not json */ } }
    return { status: res.status, ok: res.ok, json: parsed, text };
  }

  /** GET returning JSON or throwing a readable error. */
  async getJson(pathname) {
    const res = await this.request(pathname);
    if (!res.ok) throw new Error(`GET ${pathname} -> HTTP ${res.status} ${describeBody(res)}`);
    return res.json;
  }
}

function describeBody(res) {
  if (res.json && (res.json.message || res.json.error)) {
    const m = res.json.message;
    return String(Array.isArray(m) ? m.join('; ') : (m || res.json.error)).slice(0, 300);
  }
  return String(res.text || '').replace(/\s+/g, ' ').slice(0, 200);
}

/** fetch() hides the real reason one level down, in `cause`. */
function netErrorCode(err) {
  if (!err) return 'error';
  if (err.name === 'TimeoutError') return 'timed out';
  const cause = err.cause;
  return (cause && (cause.code || cause.message)) || err.code || err.message || err.name || 'error';
}

/** First base URL that answers GET /api/server/ping wins. */
async function probeBaseUrl(candidates) {
  const tried = [];
  for (const base of candidates) {
    const url = base.replace(/\/+$/, '');
    try {
      const res = await fetch(url + '/api/server/ping', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      const body = await res.text();
      if (res.ok && body.includes('pong')) return { url, tried };
      tried.push(`${url} (HTTP ${res.status})`);
    } catch (err) {
      tried.push(`${url} (${netErrorCode(err)})`);
    }
  }
  return { url: null, tried };
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

async function scanSource(root, { recursive, maxSizeBytes }) {
  const files = [];
  const skipped = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ file: dir, reason: 'unreadable-directory: ' + err.code });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const lower = entry.name.toLowerCase();
      if (entry.name.startsWith('.') || IGNORED_NAMES.has(lower)) continue;

      if (entry.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        let st;
        try { st = await fsp.stat(full); } catch { skipped.push({ file: full, reason: 'broken-symlink' }); continue; }
        if (st.isDirectory()) { if (recursive) stack.push(full); continue; }
        if (!st.isFile()) { skipped.push({ file: full, reason: 'not-a-regular-file' }); continue; }
      } else if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const mime = IMAGE_TYPES.get(ext);
      if (!mime) { skipped.push({ file: full, reason: 'not-an-image' }); continue; }

      let st;
      try { st = await fsp.stat(full); } catch (err) { skipped.push({ file: full, reason: 'stat-failed: ' + err.code }); continue; }
      if (st.size === 0) { skipped.push({ file: full, reason: 'empty-file' }); continue; }
      if (st.size > maxSizeBytes) { skipped.push({ file: full, reason: `too-large (${humanBytes(st.size)})` }); continue; }

      files.push({
        path: full,
        rel: path.relative(root, full) || entry.name,
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mime,
      });
    }
  }

  return { files, skipped };
}

/** Cheap magic-byte sanity check so a renamed .txt never reaches Immich. */
async function looksLikeImage(file) {
  let fh;
  try {
    fh = await fsp.open(file.path, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 12) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8) return true;                       // JPEG
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') return true;          // GIF
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return true;
    if (buf.subarray(0, 2).toString('latin1') === 'BM') return true;           // BMP
    if (buf.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))) return true; // TIFF/DNG LE
    if (buf.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return true; // TIFF/DNG BE
    if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return true;         // HEIC/HEIF/AVIF
    return false;
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------------------
// Small async worker pool
// ---------------------------------------------------------------------------

async function pool(items, size, worker) {
  const n = Math.max(1, Math.min(size, items.length || 1));
  let next = 0;
  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const state = {
  interrupted: false,
  hardFailures: 0,
};

async function main() {
  const startedAt = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const say = opts.quiet ? () => {} : log;

  // --- source directory ----------------------------------------------------
  const source = path.resolve(opts.source);
  let sourceStat;
  try {
    sourceStat = await fsp.stat(source);
  } catch (err) {
    die(`source directory ${source} is not readable: ${err.code}`,
      'rsync the photos there first, e.g.  rsync -av --delete ~/Pictures/family/ you@server:~/frameo/photos-seed/');
  }
  if (!sourceStat.isDirectory()) die(`source ${source} is not a directory`);

  // --- env -----------------------------------------------------------------
  const { env, path: envPath } = loadEnv(opts.envFile);
  const apiKey = env.IMMICH_IMPORT_API_KEY || env.IMMICH_API_KEY || '';
  if (!apiKey) {
    die('IMMICH_API_KEY is not set',
      `looked in ${envPath || 'no .env found'} - create a key in Immich (Account Settings -> API Keys) with asset upload + album permissions`);
  }
  const albumIdsFromEnv = String(env.IMMICH_ALBUM_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Command line wins, then .env / the shell, then the built-in default.
  if (!opts.album) opts.album = (env.IMMICH_IMPORT_ALBUM || '').trim() || DEFAULT_ALBUM;
  if (!opts.timezone) opts.timezone = (env.IMMICH_IMPORT_TZ || '').trim() || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone });
  } catch {
    die(`timezone "${opts.timezone}" is not a known IANA timezone`, 'e.g. --timezone Europe/Bucharest');
  }

  // --- reachable Immich ----------------------------------------------------
  const candidates = [];
  const push = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
  push(opts.url);
  push(env.IMMICH_IMPORT_URL);
  if (!opts.url) {
    push(env.IMMICH_URL);
    push('http://127.0.0.1:2283');
    push('http://localhost:2283');
    push('http://immich-server:2283');
  }
  const probe = await probeBaseUrl(candidates);
  if (!probe.url) {
    die('no Immich responded to GET /api/server/ping',
      'tried: ' + probe.tried.join(', ') + ' - is the immich-server container up? (docker ps)');
  }
  const immich = new Immich(probe.url, apiKey);

  let me;
  try {
    me = await immich.getJson('/api/users/me');
  } catch (err) {
    die(`the API key was rejected by ${probe.url}: ${err.message}`,
      'regenerate it in Immich -> Account Settings -> API Keys and update .env');
  }

  say(`${C.bold}Immich${C.reset}   ${probe.url}  (user ${me && me.email ? me.email : 'unknown'})`);
  say(`${C.bold}Source${C.reset}   ${source}`);
  if (envPath) say(`${C.bold}Env${C.reset}      ${envPath}`);

  // --- target album --------------------------------------------------------
  let album = null;
  if (opts.useAlbum) {
    let albums;
    try {
      albums = await immich.getJson('/api/albums');
    } catch (err) {
      die(`cannot list albums: ${err.message}`, 'the API key needs the album.read permission');
    }
    if (!Array.isArray(albums)) die('unexpected response from GET /api/albums');

    const wanted = String(opts.album).trim();
    if (UUID_RE.test(wanted)) {
      album = albums.find((a) => a.id === wanted) || null;
      if (!album) {
        die(`album id ${wanted} does not exist (or is not visible to this API key)`,
          'known albums: ' + albums.map((a) => `${a.albumName} = ${a.id}`).join(', '));
      }
    } else {
      const matches = albums.filter((a) => String(a.albumName).trim().toLowerCase() === wanted.toLowerCase());
      // Prefer an album the frames actually read, when the name is ambiguous.
      const preferred = matches.filter((a) => albumIdsFromEnv.includes(a.id));
      const pick = preferred.length === 1 ? preferred : matches;
      if (pick.length === 0) {
        die(`no album named "${wanted}"`,
          'known albums: ' + (albums.length
            ? albums.map((a) => `${a.albumName} = ${a.id}`).join(', ')
            : '(none - create one in Immich first)'));
      }
      if (pick.length > 1) {
        die(`"${wanted}" matches ${pick.length} albums`,
          'pass --album <uuid>: ' + pick.map((a) => a.id).join(', '));
      }
      album = pick[0];
    }

    say(`${C.bold}Album${C.reset}    ${album.albumName}  (${album.id}, ${album.assetCount} assets now)`);
    if (albumIdsFromEnv.length && !albumIdsFromEnv.includes(album.id)) {
      warn(`album "${album.albumName}" is NOT in IMMICH_ALBUM_IDS - the frames will not show these photos.`);
      warn(`add ${album.id} to IMMICH_ALBUM_IDS in ${envPath || '.env'} and restart frameo-signalling.`);
    }
  } else {
    say(`${C.bold}Album${C.reset}    (none - --no-album)`);
  }

  // --- scan ----------------------------------------------------------------
  const maxSizeBytes = Math.round(opts.maxSizeMb * 1024 * 1024);
  const scan = await scanSource(source, { recursive: opts.recursive, maxSizeBytes });
  const skipped = scan.skipped;
  let files = scan.files;

  const now = Date.now();
  for (const f of files) {
    const parsed = parseFilenameTimestamp(f.name, opts.timezone, now);
    if (parsed) {
      f.ts = parsed.ts;
      f.dateSource = parsed.source;
    } else {
      f.ts = Math.min(f.mtimeMs, now);
      f.dateSource = 'mtime';
    }
    f.iso = isoWithOffset(f.ts, opts.timezone);
  }

  files.sort((a, b) => (a.ts - b.ts) || a.rel.localeCompare(b.rel, 'en'));
  if (opts.limit && files.length > opts.limit) files = files.slice(0, opts.limit);

  if (files.length === 0) {
    say('');
    warn(`no importable images found in ${source} (${skipped.length} entries skipped)`);
    warn('did the rsync land somewhere else? this is treated as a failure so a deploy script notices.');
    printSummary({ opts, source, album, files: [], skipped, results: [], albumAdd: null, startedAt });
    process.exit(1);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const byMtime = files.filter((f) => f.dateSource === 'mtime').length;
  say('');
  say(`Found ${C.bold}${files.length}${C.reset} images (${humanBytes(totalBytes)}), ` +
      `${files.length - byMtime} dated from the filename, ${byMtime} from mtime, ` +
      `${skipped.length} skipped.`);
  say(`Oldest ${files[0].iso.slice(0, 10)}   newest ${files[files.length - 1].iso.slice(0, 10)}   ` +
      `timezone ${opts.timezone}`);

  // --- magic bytes + sha1 --------------------------------------------------
  const hashable = [];
  let hashed = 0;
  await pool(files, opts.concurrency, async (f) => {
    if (state.interrupted) return;
    if (!(await looksLikeImage(f))) {
      skipped.push({ file: f.path, reason: 'not-an-image (content)' });
      return;
    }
    try {
      f.sha1 = await sha1File(f.path);
      hashable.push(f);
    } catch (err) {
      skipped.push({ file: f.path, reason: 'read-failed: ' + (err.code || err.message) });
      state.hardFailures++;
    }
    hashed++;
    progress(`${C.dim}hashing${C.reset} ${hashed}/${files.length}  ${f.name}`);
  });
  clearProgress();
  hashable.sort((a, b) => (a.ts - b.ts) || a.rel.localeCompare(b.rel, 'en'));

  if (state.interrupted) return finish({ opts, source, album, files: hashable, skipped, results: [], albumAdd: null, startedAt, code: 130 });

  // --- which ones does Immich already have? --------------------------------
  const results = [];         // { file, outcome, assetId?, error? }
  const toUpload = [];
  const existing = [];        // assets already present: { file, assetId, isTrashed }

  let bulkCheckWorked = true;
  for (let i = 0; i < hashable.length; i += BULK_CHECK_BATCH) {
    const batch = hashable.slice(i, i + BULK_CHECK_BATCH);
    let res;
    try {
      res = await immich.request('/api/assets/bulk-upload-check', {
        method: 'POST',
        json: { assets: batch.map((f) => ({ id: f.sha1, checksum: f.sha1 })) },
      });
    } catch (err) {
      warn(`bulk-upload-check failed (${err.message}); falling back to plain uploads`);
      bulkCheckWorked = false;
      break;
    }
    if (!res.ok) {
      warn(`bulk-upload-check -> HTTP ${res.status} ${describeBody(res)}; falling back to plain uploads`);
      bulkCheckWorked = false;
      break;
    }
    const byId = new Map();
    for (const r of (res.json && res.json.results) || []) byId.set(r.id, r);
    for (const f of batch) {
      const r = byId.get(f.sha1);
      if (r && r.action === 'reject' && r.reason === 'duplicate' && r.assetId) {
        existing.push({ file: f, assetId: r.assetId, isTrashed: Boolean(r.isTrashed) });
      } else if (r && r.action === 'reject' && r.reason === 'unsupported-format') {
        skipped.push({ file: f.path, reason: 'unsupported-format (per Immich)' });
      } else {
        toUpload.push(f);
      }
    }
  }
  if (!bulkCheckWorked) {
    toUpload.length = 0;
    existing.length = 0;
    toUpload.push(...hashable);
  }

  for (const e of existing) {
    results.push({ file: e.file, outcome: 'duplicate', assetId: e.assetId, isTrashed: e.isTrashed });
  }

  say(`Immich already has ${existing.length}; uploading ${toUpload.length}.`);
  say('');

  if (opts.dryRun) {
    for (const f of toUpload) {
      log(`${C.dim}would upload${C.reset} ${f.rel}  ${f.iso}  ${humanBytes(f.size)}  ${f.dateSource}`);
    }
    printSummary({ opts, source, album, files: hashable, skipped, results, albumAdd: null, startedAt, dryRun: true });
    process.exit(0);
  }

  // --- upload --------------------------------------------------------------
  const legacyFields = { send: true };   // deviceAssetId/deviceId, dropped if refused
  let done = 0;
  const uploadStart = Date.now();

  await pool(toUpload, opts.concurrency, async (f) => {
    if (state.interrupted) return;
    const outcome = await uploadOne(immich, f, legacyFields);
    done++;
    results.push(outcome);

    const label = outcome.outcome === 'uploaded'
      ? `${C.grn}uploaded${C.reset}`
      : outcome.outcome === 'duplicate' ? `${C.yel}duplicate${C.reset}` : `${C.red}FAILED${C.reset}`;

    if (outcome.outcome === 'failed') {
      state.hardFailures++;
      errline(`${f.rel}: ${outcome.error}`);
    }
    const line = `[${done}/${toUpload.length}] ${label} ${f.rel} ${C.dim}(${humanBytes(f.size)}, ${f.iso.slice(0, 19)})${C.reset}`;
    if (TTY && !opts.quiet && outcome.outcome !== 'failed') progress(line);
    else if (!opts.quiet && outcome.outcome !== 'failed') log(line);
  });
  clearProgress();

  const uploaded = results.filter((r) => r.outcome === 'uploaded').length;
  say(`Uploaded ${uploaded} file(s) in ${humanDuration(Date.now() - uploadStart)}.`);

  // --- restore trashed duplicates -----------------------------------------
  if (opts.restoreTrashed) {
    const trashed = results.filter((r) => r.isTrashed && r.assetId).map((r) => r.assetId);
    if (trashed.length) {
      for (let i = 0; i < trashed.length; i += ALBUM_ADD_BATCH) {
        const batch = trashed.slice(i, i + ALBUM_ADD_BATCH);
        const res = await immich.request('/api/trash/restore/assets', { method: 'POST', json: { ids: batch } });
        if (!res.ok) {
          warn(`restoring ${batch.length} trashed asset(s) -> HTTP ${res.status} ${describeBody(res)}`);
        }
      }
      say(`Restored ${trashed.length} previously trashed asset(s).`);
    }
  } else {
    const trashed = results.filter((r) => r.isTrashed).length;
    if (trashed) warn(`${trashed} matching asset(s) are in the Immich trash and stay hidden - re-run with --restore-trashed to bring them back.`);
  }

  // --- album ---------------------------------------------------------------
  let albumAdd = null;
  if (album) {
    const ids = [...new Set(results.filter((r) => r.assetId).map((r) => r.assetId))];
    albumAdd = { added: 0, already: 0, failed: 0 };
    for (let i = 0; i < ids.length; i += ALBUM_ADD_BATCH) {
      const batch = ids.slice(i, i + ALBUM_ADD_BATCH);
      let res;
      try {
        res = await immich.request(`/api/albums/${encodeURIComponent(album.id)}/assets`, {
          method: 'PUT',
          json: { ids: batch },
        });
      } catch (err) {
        errline(`adding ${batch.length} asset(s) to "${album.albumName}" failed: ${err.message}`);
        albumAdd.failed += batch.length;
        state.hardFailures++;
        continue;
      }
      if (!res.ok) {
        errline(`PUT /api/albums/${album.id}/assets -> HTTP ${res.status} ${describeBody(res)}`);
        albumAdd.failed += batch.length;
        state.hardFailures++;
        continue;
      }
      for (const r of Array.isArray(res.json) ? res.json : []) {
        if (r.success) albumAdd.added++;
        else if (r.error === 'duplicate') albumAdd.already++;
        else {
          albumAdd.failed++;
          state.hardFailures++;
          errline(`asset ${r.id} not added to the album: ${r.error || 'unknown'}${r.errorMessage ? ' - ' + r.errorMessage : ''}`);
        }
      }
    }
    say(`Album "${album.albumName}": ${albumAdd.added} added, ${albumAdd.already} already there, ${albumAdd.failed} failed.`);
  }

  finish({ opts, source, album, files: hashable, skipped, results, albumAdd, startedAt });
}

/**
 * One upload, with retries. Returns { file, outcome, assetId?, error? }.
 * Auth/quota problems abort the whole run - retrying them is pointless and
 * would only hammer the server.
 */
async function uploadOne(immich, file, legacyFields) {
  let lastError = 'unknown error';
  let legacyRetried = false;

  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
    if (state.interrupted) return { file, outcome: 'failed', error: 'interrupted' };
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);

    let buf;
    try {
      buf = await fsp.readFile(file.path);
    } catch (err) {
      return { file, outcome: 'failed', error: `cannot read file: ${err.code || err.message}` };
    }

    const form = new FormData();
    // Immich v3 keys duplicates off the SHA1 of the bytes; deviceAssetId is
    // ignored there but is what older servers dedupe on, so send a stable one.
    const sentLegacy = legacyFields.send;
    if (sentLegacy) {
      form.set('deviceAssetId', `${file.name}-${file.size}`);
      form.set('deviceId', 'frameo-import');
    }
    form.set('fileCreatedAt', file.iso);
    form.set('fileModifiedAt', file.iso);
    form.set('filename', file.name);
    form.set('isFavorite', 'false');
    form.set('assetData', new File([buf], file.name, { type: file.mime }));

    let res;
    try {
      res = await immich.request('/api/assets', { method: 'POST', body: form, timeout: UPLOAD_TIMEOUT_MS });
    } catch (err) {
      lastError = `network: ${netErrorCode(err)}`;
      continue;
    }

    const body = res.json || {};
    if (res.ok) {
      const status = body.status || (body.duplicate === true ? 'duplicate' : 'created');
      if (!body.id) { lastError = `Immich returned HTTP ${res.status} without an asset id`; continue; }
      return {
        file,
        outcome: status === 'duplicate' ? 'duplicate' : 'uploaded',
        assetId: body.id,
        isTrashed: false,
      };
    }

    if (res.status === 400 && sentLegacy && !legacyRetried &&
        /deviceAssetId|deviceId|Unrecognized key|should not exist/i.test(res.text || '')) {
      // This server validates the multipart body strictly. Drop the legacy
      // compatibility fields for the rest of the run and retry immediately.
      // `sentLegacy` (not the shared flag) is what matters: a parallel worker
      // may have flipped the flag already while this request was in flight.
      legacyFields.send = false;
      legacyRetried = true;
      attempt--;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      errline(`Immich rejected the API key (HTTP ${res.status}) - it needs the asset.upload permission. Aborting.`);
      state.interrupted = true;
      return { file, outcome: 'failed', error: `HTTP ${res.status} ${describeBody(res)}` };
    }
    if (res.status === 413 || res.status === 507) {
      errline(`Immich refused the upload (HTTP ${res.status}: ${describeBody(res)}) - out of quota or disk. Aborting.`);
      state.interrupted = true;
      return { file, outcome: 'failed', error: `HTTP ${res.status} ${describeBody(res)}` };
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status} ${describeBody(res)}`;
      continue;
    }
    return { file, outcome: 'failed', error: `HTTP ${res.status} ${describeBody(res)}` };
  }

  return { file, outcome: 'failed', error: lastError };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary({ opts, source, album, files, skipped, results, albumAdd, startedAt, dryRun }) {
  const uploaded = results.filter((r) => r.outcome === 'uploaded');
  const duplicate = results.filter((r) => r.outcome === 'duplicate');
  const failed = results.filter((r) => r.outcome === 'failed');
  const bytes = uploaded.reduce((n, r) => n + (r.file ? r.file.size : 0), 0);

  const reasons = new Map();
  for (const s of skipped) {
    const key = s.reason.replace(/\(.*\)/, '').trim();
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }

  clearProgress();
  const line = '-'.repeat(64);
  process.stdout.write('\n' + line + '\n');
  process.stdout.write(`${C.bold}import-photos summary${dryRun ? ' (DRY RUN)' : ''}${C.reset}\n`);
  process.stdout.write(`  source        ${source}\n`);
  process.stdout.write(`  album         ${album ? `${album.albumName} (${album.id})` : '(none)'}\n`);
  process.stdout.write(`  considered    ${files.length}\n`);
  process.stdout.write(`  ${C.grn}uploaded${C.reset}      ${uploaded.length}${bytes ? ` (${humanBytes(bytes)})` : ''}\n`);
  process.stdout.write(`  duplicate     ${duplicate.length}\n`);
  process.stdout.write(`  ${failed.length ? C.red : ''}failed${C.reset}        ${failed.length}\n`);
  process.stdout.write(`  skipped       ${skipped.length}${reasons.size ? '  [' + [...reasons].map(([k, v]) => `${k}: ${v}`).join(', ') + ']' : ''}\n`);
  if (albumAdd) {
    process.stdout.write(`  album adds    ${albumAdd.added} new, ${albumAdd.already} already there, ${albumAdd.failed} failed\n`);
  }
  process.stdout.write(`  elapsed       ${humanDuration(Date.now() - startedAt)}\n`);
  process.stdout.write(line + '\n');

  if (failed.length) {
    process.stdout.write(`${C.red}failed files:${C.reset}\n`);
    for (const f of failed.slice(0, 25)) process.stdout.write(`  ${f.file.rel}: ${f.error}\n`);
    if (failed.length > 25) process.stdout.write(`  ... and ${failed.length - 25} more\n`);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      source,
      album: album ? { id: album.id, name: album.albumName } : null,
      considered: files.length,
      uploaded: uploaded.length,
      duplicate: duplicate.length,
      failed: failed.length,
      skipped: skipped.length,
      skippedReasons: Object.fromEntries(reasons),
      albumAdd,
      bytesUploaded: bytes,
      elapsedMs: Date.now() - startedAt,
      failures: failed.map((f) => ({ file: f.file.rel, error: f.error })),
    }, null, 2) + '\n');
  }

  return { uploaded: uploaded.length, duplicate: duplicate.length, failed: failed.length };
}

function finish(ctx) {
  const counts = printSummary(ctx);
  if (ctx.code === 130) {
    process.stdout.write('interrupted\n');
    process.exit(130);
  }
  const bad = counts.failed > 0 || state.hardFailures > 0;
  if (!bad) {
    process.stdout.write(`${C.grn}OK${C.reset} - the frames pick this up within PHOTO_MANIFEST_TTL_MS (5 min by default).\n`);
  }
  process.exit(bad ? 1 : 0);
}

process.on('SIGINT', () => {
  state.interrupted = true;
  clearProgress();
  process.stderr.write('\ninterrupted - finishing in-flight uploads, then stopping\n');
});

main().catch((err) => {
  clearProgress();
  errline(err && err.stack ? err.stack : String(err));
  process.exit(2);
});
