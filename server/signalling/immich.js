'use strict';

/**
 * Immich client for the admin API: album inventory, streaming upload, album membership and
 * deletion.
 *
 * VERIFIED against the Immich v3.1.0 OpenAPI document (`info.version === "3.1.0"`, the exact
 * version running on this box) on 2026-08-09:
 *
 *   list album assets   POST   /api/search/metadata   { albumIds:[id], type:"IMAGE", size<=1000,
 *                                                       page, withExif:false, order:"desc" }
 *                              -> { assets: { items: [...], total, count, nextPage } }
 *                              GET /api/albums/{id} does NOT return an assets array in v3 —
 *                              only assetCount — so the search endpoint is the only way.
 *   upload              POST   /api/assets  multipart/form-data
 *                              required: assetData, fileCreatedAt, fileModifiedAt
 *                              optional: filename, isFavorite, duration, visibility, ...
 *                              -> 201 { id, status:"created" } | 200 { id, status:"duplicate" }
 *                              NOTE: deviceAssetId / deviceId are NOT part of the v3 DTO. They
 *                              were required in v1. We send the v3 shape first and retry once
 *                              with the legacy pair if the server answers 400, so this module
 *                              works against either generation.
 *   add to album        PUT    /api/albums/{id}/assets   { ids:[...] }  -> BulkIdResponseDto[]
 *   remove from album   DELETE /api/albums/{id}/assets   { ids:[...] }  -> BulkIdResponseDto[]
 *   delete assets       DELETE /api/assets               { ids:[...], force:false }  -> 204
 *                              force:false moves to the Immich trash (recoverable in the Immich
 *                              UI for the configured retention window); force:true is permanent
 *                              and unrecoverable.
 *   thumbnail           GET    /api/assets/{id}/thumbnail?size=thumbnail|preview  (x-api-key)
 *   album names         GET    /api/albums
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

/** Immich ids are UUIDs. Be strict: these values go into upstream URLs and delete calls. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Immich caps `size` at 1000 on the metadata search endpoint. */
const SEARCH_PAGE_SIZE = 1000;

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.hif': 'image/heif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.arw': 'image/x-sony-arw',
  '.orf': 'image/x-olympus-orf',
  '.rw2': 'image/x-panasonic-rw2',
  '.raf': 'image/x-fuji-raf',
  '.srw': 'image/x-samsung-srw',
};

/** Extensions we accept from a phone. HEIC/HEIF are first-class: that is what iPhones send. */
const DEFAULT_ALLOWED_EXTENSIONS = Object.keys(EXT_MIME);

function extensionOf(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 12) return '';
  return name.slice(dot).toLowerCase();
}

function mimeFor(filename, provided) {
  const ext = extensionOf(filename);
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const p = String(provided || '').split(';')[0].trim().toLowerCase();
  if (p && p !== 'application/octet-stream' && /^[a-z]+\/[a-z0-9.+-]+$/.test(p)) return p;
  return 'application/octet-stream';
}

/** Content-Disposition is a latin-1 header: fold anything non-ASCII into a safe placeholder. */
function asciiFilename(filename) {
  const out = String(filename || 'upload.bin')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\u0020-\u007e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  return out || 'upload.bin';
}

/** Immich's date-time pattern demands an ISO-8601 instant with a Z or numeric offset. */
function isoInstant(value) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  const ms = Number.isFinite(t) && t > 0 ? t : Date.now();
  // Clamp absurd client clocks: Immich rejects year 0 and anything beyond the pattern.
  const clamped = Math.min(Math.max(ms, Date.UTC(1970, 0, 1)), Date.now() + 86400000);
  return new Date(clamped).toISOString();
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {(p:string, init?:object)=>Promise<Response>} deps.immichFetch  the server's own helper
 * @param {(msg:string, f?:object)=>void} deps.logInfo
 * @param {(msg:string, f?:object)=>void} deps.logWarn
 * @param {(msg:string, f?:object)=>void} deps.logError
 */
function createImmich(deps) {
  const { config, immichFetch, logInfo, logWarn, logError } = deps;

  const allowedExtensions = new Set(
    (config.uploadAllowedExtensions && config.uploadAllowedExtensions.length
      ? config.uploadAllowedExtensions
      : DEFAULT_ALLOWED_EXTENSIONS
    ).map((e) => (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())),
  );

  /** @type {Array<{key:string,id:string,label:string}>} */
  const albums = config.albums.slice();
  const albumByKey = new Map(albums.map((a) => [a.key, a]));
  const albumById = new Map(albums.map((a) => [a.id, a]));

  /** @type {{at:number, byAlbum:Map<string, Map<string,object>>, error:string|null}} */
  let index = { at: 0, byAlbum: new Map(), error: null };
  let indexInFlight = null;

  /** @type {{at:number, names:Map<string,{name:string,assetCount:number}>}} */
  let albumMeta = { at: 0, names: new Map() };

  function enabled() {
    return Boolean(config.immichApiKey);
  }

  function albumKeys() {
    return albums.map((a) => a.key);
  }

  /**
   * Resolve a caller-supplied `album` selector into concrete album records.
   * Accepts a single key, "both" (a + b), "any"/"all-albums" (every configured album), or a
   * comma-separated list of keys. Unknown keys are an error, never silently ignored.
   * @returns {{ ok: true, albums: Array<object> } | { ok: false, error: string }}
   */
  function resolveAlbums(selector, { allowEmpty = false } = {}) {
    const raw = String(selector === undefined || selector === null ? '' : selector).trim().toLowerCase();
    if (!raw) {
      if (allowEmpty) return { ok: true, albums: [] };
      return { ok: true, albums: albums.slice() };
    }
    if (raw === 'any' || raw === 'all-albums' || raw === '*') return { ok: true, albums: albums.slice() };
    if (raw === 'both') {
      const picked = ['a', 'b'].map((k) => albumByKey.get(k)).filter(Boolean);
      if (!picked.length) return { ok: false, error: 'no "a"/"b" albums are configured' };
      return { ok: true, albums: picked };
    }
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const picked = [];
    for (const key of keys) {
      const album = albumByKey.get(key) || albumById.get(key);
      if (!album) return { ok: false, error: `unknown album "${key}"` };
      if (!picked.includes(album)) picked.push(album);
    }
    if (!picked.length && !allowEmpty) return { ok: false, error: 'no albums selected' };
    return { ok: true, albums: picked };
  }

  // -------------------------------------------------------------------------
  // Album inventory
  // -------------------------------------------------------------------------

  async function refreshAlbumMeta() {
    if (!enabled()) return;
    if (Date.now() - albumMeta.at < config.albumMetaTtlMs) return;
    try {
      const res = await immichFetch('/api/albums');
      if (!res.ok) throw new Error('http-' + res.status);
      const doc = await res.json();
      const names = new Map();
      if (Array.isArray(doc)) {
        for (const a of doc) {
          if (a && typeof a.id === 'string') {
            names.set(a.id, {
              name: String(a.albumName || a.id),
              assetCount: Number(a.assetCount) || 0,
            });
          }
        }
      }
      albumMeta = { at: Date.now(), names };
    } catch (err) {
      // Non-fatal: the configured labels are used instead.
      logWarn('immich.album_meta_failed', { error: String((err && err.message) || err) });
      albumMeta = { at: Date.now(), names: albumMeta.names };
    }
  }

  /** One page of the metadata search. Returns the raw asset items. */
  async function searchPage(albumId, page) {
    const body = {
      type: 'IMAGE',
      size: SEARCH_PAGE_SIZE,
      page,
      withExif: false,
      order: 'desc',
    };
    if (albumId) body.albumIds = [albumId];
    const res = await immichFetch('/api/search/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('immich search returned HTTP ' + res.status);
    const doc = await res.json().catch(() => null);
    const container = (doc && doc.assets) || doc || {};
    const items = Array.isArray(container.items) ? container.items : [];
    const nextPage = container.nextPage === null || container.nextPage === undefined
      ? null
      : Number(container.nextPage);
    return { items, nextPage: Number.isFinite(nextPage) ? nextPage : null };
  }

  function usable(asset) {
    if (!asset || typeof asset.id !== 'string' || !UUID_RE.test(asset.id)) return false;
    if (asset.type && String(asset.type).toUpperCase() !== 'IMAGE') return false;
    if (asset.isTrashed) return false;
    if (asset.visibility && String(asset.visibility).toLowerCase() === 'archive') return false;
    if (asset.isArchived) return false;
    return true;
  }

  function summarise(asset) {
    const raw = asset.fileCreatedAt || asset.localDateTime || asset.createdAt || asset.updatedAt;
    const t = raw ? Date.parse(raw) : NaN;
    return {
      id: asset.id,
      filename: String(asset.originalFileName || asset.id),
      date: Number.isFinite(t) ? new Date(t).toISOString() : null,
      time: Number.isFinite(t) ? t : 0,
      favorite: asset.isFavorite === true,
    };
  }

  /** Rebuild the per-album asset index. Throws so the caller can keep the previous copy. */
  async function buildIndex() {
    const byAlbum = new Map();
    let scanned = 0;
    for (const album of albums) {
      const items = new Map();
      let page = 1;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { items: raw, nextPage } = await searchPage(album.id, page);
        for (const asset of raw) {
          if (usable(asset)) items.set(asset.id, summarise(asset));
        }
        scanned += raw.length;
        if (!raw.length) break;
        if (items.size >= config.adminScanLimit || scanned >= config.adminScanLimit * albums.length) break;
        if (nextPage && nextPage > page) page = nextPage;
        else if (raw.length === SEARCH_PAGE_SIZE) page += 1;
        else break;
      }
      byAlbum.set(album.id, items);
    }
    return byAlbum;
  }

  async function ensureIndex({ force = false } = {}) {
    if (!enabled()) {
      index = { at: Date.now(), byAlbum: new Map(), error: 'immich-api-key-not-set' };
      return index;
    }
    const fresh = !force && Date.now() - index.at < config.adminIndexTtlMs && index.byAlbum.size > 0;
    if (fresh) return index;
    if (!indexInFlight) {
      indexInFlight = buildIndex()
        .then((byAlbum) => {
          index = { at: Date.now(), byAlbum, error: null };
          logInfo('immich.index_refreshed', {
            albums: byAlbum.size,
            assets: [...byAlbum.values()].reduce((n, m) => n + m.size, 0),
          });
        })
        .catch((err) => {
          // Keep whatever we had: a flaky Immich must not blank the admin UI.
          index = { at: Date.now(), byAlbum: index.byAlbum, error: String((err && err.message) || err) };
          logError('immich.index_refresh_failed', { error: index.error });
        })
        .finally(() => {
          indexInFlight = null;
        });
    }
    await indexInFlight;
    return index;
  }

  function invalidate() {
    index = { at: 0, byAlbum: index.byAlbum, error: index.error };
    albumMeta = { at: 0, names: albumMeta.names };
  }

  /**
   * Paginated photo list with album membership.
   * @param {{ album?: string, page?: number, pageSize?: number, refresh?: boolean }} opts
   */
  async function listPhotos(opts = {}) {
    const selection = resolveAlbums(opts.album);
    if (!selection.ok) return { ok: false, error: selection.error };

    await Promise.all([ensureIndex({ force: opts.refresh === true }), refreshAlbumMeta()]);

    const merged = new Map();
    for (const album of selection.albums) {
      const items = index.byAlbum.get(album.id);
      if (!items) continue;
      for (const [id, summary] of items) if (!merged.has(id)) merged.set(id, summary);
    }

    const all = [...merged.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));

    const pageSize = Math.min(Math.max(Number(opts.pageSize) || config.adminPageSize, 1), 500);
    const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(Math.max(Number(opts.page) || 1, 1), pageCount);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);

    const photos = slice.map((s) => ({
      id: s.id,
      filename: s.filename,
      date: s.date,
      favorite: s.favorite,
      albums: albums.filter((a) => (index.byAlbum.get(a.id) || new Map()).has(s.id)).map((a) => a.key),
      thumbnailUrl: `/api/photo/${encodeURIComponent(s.id)}?size=thumbnail`,
      previewUrl: `/api/photo/${encodeURIComponent(s.id)}`,
    }));

    return {
      ok: true,
      photos,
      page,
      pageSize,
      pageCount,
      total: all.length,
      album: opts.album || 'all-albums',
      albums: describeAlbums(),
      cachedAt: index.at ? new Date(index.at).toISOString() : null,
      error: index.error,
    };
  }

  function describeAlbums() {
    return albums.map((a) => {
      const meta = albumMeta.names.get(a.id);
      const items = index.byAlbum.get(a.id);
      return {
        key: a.key,
        id: a.id,
        name: (meta && meta.name) || a.label || a.key,
        count: items ? items.size : (meta && meta.assetCount) || 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  function extensionAllowed(filename) {
    const ext = extensionOf(filename);
    if (!ext) return false;
    return allowedExtensions.has(ext);
  }

  /**
   * Stream one already-buffered-to-disk file into Immich as multipart/form-data. Nothing is
   * ever read into memory beyond a 64 KiB stream chunk.
   *
   * @param {{ tmpPath:string, filename:string, size:number, contentType?:string,
   *           fileCreatedAt?:number, fileModifiedAt?:number }} file
   * @param {{ legacyFields?: boolean }} [opts]
   */
  async function uploadOnce(file, opts = {}) {
    const boundary = '----frameo' + crypto.randomBytes(16).toString('hex');
    const mime = mimeFor(file.filename, file.contentType);
    const created = isoInstant(file.fileCreatedAt);
    const modified = isoInstant(file.fileModifiedAt || file.fileCreatedAt);

    const fields = [
      ['fileCreatedAt', created],
      ['fileModifiedAt', modified],
      ['filename', file.filename],
    ];
    if (opts.legacyFields) {
      // v1/v2 Immich required these. Harmless on v3 unless the DTO forbids unknown fields,
      // which is exactly why they are only sent on a retry.
      fields.push(['deviceAssetId', `frameo-${crypto.randomBytes(8).toString('hex')}`]);
      fields.push(['deviceId', config.uploadDeviceId]);
    }

    async function* body() {
      for (const [name, value] of fields) {
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          'utf8',
        );
      }
      yield Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="assetData"; filename="${asciiFilename(file.filename)}"\r\n`
        + `Content-Type: ${mime}\r\n\r\n`,
        'utf8',
      );
      const stream = fs.createReadStream(file.tmpPath, { highWaterMark: 64 * 1024 });
      for await (const piece of stream) yield piece;
      yield Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.uploadTimeoutMs);
    try {
      const res = await fetch(config.immichUrl + '/api/assets', {
        method: 'POST',
        headers: {
          'x-api-key': config.immichApiKey,
          accept: 'application/json',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: Readable.from(body()),
        duplex: 'half',
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let doc = null;
      try {
        doc = text ? JSON.parse(text) : null;
      } catch {
        doc = null;
      }
      return { status: res.status, ok: res.ok, doc, text: text.slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Upload one file, transparently retrying once with the legacy field set if the server
   * rejects the v3 shape.
   * @returns {Promise<{ok:boolean, assetId?:string, duplicate?:boolean, error?:string, status?:number}>}
   */
  async function uploadFile(file) {
    if (!enabled()) return { ok: false, error: 'immich-api-key-not-set' };
    if (!extensionAllowed(file.filename)) {
      return { ok: false, error: 'unsupported-file-type', detail: extensionOf(file.filename) || 'no extension' };
    }
    if (!file.size) return { ok: false, error: 'empty-file' };

    let result;
    try {
      result = await uploadOnce(file, { legacyFields: false });
    } catch (err) {
      const message = String((err && err.message) || err);
      logWarn('immich.upload_transport_failed', { filename: file.filename, error: message });
      return { ok: false, error: 'upstream-unreachable', detail: message };
    }

    if (result.status === 400) {
      logWarn('immich.upload_retry_legacy_fields', {
        filename: file.filename,
        detail: 'server rejected the v3 upload DTO; retrying with deviceAssetId/deviceId',
      });
      try {
        result = await uploadOnce(file, { legacyFields: true });
      } catch (err) {
        return { ok: false, error: 'upstream-unreachable', detail: String((err && err.message) || err) };
      }
    }

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: 'immich-rejected-upload',
        detail: result.text || ('http-' + result.status),
      };
    }
    const id = result.doc && typeof result.doc.id === 'string' ? result.doc.id : null;
    if (!id || !UUID_RE.test(id)) {
      return { ok: false, status: result.status, error: 'immich-returned-no-asset-id' };
    }
    const duplicate = String((result.doc && result.doc.status) || '') === 'duplicate';
    return { ok: true, assetId: id, duplicate, status: result.status };
  }

  // -------------------------------------------------------------------------
  // Album membership and deletion
  // -------------------------------------------------------------------------

  async function albumBulk(method, albumId, ids) {
    const results = [];
    for (const batch of chunk(ids, 100)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await immichFetch(`/api/albums/${encodeURIComponent(albumId)}/assets`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`immich ${method} /albums/${albumId}/assets returned HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const doc = await res.json().catch(() => []);
      if (Array.isArray(doc)) results.push(...doc);
    }
    return results;
  }

  /** PUT /api/albums/{id}/assets — add. Duplicates come back as success:false, error:"duplicate". */
  async function addToAlbums(albumIds, assetIds) {
    const out = [];
    for (const albumId of albumIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const results = await albumBulk('PUT', albumId, assetIds);
        const added = results.filter((r) => r && r.success).length;
        const duplicates = results.filter((r) => r && !r.success && r.error === 'duplicate').length;
        const failed = results.filter((r) => r && !r.success && r.error !== 'duplicate');
        out.push({ albumId, added, duplicates, failed: failed.length, ok: true });
        if (failed.length) {
          logWarn('immich.album_add_partial', {
            albumId,
            failed: failed.length,
            reasons: [...new Set(failed.map((f) => f.error || 'unknown'))],
          });
        }
      } catch (err) {
        const message = String((err && err.message) || err);
        logError('immich.album_add_failed', { albumId, error: message });
        out.push({ albumId, ok: false, error: message });
      }
    }
    return out;
  }

  /** DELETE /api/albums/{id}/assets — remove from the album, the asset itself is untouched. */
  async function removeFromAlbums(albumIds, assetIds) {
    const out = [];
    for (const albumId of albumIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const results = await albumBulk('DELETE', albumId, assetIds);
        const removed = results.filter((r) => r && r.success).length;
        const failed = results.filter((r) => r && !r.success);
        out.push({
          albumId,
          removed,
          failed: failed.length,
          ok: true,
          reasons: [...new Set(failed.map((f) => f.error || 'unknown'))],
        });
      } catch (err) {
        const message = String((err && err.message) || err);
        logError('immich.album_remove_failed', { albumId, error: message });
        out.push({ albumId, ok: false, error: message });
      }
    }
    return out;
  }

  /**
   * DELETE /api/assets — remove from the library.
   * `force:false` (the default) moves the assets to the Immich trash so a mis-tap is
   * recoverable from the Immich UI. `force:true` is permanent.
   */
  async function deleteAssets(ids, { force = false } = {}) {
    let deleted = 0;
    for (const batch of chunk(ids, 100)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await immichFetch('/api/assets', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: batch, force: Boolean(force) }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`immich DELETE /assets returned HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      deleted += batch.length;
    }
    return { deleted };
  }

  return {
    enabled,
    albums,
    albumKeys,
    resolveAlbums,
    describeAlbums,
    listPhotos,
    ensureIndex,
    invalidate,
    uploadFile,
    addToAlbums,
    removeFromAlbums,
    deleteAssets,
    extensionAllowed,
    allowedExtensions: [...allowedExtensions],
    UUID_RE,
  };
}

module.exports = { createImmich, UUID_RE, EXT_MIME, DEFAULT_ALLOWED_EXTENSIONS, mimeFor, extensionOf };
