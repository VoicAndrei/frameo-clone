'use strict';

/**
 * The admin API: everything a phone can do once its owner has logged in.
 *
 *   GET    /api/admin/albums            the configured albums, with live names and counts
 *   GET    /api/admin/photos            paginated list, with per-photo album membership
 *   POST   /api/admin/photos            multipart upload of MANY files at once (no cap of 10)
 *   DELETE /api/admin/photos            remove from an album, or delete from the library
 *   POST   /api/admin/photos/delete     alias for the above, for clients that cannot send a
 *                                       body on DELETE
 *   DELETE /api/admin/photos/<assetId>  single-photo form, options in the query string
 *   POST   /api/admin/call              ring a frame as the logged-in admin
 *   GET    /api/admin/frames            per-frame status: online, last seen, in-call, battery
 *
 * Every route here is reached only after requireAdmin() has passed in server.js, and every
 * state-changing route additionally requires the double-submit CSRF header. Nothing in this
 * file re-implements the call whitelist: /api/admin/call goes through the same startCall()
 * the WebSocket handler uses, so canCall() cannot be bypassed by picking a different door.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { MultipartParser, parseBoundary, safeFilename } = require('./multipart');

/** Write one buffer to a stream, respecting backpressure. */
function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    const onError = (err) => reject(err);
    stream.once('error', onError);
    const ok = stream.write(buf, (err) => {
      stream.removeListener('error', onError);
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      stream.once('drain', () => {
        stream.removeListener('error', onError);
        resolve();
      });
    }
  });
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed) {
      resolve();
      return;
    }
    stream.end(() => resolve());
    stream.once('error', () => resolve());
  });
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.immich                 the createImmich() instance
 * @param {(res, status, body)=>void} deps.sendJson
 * @param {(req, limit?)=>Promise<object>} deps.readJsonBody
 * @param {(from:string,to:string,origin:string,extra?:object)=>object} deps.startCall
 * @param {(a:string,b:string)=>{ok:boolean,reason?:string}} deps.canCall
 * @param {()=>Iterable<object>} deps.rosterPeers
 * @param {(id:string)=>object|undefined} deps.getRosterPeer
 * @param {Map<string, object>} deps.peers      live socket registry
 * @param {Map<string, object>} deps.calls
 * @param {()=>void} deps.onPhotosChanged
 */
function createAdmin(deps) {
  const {
    config, immich, sendJson, readJsonBody, startCall, canCall,
    rosterPeers, getRosterPeer, peers, calls, onPhotosChanged,
    logInfo, logWarn, logError,
  } = deps;

  let tmpDirReady = false;

  async function ensureTmpDir() {
    if (tmpDirReady) return;
    await fsp.mkdir(config.uploadTmpDir, { recursive: true });
    tmpDirReady = true;
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/albums
  // -------------------------------------------------------------------------

  async function handleAlbums(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!immich.enabled()) {
      sendJson(res, 503, { error: 'photo-backend-not-configured', detail: 'IMMICH_API_KEY is not set' });
      return;
    }
    await immich.ensureIndex();
    sendJson(res, 200, { albums: immich.describeAlbums() });
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/photos
  // -------------------------------------------------------------------------

  async function handleList(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!immich.enabled()) {
      sendJson(res, 503, { error: 'photo-backend-not-configured', detail: 'IMMICH_API_KEY is not set' });
      return;
    }
    const result = await immich.listPhotos({
      album: url.searchParams.get('album') || '',
      page: Number.parseInt(url.searchParams.get('page') || '', 10),
      pageSize: Number.parseInt(url.searchParams.get('pageSize') || '', 10),
      refresh: url.searchParams.get('refresh') === '1',
    });
    if (!result.ok) {
      sendJson(res, 400, { error: 'bad-request', detail: result.error });
      return;
    }
    sendJson(res, 200, result);
  }

  // -------------------------------------------------------------------------
  // POST /api/admin/photos  (multipart, many files, streamed to disk then to Immich)
  // -------------------------------------------------------------------------

  /**
   * Consume the multipart body, writing every file part to its own temp file.
   * Never holds more than one chunk in memory.
   */
  async function receiveUpload(req) {
    const boundary = parseBoundary(req.headers['content-type']);
    if (!boundary) {
      throw Object.assign(new Error('expected multipart/form-data with a boundary'), { statusCode: 415 });
    }
    await ensureTmpDir();

    const parser = new MultipartParser(boundary);
    const files = [];
    const fields = Object.create(null);
    let totalBytes = 0;

    let currentFile = null;   // { record, stream }
    let currentField = null;  // { name, value }
    let pendingLastModified = null;
    let aborted = null;

    async function handleEvent(ev) {
      if (ev.type === 'part') {
        if (ev.filename !== null && ev.filename !== undefined) {
          if (files.length >= config.uploadMaxFiles) {
            aborted = Object.assign(
              new Error(`too many files in one request (max ${config.uploadMaxFiles})`),
              { statusCode: 413 },
            );
            throw aborted;
          }
          const filename = safeFilename(ev.filename);
          const tmpPath = path.join(
            config.uploadTmpDir,
            `up_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`,
          );
          const record = {
            field: ev.name,
            filename,
            contentType: ev.contentType,
            tmpPath,
            size: 0,
            fileCreatedAt: pendingLastModified,
            error: null,
          };
          pendingLastModified = null;
          files.push(record);
          currentFile = { record, stream: fs.createWriteStream(tmpPath, { mode: 0o600 }) };
        } else {
          currentField = { name: ev.name || '', value: '' };
        }
        return;
      }

      if (ev.type === 'data') {
        if (currentFile) {
          totalBytes += ev.data.length;
          if (totalBytes > config.uploadMaxTotalBytes) {
            aborted = Object.assign(
              new Error(`upload exceeds the total size limit (${config.uploadMaxTotalBytes} bytes)`),
              { statusCode: 413 },
            );
            throw aborted;
          }
          const record = currentFile.record;
          record.size += ev.data.length;
          if (record.size > config.uploadMaxFileBytes) {
            // Stop writing this one but keep parsing so the rest of the request still works.
            if (!record.error) {
              record.error = `file exceeds the per-file limit of ${config.uploadMaxFileBytes} bytes`;
              await closeStream(currentFile.stream);
              currentFile.stream = null;
            }
            return;
          }
          if (currentFile.stream) await writeChunk(currentFile.stream, ev.data);
          return;
        }
        if (currentField) {
          if (currentField.value.length < 8192) {
            currentField.value += ev.data.toString('utf8');
          }
        }
        return;
      }

      if (ev.type === 'part-end') {
        if (currentFile) {
          if (currentFile.stream) await closeStream(currentFile.stream);
          currentFile = null;
          return;
        }
        if (currentField) {
          const name = currentField.name;
          const value = currentField.value.slice(0, 8192);
          if (name === 'lastModified' || name === 'fileCreatedAt') {
            const n = Number(value);
            pendingLastModified = Number.isFinite(n) && n > 0 ? n : Date.parse(value) || null;
          } else if (name) {
            fields[name] = value;
          }
          currentField = null;
        }
      }
    }

    try {
      for await (const piece of req) {
        for (const ev of parser.push(piece)) {
          // eslint-disable-next-line no-await-in-loop
          await handleEvent(ev);
        }
      }
      for (const ev of parser.end()) {
        // eslint-disable-next-line no-await-in-loop
        await handleEvent(ev);
      }
    } catch (err) {
      if (currentFile && currentFile.stream) await closeStream(currentFile.stream);
      // Clean up every temp file we already wrote before rethrowing.
      await Promise.all(files.map((f) => fsp.unlink(f.tmpPath).catch(() => {})));
      throw aborted || err;
    }

    return { files, fields };
  }

  async function handleUpload(req, res, principal) {
    if (!immich.enabled()) {
      sendJson(res, 503, { error: 'photo-backend-not-configured', detail: 'IMMICH_API_KEY is not set' });
      return;
    }

    let received;
    try {
      received = await receiveUpload(req);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 400;
      logWarn('admin.upload_rejected', {
        username: principal.username,
        status,
        error: String((err && err.message) || err),
      });
      sendJson(res, status, { error: 'bad-upload', detail: String((err && err.message) || err) });
      return;
    }

    const { files, fields } = received;

    try {
      if (!files.length) {
        sendJson(res, 400, { error: 'no-files', detail: 'the request contained no file parts' });
        return;
      }

      // Which albums do the new photos join? Default: the "all" album if one is configured,
      // otherwise every configured album.
      const requested = fields.album || fields.albums || '';
      const selection = requested
        ? immich.resolveAlbums(requested)
        : immich.resolveAlbums(immich.albums.some((a) => a.key === 'all') ? 'all' : '');
      if (!selection.ok) {
        sendJson(res, 400, { error: 'bad-request', detail: selection.error });
        return;
      }

      const results = [];
      const uploadedIds = [];
      const concurrency = Math.max(1, Math.min(config.uploadConcurrency, 4));
      let cursor = 0;

      async function worker() {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= files.length) return;
          const file = files[i];
          if (file.error) {
            results[i] = { filename: file.filename, ok: false, error: 'too-large', detail: file.error };
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const outcome = await immich.uploadFile({
            tmpPath: file.tmpPath,
            filename: file.filename,
            size: file.size,
            contentType: file.contentType,
            fileCreatedAt: file.fileCreatedAt,
            fileModifiedAt: file.fileCreatedAt,
          });
          if (outcome.ok) {
            uploadedIds.push(outcome.assetId);
            results[i] = {
              filename: file.filename,
              ok: true,
              assetId: outcome.assetId,
              duplicate: outcome.duplicate === true,
              bytes: file.size,
            };
          } else {
            results[i] = {
              filename: file.filename,
              ok: false,
              error: outcome.error,
              detail: outcome.detail || null,
              bytes: file.size,
            };
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

      let albumResults = [];
      const uniqueIds = [...new Set(uploadedIds)];
      if (uniqueIds.length && selection.albums.length) {
        albumResults = await immich.addToAlbums(selection.albums.map((a) => a.id), uniqueIds);
      }

      immich.invalidate();
      if (typeof onPhotosChanged === 'function') onPhotosChanged();

      const succeeded = results.filter((r) => r && r.ok).length;
      const failed = results.length - succeeded;
      logInfo('admin.upload', {
        username: principal.username,
        files: files.length,
        succeeded,
        failed,
        albums: selection.albums.map((a) => a.key),
        bytes: files.reduce((n, f) => n + f.size, 0),
      });

      sendJson(res, failed && !succeeded ? 502 : 200, {
        ok: succeeded > 0,
        uploaded: succeeded,
        failed,
        albums: selection.albums.map((a) => ({ key: a.key, id: a.id })),
        albumResults,
        results,
      });
    } finally {
      await Promise.all(files.map((f) => fsp.unlink(f.tmpPath).catch(() => {})));
    }
  }

  // -------------------------------------------------------------------------
  // DELETE /api/admin/photos
  // -------------------------------------------------------------------------

  /**
   * `mode` vocabulary. "library" is the canonical name; "permanent" and "trash" are accepted
   * because that is the word the Romanian UI uses ("Sterge definitiv") and a client that says
   * what the button says must not get a 400. None of them implies force:true — that still
   * needs an explicit `force` plus ALLOW_PERMANENT_DELETE.
   */
  const DELETE_MODES = new Map([
    ['album', 'album'],
    ['library', 'library'],
    ['permanent', 'library'],
    ['trash', 'library'],
  ]);

  /**
   * Shared by three doors:
   *   DELETE /api/admin/photos          { ids, mode, album, force }
   *   POST   /api/admin/photos/delete   (same body; for clients that cannot send a DELETE body)
   *   DELETE /api/admin/photos/<id>?mode=&album=   (single asset, options in the query string)
   * `pathId` and `url` are only set by the third.
   */
  async function handleDelete(req, res, principal, pathId, url) {
    if (!immich.enabled()) {
      sendJson(res, 503, { error: 'photo-backend-not-configured', detail: 'IMMICH_API_KEY is not set' });
      return;
    }
    let body = {};
    // A DELETE with an id in the path carries its options in the query string and usually has
    // no body at all; reading one would just stall until the socket closed.
    if (!pathId) {
      try {
        body = await readJsonBody(req, 128 * 1024);
      } catch (err) {
        sendJson(res, err.statusCode || 400, { error: 'bad-body', detail: String((err && err.message) || err) });
        return;
      }
    }

    const query = (url && url.searchParams) ? url.searchParams : null;
    const rawIds = pathId ? [pathId] : (Array.isArray(body.ids) ? body.ids : []);
    const ids = [...new Set(rawIds.filter((x) => typeof x === 'string' && immich.UUID_RE.test(x.trim())).map((x) => x.trim()))];
    if (!ids.length) {
      sendJson(res, 400, { error: 'bad-request', detail: '"ids" must be a non-empty array of Immich asset ids' });
      return;
    }
    if (ids.length > 1000) {
      sendJson(res, 413, { error: 'too-many-ids', detail: 'at most 1000 ids per request' });
      return;
    }

    const rawMode = String(body.mode || (query && query.get('mode')) || 'album').trim().toLowerCase();
    const mode = DELETE_MODES.get(rawMode);
    if (!mode) {
      sendJson(res, 400, {
        error: 'bad-request',
        detail: 'mode must be "album", "library" (aliases: "permanent", "trash")',
      });
      return;
    }
    if (body.album === undefined && query && query.get('album')) body.album = query.get('album');
    if (body.force === undefined && query && query.get('force') === 'true') body.force = true;

    if (mode === 'album') {
      const selection = immich.resolveAlbums(body.album, { allowEmpty: false });
      if (!selection.ok) {
        sendJson(res, 400, { error: 'bad-request', detail: selection.error });
        return;
      }
      let results;
      try {
        results = await immich.removeFromAlbums(selection.albums.map((a) => a.id), ids);
      } catch (err) {
        logError('admin.delete_album_failed', {
          username: principal.username,
          error: String((err && err.message) || err),
        });
        sendJson(res, 502, { error: 'immich-error', detail: String((err && err.message) || err) });
        return;
      }
      immich.invalidate();
      if (typeof onPhotosChanged === 'function') onPhotosChanged();
      const removed = results.reduce((n, r) => n + (r.removed || 0), 0);
      logInfo('admin.photos_removed_from_album', {
        username: principal.username,
        ids: ids.length,
        removed,
        albums: selection.albums.map((a) => a.key),
      });
      sendJson(res, 200, {
        ok: results.every((r) => r.ok),
        mode,
        removed,
        albums: selection.albums.map((a) => ({ key: a.key, id: a.id })),
        results,
      });
      return;
    }

    // mode === 'library'
    const force = body.force === true;
    if (force && !config.allowPermanentDelete) {
      sendJson(res, 403, {
        error: 'permanent-delete-disabled',
        detail: 'set ALLOW_PERMANENT_DELETE=true to enable irreversible deletion',
      });
      return;
    }
    let outcome;
    try {
      outcome = await immich.deleteAssets(ids, { force });
    } catch (err) {
      logError('admin.delete_library_failed', {
        username: principal.username,
        error: String((err && err.message) || err),
      });
      sendJson(res, 502, { error: 'immich-error', detail: String((err && err.message) || err) });
      return;
    }
    immich.invalidate();
    if (typeof onPhotosChanged === 'function') onPhotosChanged();
    logInfo('admin.photos_deleted', {
      username: principal.username,
      ids: ids.length,
      permanent: force,
    });
    sendJson(res, 200, {
      ok: true,
      mode,
      permanent: force,
      deleted: outcome.deleted,
      detail: force
        ? 'assets were permanently deleted'
        : 'assets were moved to the Immich trash and can be restored from the Immich UI',
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/admin/call
  // -------------------------------------------------------------------------

  async function handleCall(req, res, principal) {
    let body;
    try {
      body = await readJsonBody(req, 2048);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: 'bad-body', detail: String((err && err.message) || err) });
      return;
    }
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      sendJson(res, 400, { error: 'bad-request', detail: '"to" (a frame id) is required' });
      return;
    }
    const from = principal.peerId;
    if (!from) {
      logWarn('admin.call_no_peer', { username: principal.username });
      sendJson(res, 409, {
        error: 'account-has-no-peer',
        detail: 'this admin account is not bound to a roster peer',
      });
      return;
    }
    if (!getRosterPeer(from)) {
      logWarn('admin.call_peer_missing_from_roster', { username: principal.username, peerId: from });
      sendJson(res, 409, {
        error: 'account-peer-missing',
        detail: `roster has no peer "${from}"; add it to roster.json`,
        peerId: from,
      });
      return;
    }
    if (!peers.has(from)) {
      // The whitelist is not the problem here: the phone simply has no live signalling socket,
      // so there would be nobody to negotiate WebRTC with.
      sendJson(res, 409, {
        error: 'caller-offline',
        detail: 'open the app and let it connect before starting a call',
        peerId: from,
      });
      return;
    }

    logInfo('admin.call_requested', { username: principal.username, from, to });
    // Exactly the same entry point the WebSocket handler uses: canCall() is enforced inside.
    const result = startCall(from, to, 'admin-api', { actor: principal.username });
    if (!result.ok) {
      const status = result.code === 'not-allowed' ? 403
        : result.code === 'busy' ? 409
          : result.code === 'server-busy' ? 503
            : 409;
      sendJson(res, status, { error: result.code, detail: result.detail, from, to });
      return;
    }
    sendJson(res, 202, { status: 'ringing', callId: result.callId, from, to });
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/frames
  // -------------------------------------------------------------------------

  function handleFrames(req, res, principal) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const now = Date.now();
    const me = principal.peerId;
    const frames = [];
    for (const entry of rosterPeers()) {
      if (entry.kind !== 'frame') continue;
      const live = peers.get(entry.id);
      const gate = me ? canCall(me, entry.id) : { ok: false, reason: 'account-has-no-peer' };
      const call = live && live.callId ? calls.get(live.callId) : null;
      frames.push({
        id: entry.id,
        displayName: entry.displayName,
        online: Boolean(live),
        lastSeen: live ? new Date(live.lastSeen).toISOString() : null,
        lastSeenSecondsAgo: live ? Math.round((now - live.lastSeen) / 1000) : null,
        connectedForSeconds: live ? Math.round((now - live.connectedAt) / 1000) : null,
        inCall: Boolean(call),
        call: call
          ? {
            callId: call.id,
            state: call.state,
            with: call.from === entry.id ? call.to : call.from,
            ageSeconds: Math.round((now - call.createdAt) / 1000),
          }
          : null,
        battery: live && live.battery
          ? {
            level: live.battery.level,
            charging: live.battery.charging,
            reportedSecondsAgo: Math.round((now - live.battery.at) / 1000),
          }
          : null,
        callable: gate.ok,
        notCallableReason: gate.ok ? null : gate.reason,
      });
    }
    frames.sort((a, b) => a.displayName.localeCompare(b.displayName));
    sendJson(res, 200, {
      me: { username: principal.username, displayName: principal.displayName, peerId: me, online: peers.has(me) },
      frames,
    });
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------

  /**
   * @returns {boolean} true if the path was handled here.
   */
  function route(req, res, url, pathname, principal) {
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname === '/api/admin/albums') {
      handleAlbums(req, res).catch((err) => fail(res, 'albums', err));
      return true;
    }
    if (pathname === '/api/admin/photos') {
      if (method === 'GET' || method === 'HEAD') {
        handleList(req, res, url).catch((err) => fail(res, 'list', err));
        return true;
      }
      if (method === 'POST') {
        handleUpload(req, res, principal).catch((err) => fail(res, 'upload', err));
        return true;
      }
      if (method === 'DELETE') {
        handleDelete(req, res, principal).catch((err) => fail(res, 'delete', err));
        return true;
      }
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'use GET, POST or DELETE' });
      return true;
    }
    if (pathname === '/api/admin/photos/delete') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
        return true;
      }
      handleDelete(req, res, principal).catch((err) => fail(res, 'delete', err));
      return true;
    }
    // DELETE /api/admin/photos/<assetId>?mode=album|library&album=<key>
    // The single-photo form the viewer's delete button uses. Registered after the literal
    // /photos/delete path above so the two can never collide.
    if (pathname.startsWith('/api/admin/photos/')) {
      const id = decodeURIComponent(pathname.slice('/api/admin/photos/'.length));
      if (method !== 'DELETE') {
        sendJson(res, 405, { error: 'method-not-allowed', detail: 'use DELETE' });
        return true;
      }
      if (!immich.UUID_RE.test(id)) {
        sendJson(res, 400, { error: 'bad-request', detail: 'not an Immich asset id' });
        return true;
      }
      handleDelete(req, res, principal, id, url).catch((err) => fail(res, 'delete-one', err));
      return true;
    }
    if (pathname === '/api/admin/call') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed', detail: 'use POST' });
        return true;
      }
      handleCall(req, res, principal).catch((err) => fail(res, 'call', err));
      return true;
    }
    if (pathname === '/api/admin/frames') {
      try {
        handleFrames(req, res, principal);
      } catch (err) {
        fail(res, 'frames', err);
      }
      return true;
    }
    return false;
  }

  function fail(res, where, err) {
    logError('admin.handler_threw', { where, error: String((err && err.stack) || err) });
    try {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' });
      else res.destroy();
    } catch { /* ignore */ }
  }

  return { route };
}

module.exports = { createAdmin };
