'use strict';

/**
 * A dependency-free, streaming `multipart/form-data` parser.
 *
 * Why hand-rolled: the container ships exactly one runtime dependency ("ws"), and the two
 * obvious alternatives are both wrong here.
 *   - `new Response(req, { headers }).formData()` (undici) works, but materialises every file
 *     in memory as a Blob. A parent selecting 120 iPhone photos would be several GB inside a
 *     container with MemoryMax=5G shared with Immich and Postgres. Non-starter.
 *   - busboy/formidable are extra dependencies.
 *
 * Design: a *push* parser. You feed it byte chunks and it returns a list of events. It never
 * performs I/O itself and never buffers more than one chunk plus the boundary length, so the
 * caller keeps full control over backpressure:
 *
 *     for await (const chunk of req) {
 *       for (const ev of parser.push(chunk)) await handle(ev);   // await = backpressure
 *     }
 *     for (const ev of parser.end()) await handle(ev);
 *
 * Events:
 *   { type: 'part',  name, filename, contentType, headers }   a new part started
 *   { type: 'data',  data: Buffer }                           bytes of the current part
 *   { type: 'part-end' }                                      current part finished
 *   { type: 'done' }                                          final boundary seen
 *
 * Errors are thrown from push()/end() with `.statusCode = 400`.
 */

const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

/** Extract and validate the boundary from a Content-Type header. Returns null if unusable. */
function parseBoundary(contentType) {
  if (typeof contentType !== 'string') return null;
  if (!/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  const m = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = String(m[1] !== undefined ? m[1] : m[2] || '').trim();
  // RFC 2046: 1..70 characters from a restricted set. Be strict; this goes into a byte matcher.
  if (!boundary || boundary.length > 70) return null;
  if (!/^[0-9A-Za-z'()+_,\-./:=?\s]+$/.test(boundary)) return null;
  if (/\s$/.test(boundary)) return null;
  return boundary;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'BAD_MULTIPART' });
}

/**
 * Parse one `Name: value` header block (already split off at the blank line).
 * Header names are lowercased. Duplicate names keep the first occurrence.
 */
function parseHeaderBlock(raw) {
  const headers = Object.create(null);
  if (!raw) return headers;
  for (const line of raw.split('\r\n')) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!name || name in headers) continue;
    headers[name] = value;
  }
  return headers;
}

/** Pull one parameter out of a header value, handling both quoted and RFC 5987 forms. */
function headerParam(value, param) {
  if (!value) return null;
  // RFC 5987 / 2231 extended form wins when present: filename*=UTF-8''%E2%80%A6
  const ext = new RegExp('(?:^|;)\\s*' + param + '\\*\\s*=\\s*([^;]+)', 'i').exec(value);
  if (ext) {
    const raw = ext[1].trim();
    const m = /^([A-Za-z0-9!#$%&+^_`{}~.-]*)'([A-Za-z0-9-]*)'(.*)$/.exec(raw);
    if (m) {
      try {
        return decodeURIComponent(m[3]);
      } catch {
        /* fall through to the plain form */
      }
    }
  }
  const plain = new RegExp('(?:^|;)\\s*' + param + '\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))', 'i')
    .exec(value);
  if (!plain) return null;
  if (plain[1] !== undefined) return plain[1].replace(/\\(.)/g, '$1');
  return String(plain[2] || '').trim();
}

class MultipartParser {
  /**
   * @param {string} boundary  the raw boundary value (no leading dashes)
   * @param {{ maxHeaderBytes?: number }} [opts]
   */
  constructor(boundary, opts = {}) {
    if (typeof boundary !== 'string' || !boundary) throw badRequest('missing multipart boundary');
    // The classic trick: treat the stream as if it began with CRLF so that the very first
    // boundary looks exactly like every subsequent one ("\r\n--boundary").
    this.delim = Buffer.from('\r\n--' + boundary, 'latin1');
    this.maxHeaderBytes = opts.maxHeaderBytes || DEFAULT_MAX_HEADER_BYTES;
    this.buf = Buffer.alloc(0);
    this.state = 'preamble';
    this.started = false;
    this.finished = false;
    this.inPart = false;
  }

  /**
   * Feed bytes. Returns an array of events, possibly empty.
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (this.finished) return [];
    if (!chunk || chunk.length === 0) return [];
    if (!this.started) {
      this.started = true;
      this.buf = Buffer.concat([Buffer.from('\r\n', 'latin1'), chunk]);
    } else {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    }
    return this._drain();
  }

  /** Signal end of input. Throws if the body was truncated mid-part. */
  end() {
    if (this.finished) return [];
    const events = this._drain();
    if (!this.finished) {
      throw badRequest('multipart body ended before the closing boundary');
    }
    return events;
  }

  _drain() {
    const events = [];
    for (;;) {
      if (this.state === 'preamble') {
        const idx = this.buf.indexOf(this.delim);
        if (idx === -1) {
          // Keep only what could still be a partial delimiter.
          const keep = this.delim.length - 1;
          if (this.buf.length > keep) this.buf = this.buf.subarray(this.buf.length - keep);
          return events;
        }
        this.buf = this.buf.subarray(idx + this.delim.length);
        this.state = 'after-boundary';
        continue;
      }

      if (this.state === 'after-boundary') {
        if (this.buf.length < 2) return events;
        if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
          // "--" -> closing boundary. Whatever follows is the epilogue; ignore it.
          this.finished = true;
          this.buf = Buffer.alloc(0);
          events.push({ type: 'done' });
          return events;
        }
        // Transport padding (spaces/tabs) is legal between the boundary and the CRLF.
        let i = 0;
        while (i < this.buf.length && (this.buf[i] === 0x20 || this.buf[i] === 0x09)) i++;
        if (i + 1 >= this.buf.length) {
          if (i > 64) throw badRequest('malformed multipart boundary padding');
          return events; // need more bytes
        }
        if (this.buf[i] !== 0x0d || this.buf[i + 1] !== 0x0a) {
          throw badRequest('malformed multipart boundary');
        }
        this.buf = this.buf.subarray(i + 2);
        this.state = 'headers';
        continue;
      }

      if (this.state === 'headers') {
        const idx = this.buf.indexOf('\r\n\r\n', 0, 'latin1');
        if (idx === -1) {
          if (this.buf.length > this.maxHeaderBytes) throw badRequest('multipart part headers too large');
          return events;
        }
        if (idx > this.maxHeaderBytes) throw badRequest('multipart part headers too large');
        const headers = parseHeaderBlock(this.buf.subarray(0, idx).toString('utf8'));
        this.buf = this.buf.subarray(idx + 4);
        const disposition = headers['content-disposition'] || '';
        const name = headerParam(disposition, 'name');
        const filename = headerParam(disposition, 'filename');
        this.inPart = true;
        events.push({
          type: 'part',
          name: name === null ? null : String(name),
          filename: filename === null ? null : String(filename),
          contentType: headers['content-type'] || null,
          headers,
        });
        this.state = 'body';
        continue;
      }

      if (this.state === 'body') {
        const idx = this.buf.indexOf(this.delim);
        if (idx === -1) {
          const keep = this.delim.length - 1;
          if (this.buf.length > keep) {
            const data = this.buf.subarray(0, this.buf.length - keep);
            // Copy: subarray aliases the concat buffer, which we are about to drop.
            events.push({ type: 'data', data: Buffer.from(data) });
            this.buf = Buffer.from(this.buf.subarray(this.buf.length - keep));
          }
          return events;
        }
        if (idx > 0) events.push({ type: 'data', data: Buffer.from(this.buf.subarray(0, idx)) });
        events.push({ type: 'part-end' });
        this.inPart = false;
        this.buf = Buffer.from(this.buf.subarray(idx + this.delim.length));
        this.state = 'after-boundary';
        continue;
      }

      return events;
    }
  }
}

/**
 * Turn an arbitrary client-supplied filename into something safe to hand to Immich and to log.
 * Strips directory components, control characters and NULs; never returns an empty string.
 */
function safeFilename(name, fallback = 'upload.bin') {
  let out = String(name === null || name === undefined ? '' : name);
  // Windows clients sometimes send a full path.
  out = out.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  if (!out) return fallback;
  if (out.length > 200) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : '';
    out = out.slice(0, 200 - ext.length) + ext;
  }
  return out || fallback;
}

module.exports = { MultipartParser, parseBoundary, safeFilename, headerParam };
