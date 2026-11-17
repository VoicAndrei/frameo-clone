/* =============================================================================
 * Rama familiei — admin app for phones
 * =============================================================================
 * Audience: Ana plus two parents in their sixties, on an iPhone and an
 * Android, from anywhere on the public internet.
 *
 * Hard rules this file obeys:
 *   - No inline script, no inline style, no CDN. The CSP forbids all three.
 *   - No raw error text ever reaches the screen. Everything goes through
 *     `humanError()` and comes out as one calm Romanian sentence.
 *   - The UI never blocks. Uploads run in the background across screen
 *     switches; a dead network shows a banner and keeps retrying.
 *   - Server-side truth wins: the roster decides who may be called, the
 *     session cookie decides who we are, the server mints the ICE servers.
 *
 * Server contract — verified against signalling/server.js + admin.js, not from memory:
 *   GET    /api/auth/session          -> {authenticated, username, displayName, peerId, csrfToken}
 *   POST   /api/auth/login            {username?, password}
 *   POST   /api/auth/logout           /  /api/auth/logout-all
 *   GET    /api/admin/albums          -> {albums:[{key,id,name,count}]}   keys are a | b | all
 *   GET    /api/admin/photos?album=&page=&pageSize=
 *                                     -> {photos:[{id,filename,date,favorite,albums,
 *                                         thumbnailUrl,previewUrl}], page,pageCount,total}
 *                                     album selector: a | b | all | both | any | ''
 *   POST   /api/admin/photos          multipart: album=<key>, fileCreatedAt, <file parts>
 *   POST   /api/admin/photos/delete   {ids:[...], mode:"album"|"library", album?}
 *   GET    /api/turn-credentials      (alias of /api/ice)
 *   WS     /ws                        (register, call-*, offer, answer, ice-candidate, hangup)
 *
 * Every state-changing request carries the X-Frameo-CSRF header, read from the non-HttpOnly
 * frameo_csrf cookie the server sets alongside the session.
 *
 * Every one of those except the auth trio degrades gracefully if the server
 * has not implemented it yet: the gallery falls back to the read-only
 * /api/photos manifest the tablets already use.
 * ========================================================================== */

'use strict';

(function () {

  /* =========================================================================
   * 0. Tiny helpers
   * ====================================================================== */

  var $ = function (id) { return document.getElementById(id); };

  function on(node, type, fn, opts) {
    if (node) node.addEventListener(type, fn, opts || false);
  }

  function show(node, yes) {
    if (node) node.hidden = !yes;
  }

  function text(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  /** Never throws. Used everywhere a failure must not take the app down. */
  function attempt(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function plural(n, one, few, many) {
    // Romanian: 1 poza / 2..19 poze / 20+ de poze
    var abs = Math.abs(n);
    if (abs === 1) return one;
    if (abs === 0 || (abs % 100 >= 1 && abs % 100 <= 19)) return few;
    return many;
  }

  function photoCountLabel(n) {
    return n + ' ' + plural(n, 'poza', 'poze', 'de poze');
  }

  function readCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
    }
    return '';
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun',
                  'iul', 'aug', 'sep', 'oct', 'noi', 'dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatDuration(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* --- toast --------------------------------------------------------------- */

  var toastTimer = 0;
  function toast(message, kind, ms) {
    var el = $('toast');
    if (!el) return;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    text(el, message);
    show(el, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { show(el, false); }, ms || 3200);
  }

  /* --- bottom sheet -------------------------------------------------------- */

  var Sheet = {
    open: function (opts) {
      var sheet = $('sheet');
      var actions = $('sheet-actions');
      text($('sheet-title'), opts.title || '');
      text($('sheet-text'), opts.text || '');
      actions.textContent = '';

      (opts.actions || []).forEach(function (a) {
        if (a.hint) {
          var hint = document.createElement('p');
          hint.className = 'sheet-hint';
          hint.textContent = a.hint;
          actions.appendChild(hint);
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.style || 'btn-quiet');
        b.textContent = a.label;
        on(b, 'click', function () {
          Sheet.close();
          if (a.onSelect) attempt(a.onSelect);
        });
        actions.appendChild(b);
      });

      show($('sheet-backdrop'), true);
      show(sheet, true);
    },
    close: function () {
      show($('sheet'), false);
      show($('sheet-backdrop'), false);
    }
  };

  /* =========================================================================
   * 1. Network layer
   * ====================================================================== */

  function ApiError(status, code, message) {
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || '';
    this.message = message || code || ('http-' + status);
  }
  ApiError.prototype = Object.create(Error.prototype);

  var NET_MSG = {
    'invalid-credentials': 'Parola nu e buna. Mai incearca o data.',
    'locked-out':          'Prea multe incercari gresite. Asteapta un sfert de ora.',
    'rate-limited':        'Prea multe incercari. Asteapta un sfert de ora.',
    'csrf':                'Sesiunea s-a incurcat. Reincarca pagina.',
    'unauthenticated':     'Sesiunea a expirat. Intra din nou cu parola.',
    'not-implemented':     'Serverul nu stie inca sa faca asta.',
    'payload-too-large':   'Poza e prea mare pentru server.',
    'unsupported-media':   'Formatul acestei poze nu e acceptat.'
  };

  /** One calm Romanian sentence for any failure. Never leaks a stack trace. */
  function humanError(err, fallback) {
    if (!err) return fallback || 'Ceva nu a mers. Mai incearca.';
    if (err instanceof ApiError || err.name === 'ApiError') {
      if (NET_MSG[err.code]) return NET_MSG[err.code];
      if (err.status === 0) return 'Nu am putut ajunge la server. Verifica internetul.';
      if (err.status === 401 || err.status === 403) return NET_MSG['unauthenticated'];
      if (err.status === 404 || err.status === 501) return NET_MSG['not-implemented'];
      if (err.status === 413) return NET_MSG['payload-too-large'];
      if (err.status === 415) return NET_MSG['unsupported-media'];
      if (err.status === 429) return NET_MSG['rate-limited'];
      if (err.status >= 500) return 'Serverul are o problema. Incearca peste cateva minute.';
    }
    return fallback || 'Ceva nu a mers. Mai incearca.';
  }

  var Net = {
    /** Fired when the server tells us the session is gone. */
    onUnauthenticated: null,

    request: function (path, opts) {
      opts = opts || {};
      var method = opts.method || 'GET';
      var headers = { accept: 'application/json' };
      if (method !== 'GET' && method !== 'HEAD') {
        var csrf = readCookie('frameo_csrf');
        if (csrf) headers['X-Frameo-CSRF'] = csrf;
      }
      if (opts.json !== undefined) headers['content-type'] = 'application/json';
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });

      var init = {
        method: method,
        headers: headers,
        credentials: 'same-origin',
        cache: 'no-store'
      };
      if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
      if (opts.signal) init.signal = opts.signal;

      return fetch(path, init).then(function (res) {
        var ctype = String(res.headers.get('content-type') || '');
        var isJson = ctype.indexOf('application/json') >= 0;

        // The server redirects HTML requests to /login when the session is
        // gone; fetch follows it and hands us an HTML 200. Treat that as 401
        // rather than exploding on JSON.parse.
        if (res.ok && !isJson && ctype.indexOf('text/html') >= 0) {
          Net.fireUnauthenticated();
          throw new ApiError(401, 'unauthenticated');
        }

        return (isJson ? res.json().catch(function () { return null; })
                       : Promise.resolve(null)).then(function (body) {
          if (res.ok) return body === null ? {} : body;
          var code = (body && (body.error || body.code)) || '';
          if (res.status === 401) {
            Net.fireUnauthenticated();
            throw new ApiError(401, code || 'unauthenticated');
          }
          var err = new ApiError(res.status, code, (body && body.detail) || code);
          err.retryAfter = Number(res.headers.get('retry-after')) || 0;
          err.body = body;
          throw err;
        });
      }, function () {
        // Transport failure: DNS, offline, TLS, timeout.
        throw new ApiError(0, 'network');
      });
    },

    fireUnauthenticated: function () {
      if (Net.onUnauthenticated) attempt(Net.onUnauthenticated);
    },

    get:  function (p, o) { return Net.request(p, o); },
    post: function (p, body, o) {
      o = o || {}; o.method = 'POST'; if (body !== undefined) o.json = body;
      return Net.request(p, o);
    },
    del: function (p, o) {
      o = o || {}; o.method = 'DELETE';
      return Net.request(p, o);
    }
  };

  /* =========================================================================
   * 2. Album model
   * ====================================================================== */

  /* The three Immich albums, by the stable keys the SERVER uses — 'a', 'b' and
   * 'all' (buildAlbumConfig() in server.js). These must match exactly: they are
   * sent verbatim as ?album= and as the multipart `album` field, and the server
   * answers 400 "unknown album" for anything it does not recognise. If
   * /api/admin/albums answers, its list wins; this is the fallback so the UI is
   * never empty and the labels are never technical.
   *
   * `frames` is UI-only (the A / B badge on a tile) and is not part of the
   * server payload, so it is re-attached by key after every load. */
  var ALBUM_FRAMES = {
    a:   ['frame-a'],
    b:   ['frame-b'],
    all: ['frame-a', 'frame-b']
  };

  var DEFAULT_ALBUMS = [
    { key: 'a',   name: 'Bunicii A',   tab: 'Bunicii A', frames: ALBUM_FRAMES.a },
    { key: 'b',   name: 'Bunicii B',   tab: 'Bunicii B', frames: ALBUM_FRAMES.b },
    { key: 'all', name: 'Ambele rame', tab: 'Ambele',    frames: ALBUM_FRAMES.all }
  ];

  /* The gallery's "everything" tab. It CANNOT be called 'all': that is the key
   * of the real "Toti" album, and the server would filter to just that one. The
   * server spells "every configured album" as 'any'. */
  var ANY_ALBUM = 'any';

  var Albums = {
    list: DEFAULT_ALBUMS.slice(),
    byKey: {},
    frameLetter: {},        // frame roster id -> "A" / "B" / ...

    index: function () {
      Albums.byKey = {};
      Albums.frameLetter = {};
      var letters = 'ABCDEFGH';
      var seen = [];
      Albums.list.forEach(function (a) {
        Albums.byKey[a.key] = a;
        (a.frames || []).forEach(function (f) {
          if (seen.indexOf(f) < 0) seen.push(f);
        });
      });
      // Stable order: sort by roster id so "frame-a" is always A.
      seen.sort().forEach(function (f, i) {
        Albums.frameLetter[f] = letters.charAt(i) || String(i + 1);
      });
    },

    load: function () {
      return Net.get('/api/admin/albums').then(function (doc) {
        var raw = (doc && (doc.albums || doc.list)) || [];
        if (!Array.isArray(raw) || !raw.length) return;
        var mapped = raw.map(function (a, i) {
          var key = String(a.key || a.id || ('album-' + i));
          var known = DEFAULT_ALBUMS.filter(function (d) { return d.key === key; })[0];
          // The server sends the LIVE Immich album name; prefer it over our label.
          var name = String(a.name || a.displayName || (known && known.name) || key);
          return {
            key: key,
            id: a.id || null,
            name: name,
            tab: String(a.tab || (known && known.tab) || name),
            // /api/admin/albums has no `frames` field — it is a UI concept. Re-attach it by
            // key, or the A/B badge silently disappears from every tile.
            frames: Array.isArray(a.frames) ? a.frames
              : (Array.isArray(a.frameIds) ? a.frameIds
                : (ALBUM_FRAMES[key] || (known && known.frames) || [])),
            count: typeof a.count === 'number' ? a.count : null
          };
        });
        Albums.list = mapped;
      }).catch(function () {
        /* Endpoint missing or unreachable: the defaults are correct anyway. */
      }).then(function () {
        Albums.index();
      });
    },

    /** Short badge for a photo: which frames show it. "A", "B", "A+B". */
    badge: function (keys) {
      if (!keys || !keys.length) return '';
      var letters = [];
      keys.forEach(function (k) {
        var a = Albums.byKey[k];
        (a ? (a.frames || []) : []).forEach(function (f) {
          var letter = Albums.frameLetter[f];
          if (letter && letters.indexOf(letter) < 0) letters.push(letter);
        });
      });
      if (!letters.length) return '';
      return letters.sort().join('+');
    },

    /** Long, human sentence: "Se vede pe: Bunicii A, Ambele rame". */
    describe: function (keys) {
      if (!keys || !keys.length) return 'Nu stiu pe ce rama e';
      var names = keys.map(function (k) {
        return Albums.byKey[k] ? Albums.byKey[k].name : k;
      });
      return 'Se vede pe: ' + names.join(', ');
    }
  };
  Albums.index();

  /* =========================================================================
   * 3. Photo API, with a read-only fallback to the tablet manifest
   * ====================================================================== */

  var PAGE_SIZE = 60;

  var Photos = {
    legacy: false,          // true once we know /api/admin/photos does not exist
    legacyCache: null,      // full list from /api/photos, cached client side

    /** Is a status code "this endpoint is simply not there"? */
    missing: function (err) {
      return err && err.status && (err.status === 404 || err.status === 405 || err.status === 501);
    },

    /**
     * The grid must load the THUMBNAIL, not the preview. /api/admin/photos gives us both
     * (`thumbnailUrl` ~15 KB, `previewUrl` ~200 KB); the read-only /api/photos fallback gives
     * only `url`, which is the preview. Getting this wrong costs a parent on mobile data
     * roughly 12 MB per screenful of gallery.
     */
    normalize: function (raw) {
      var id = String(raw.id || '');
      var preview = raw.previewUrl || raw.url || ('/api/photo/' + encodeURIComponent(id));
      var thumb = raw.thumbnailUrl
        || (raw.url ? raw.url : '/api/photo/' + encodeURIComponent(id) + '?size=thumbnail');
      var albums = raw.albums || raw.albumKeys || null;
      return {
        id: id,
        url: thumb,
        fullUrl: preview,
        // The admin API calls it `date`; the legacy manifest has no date at all.
        createdAt: raw.date || raw.createdAt || raw.fileCreatedAt || raw.localDateTime || null,
        // The admin API calls it `filename` (lower-case n).
        fileName: raw.filename || raw.fileName || raw.originalFileName || '',
        albums: Array.isArray(albums) ? albums.map(String) : null
      };
    },

    /** Resolves to {items, hasMore, total}. */
    page: function (albumKey, page) {
      if (!Photos.legacy) {
        var qs = '?album=' + encodeURIComponent(albumKey || ANY_ALBUM) +
                 '&page=' + page + '&pageSize=' + PAGE_SIZE;
        return Net.get('/api/admin/photos' + qs).then(function (doc) {
          var raw = (doc && (doc.photos || doc.items)) || null;
          if (!Array.isArray(raw)) throw new ApiError(501, 'not-implemented');
          var items = raw.map(Photos.normalize).filter(function (p) { return p.id; });
          // The server reports pageCount; trust it. Guessing from `items.length >= PAGE_SIZE`
          // gets the exact-multiple case wrong and leaves the spinner running forever.
          var hasMore = typeof doc.pageCount === 'number' && typeof doc.page === 'number'
            ? doc.page < doc.pageCount
            : (typeof doc.hasMore === 'boolean' ? doc.hasMore : items.length >= PAGE_SIZE);
          return { items: items, hasMore: hasMore, total: doc.total, legacy: false };
        }).catch(function (err) {
          if (!Photos.missing(err)) throw err;
          Photos.legacy = true;
          return Photos.page(albumKey, page);
        });
      }

      // Fallback: the read-only manifest the tablets use. No album data, no
      // server paging — we page it client side so the grid still feels normal.
      var load = Photos.legacyCache
        ? Promise.resolve(Photos.legacyCache)
        : Net.get('/api/photos?limit=1000').then(function (doc) {
            var raw = (doc && doc.photos) || [];
            Photos.legacyCache = raw.map(Photos.normalize).filter(function (p) { return p.id; });
            return Photos.legacyCache;
          });

      return load.then(function (all) {
        var start = (page - 1) * PAGE_SIZE;
        return {
          items: all.slice(start, start + PAGE_SIZE),
          hasMore: start + PAGE_SIZE < all.length,
          total: all.length,
          legacy: true
        };
      });
    },

    forget: function () {
      Photos.legacyCache = null;
    },

    /**
     * Delete in ONE request, not one per photo.
     *
     * The server's contract is a bulk body: POST /api/admin/photos/delete
     * {ids, mode:"album"|"library", album}. POST rather than DELETE because
     * DELETE-with-a-body is unreliable through proxies and some XHR stacks, and the server
     * registers this path precisely as the escape hatch for that.
     *
     * `mode` is passed through as the UI's own word ("permanent"); the server aliases it to
     * "library". force is deliberately never sent: a library delete goes to the Immich trash,
     * where a mis-tap at 23:00 is still recoverable.
     *
     * @returns Promise<{ok:string[], failed:string[]}>
     */
    remove: function (ids, mode, albumKey) {
      var body = { ids: ids, mode: mode };
      if (mode === 'album' && albumKey) body.album = albumKey;
      return Net.post('/api/admin/photos/delete', body).then(function (doc) {
        // mode=album reports per-album results; mode=library reports a count. Neither tells
        // us WHICH id failed, so treat a 2xx as "all of them" and let a refresh correct any
        // partial failure — the alternative is inventing a status the server did not send.
        var ok = (doc && doc.ok !== false);
        return ok ? { ok: ids, failed: [] } : { ok: [], failed: ids };
      });
    }
  };

  /* =========================================================================
   * 4. Session / login
   * ====================================================================== */

  var DEFAULT_ACCOUNTS = [
    { username: 'ana', label: 'Ana' },
    { username: 'ion',   label: 'Ion' },
    { username: 'maria',   label: 'Maria' }
  ];

  var Session = {
    account: null,          // {username, displayName, peerId}
    accounts: DEFAULT_ACCOUNTS.slice(),
    chosen: '',

    normalize: function (doc) {
      if (!doc) return null;
      var src = doc.account || doc.session || doc;
      var authed = doc.authenticated === true || doc.ok === true || !!src.username;
      if (!authed || !src.username) return null;
      return {
        username: String(src.username),
        displayName: String(src.displayName || src.username),
        peerId: String(src.peerId || src.peer || '')
      };
    },

    fetch: function () {
      return Net.get('/api/auth/session').then(function (doc) {
        if (doc && Array.isArray(doc.accounts) && doc.accounts.length) {
          Session.accounts = doc.accounts.map(function (a) {
            if (typeof a === 'string') return { username: a, label: a };
            return {
              username: String(a.username || ''),
              label: String(a.displayName || a.label || a.username || '')
            };
          }).filter(function (a) { return a.username; });
        }
        Session.account = Session.normalize(doc);
        return Session.account;
      }).catch(function (err) {
        if (err && err.status === 401) { Session.account = null; return null; }
        throw err;
      });
    },

    login: function (username, password) {
      return Net.post('/api/auth/login', { username: username, password: password })
        .then(function (doc) {
          var acct = Session.normalize(doc);
          if (acct) { Session.account = acct; return acct; }
          // Server answered 200 without a body we understand — ask it directly.
          return Session.fetch().then(function (a) {
            if (!a) throw new ApiError(401, 'invalid-credentials');
            return a;
          });
        });
    },

    logout: function (everywhere) {
      var path = everywhere ? '/api/auth/logout-all' : '/api/auth/logout';
      return Net.post(path, {}).catch(function () { /* leaving anyway */ });
    }
  };

  var Login = {
    build: function () {
      var box = $('who-list');
      box.textContent = '';
      var last = attempt(function () { return localStorage.getItem('rama.user'); }) || '';

      Session.accounts.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'who-chip';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.dataset.username = a.username;
        b.textContent = a.label;
        on(b, 'click', function () { Login.choose(a.username); });
        box.appendChild(b);
      });

      var other = document.createElement('button');
      other.type = 'button';
      other.className = 'who-chip';
      other.setAttribute('role', 'radio');
      other.setAttribute('aria-checked', 'false');
      other.dataset.other = '1';
      other.textContent = 'Altcineva';
      on(other, 'click', function () { Login.chooseOther(); });
      box.appendChild(other);

      var known = Session.accounts.some(function (a) { return a.username === last; });
      Login.choose(known ? last : (Session.accounts[0] ? Session.accounts[0].username : ''));
    },

    choose: function (username) {
      Session.chosen = username;
      var input = $('who-other-input');
      if (input) input.remove();
      var chips = $('who-list').querySelectorAll('.who-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].setAttribute('aria-checked',
          chips[i].dataset.username === username ? 'true' : 'false');
      }
      Login.clearError();
    },

    chooseOther: function () {
      Session.chosen = '';
      var chips = $('who-list').querySelectorAll('.who-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].setAttribute('aria-checked', chips[i].dataset.other ? 'true' : 'false');
      }
      if (!$('who-other-input')) {
        var input = document.createElement('input');
        input.id = 'who-other-input';
        input.className = 'who-other';
        input.type = 'text';
        input.placeholder = 'Numele contului';
        input.autocapitalize = 'off';
        input.autocorrect = 'off';
        input.spellcheck = false;
        input.setAttribute('autocomplete', 'username');
        $('who-list').insertAdjacentElement('afterend', input);
        input.focus();
      }
      Login.clearError();
    },

    username: function () {
      var custom = $('who-other-input');
      var value = custom ? custom.value : Session.chosen;
      return String(value || '').trim().toLowerCase();
    },

    error: function (message) {
      var box = $('login-error');
      text(box, message);
      show(box, true);
    },

    clearError: function () { show($('login-error'), false); },

    busy: function (yes) {
      var btn = $('login-submit');
      btn.disabled = yes;
      text(btn, yes ? 'Un moment...' : 'Intra');
    },

    submit: function (ev) {
      if (ev) ev.preventDefault();
      var username = Login.username();
      var password = $('password').value || '';

      if (!username) { Login.error('Spune-mi intai cine esti.'); return; }
      if (!password) { Login.error('Scrie parola.'); return; }

      Login.clearError();
      Login.busy(true);

      Session.login(username, password).then(function () {
        attempt(function () { localStorage.setItem('rama.user', username); });
        $('password').value = '';
        Login.busy(false);
        App.enterShell();
      }).catch(function (err) {
        Login.busy(false);
        $('password').value = '';
        if (err && err.status === 429) {
          var mins = err.retryAfter ? Math.ceil(err.retryAfter / 60) : 15;
          Login.error('Prea multe incercari. Mai incearca peste ' + mins + ' minute.');
        } else if (err && err.status === 0) {
          Login.error('Nu am internet spre server. Verifica conexiunea telefonului.');
        } else if (err && (err.status === 401 || err.code === 'invalid-credentials')) {
          Login.error('Parola nu e buna. Mai incearca o data.');
        } else {
          Login.error(humanError(err, 'Nu am putut intra. Mai incearca peste un minut.'));
        }
      });
    },

    mount: function () {
      on($('login-form'), 'submit', Login.submit);
      on($('pass-toggle'), 'click', function () {
        var input = $('password');
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        text($('pass-toggle'), showing ? 'Arata' : 'Ascunde');
        $('pass-toggle').setAttribute('aria-label', showing ? 'Arata parola' : 'Ascunde parola');
        input.focus();
      });
      on($('password'), 'input', Login.clearError);
    }
  };

  /* =========================================================================
   * 5. Gallery
   * ====================================================================== */

  var Gallery = {
    album: ANY_ALBUM,
    page: 0,
    hasMore: true,
    busy: false,
    items: [],
    index: {},              // id -> item
    nodes: {},              // id -> cell element
    selecting: false,
    selected: {},
    total: null,
    observer: null,
    started: false,

    mount: function () {
      Gallery.buildFilter();

      on($('btn-select'), 'click', function () {
        Gallery.setSelecting(!Gallery.selecting);
      });
      on($('btn-refresh'), 'click', function () { Gallery.reload(); });
      on($('gallery-retry'), 'click', function () { Gallery.reload(); });
      on($('empty-upload'), 'click', function () { App.goTab('upload'); });
      on($('sel-cancel'), 'click', function () { Gallery.setSelecting(false); });
      on($('sel-delete'), 'click', function () { Deleter.askFor(Gallery.selectedIds()); });

      if ('IntersectionObserver' in window) {
        Gallery.observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) { Gallery.loadMore(); break; }
          }
        }, { rootMargin: '700px 0px' });
        Gallery.observer.observe($('grid-sentinel'));
      }
    },

    buildFilter: function () {
      var box = $('album-filter');
      box.textContent = '';
      var segs = [{ key: ANY_ALBUM, tab: 'Toate' }].concat(Albums.list);
      segs.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', a.key === Gallery.album ? 'true' : 'false');
        b.dataset.key = a.key;
        b.textContent = a.tab || a.name;
        on(b, 'click', function () { Gallery.setAlbum(a.key); });
        box.appendChild(b);
      });
    },

    setAlbum: function (key) {
      if (Gallery.album === key) return;
      Gallery.album = key;
      var segs = $('album-filter').querySelectorAll('.seg');
      for (var i = 0; i < segs.length; i++) {
        segs[i].setAttribute('aria-selected', segs[i].dataset.key === key ? 'true' : 'false');
      }
      Gallery.reload();
    },

    /** Empty the grid and the model. Does not fetch. */
    clear: function (keepAlbum) {
      Gallery.page = 0;
      Gallery.hasMore = true;
      Gallery.items = [];
      Gallery.index = {};
      Gallery.nodes = {};
      Gallery.total = null;
      if (!keepAlbum) Gallery.album = ANY_ALBUM;
      Photos.forget();
      $('grid').textContent = '';
      Gallery.setSelecting(false);
      show($('gallery-error'), false);
      show($('gallery-empty'), false);
      Gallery.updateCount();
    },

    reload: function () {
      Gallery.clear(true);
      Gallery.loadMore();
    },

    /**
     * Forget everything, including which server capabilities we discovered.
     * Called when a session starts, so signing in as somebody else — or
     * re-authenticating after a deploy — never shows the previous data or
     * keeps using a fallback that is no longer needed.
     */
    hardReset: function () {
      Gallery.started = false;
      Photos.legacy = false;
      Photos.legacyCache = null;
      show($('gallery-note'), false);
      show($('album-filter'), true);
      Gallery.clear(false);
      Gallery.buildFilter();
    },

    start: function () {
      if (Gallery.started) return;
      Gallery.started = true;
      Gallery.loadMore();
    },

    loadMore: function () {
      if (Gallery.busy || !Gallery.hasMore) return;
      Gallery.busy = true;
      show($('gallery-loading'), true);
      show($('gallery-error'), false);

      var page = Gallery.page + 1;
      Photos.page(Gallery.album, page).then(function (res) {
        Gallery.busy = false;
        show($('gallery-loading'), false);
        Gallery.page = page;
        Gallery.hasMore = !!res.hasMore;
        if (typeof res.total === 'number') Gallery.total = res.total;

        res.items.forEach(function (item) {
          if (Gallery.index[item.id]) return;
          Gallery.index[item.id] = item;
          Gallery.items.push(item);
          $('grid').appendChild(Gallery.cell(item));
        });

        // Legacy mode cannot filter by album: say so once, plainly.
        if (res.legacy) {
          show($('album-filter'), false);
          text($('gallery-note'),
            'Serverul imi arata deocamdata toate pozele la un loc, fara impartirea pe rame.');
          show($('gallery-note'), true);
        }

        Gallery.updateCount();
        show($('gallery-empty'), Gallery.items.length === 0);
      }).catch(function (err) {
        Gallery.busy = false;
        show($('gallery-loading'), false);
        if (err && err.status === 401) return;            // App handles the logout
        if (Gallery.items.length) {
          toast(humanError(err, 'Nu am mai putut aduce poze.'), 'bad');
          Gallery.hasMore = false;
          return;
        }
        text($('gallery-error-text'), humanError(err, 'Nu am putut aduce pozele.'));
        show($('gallery-error'), true);
      });
    },

    updateCount: function () {
      var n = Gallery.total != null ? Gallery.total : Gallery.items.length;
      var shown = Gallery.items.length;
      var label = Gallery.total != null && Gallery.total > shown
        ? shown + ' din ' + photoCountLabel(n)
        : photoCountLabel(shown);
      text($('gallery-count'), label);
    },

    cell: function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.setAttribute('role', 'listitem');
      b.setAttribute('aria-selected', 'false');
      b.dataset.id = item.id;

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = item.url;
      on(img, 'load', function () { img.classList.add('loaded'); });
      on(img, 'error', function () { b.classList.add('broken'); });
      b.appendChild(img);

      var badgeText = Albums.badge(item.albums);
      if (badgeText) {
        var badge = document.createElement('span');
        badge.className = 'cell-badge';
        badge.textContent = badgeText;
        b.appendChild(badge);
      }

      var check = document.createElement('span');
      check.className = 'cell-check';
      b.appendChild(check);

      // Long press enters multi-select, the way every phone gallery works.
      // `justLongPressed` swallows the click the browser fires after the
      // touchend — without it the long press selects and the click instantly
      // deselects again.
      var pressTimer = 0;
      var justLongPressed = false;
      var cancelPress = function () { clearTimeout(pressTimer); };

      on(b, 'click', function () {
        if (justLongPressed) { justLongPressed = false; return; }
        if (Gallery.selecting) Gallery.toggle(item.id);
        else Viewer.open(item.id);
      });

      on(b, 'touchstart', function () {
        cancelPress();
        justLongPressed = false;
        pressTimer = setTimeout(function () {
          if (Gallery.selecting) return;
          justLongPressed = true;
          Gallery.setSelecting(true);
          Gallery.toggle(item.id);
          attempt(function () { if (navigator.vibrate) navigator.vibrate(12); });
        }, 480);
      }, { passive: true });
      on(b, 'touchend', cancelPress, { passive: true });
      on(b, 'touchmove', cancelPress, { passive: true });
      on(b, 'touchcancel', cancelPress, { passive: true });
      on(b, 'contextmenu', function (e) { e.preventDefault(); });

      Gallery.nodes[item.id] = b;
      return b;
    },

    setSelecting: function (yes) {
      Gallery.selecting = yes;
      Gallery.selected = {};
      $('grid').classList.toggle('selecting', yes);
      var cells = $('grid').querySelectorAll('.cell');
      for (var i = 0; i < cells.length; i++) cells[i].setAttribute('aria-selected', 'false');
      text($('btn-select'), yes ? 'Gata' : 'Selecteaza');
      show($('selbar'), yes);
      Gallery.updateSelCount();
    },

    toggle: function (id) {
      if (Gallery.selected[id]) delete Gallery.selected[id];
      else Gallery.selected[id] = true;
      var node = Gallery.nodes[id];
      if (node) node.setAttribute('aria-selected', Gallery.selected[id] ? 'true' : 'false');
      Gallery.updateSelCount();
    },

    selectedIds: function () { return Object.keys(Gallery.selected); },

    updateSelCount: function () {
      var n = Gallery.selectedIds().length;
      text($('sel-count'), n === 0 ? 'Nimic selectat' : n + ' ' + plural(n, 'selectata', 'selectate', 'selectate'));
      $('sel-delete').disabled = n === 0;
    },

    /** Drop photos from the model + DOM after a successful delete. */
    forget: function (ids) {
      ids.forEach(function (id) {
        var node = Gallery.nodes[id];
        if (node && node.parentNode) node.parentNode.removeChild(node);
        delete Gallery.nodes[id];
        delete Gallery.index[id];
        delete Gallery.selected[id];
      });
      Gallery.items = Gallery.items.filter(function (p) { return ids.indexOf(p.id) < 0; });
      if (Gallery.total != null) Gallery.total = Math.max(0, Gallery.total - ids.length);
      if (Photos.legacyCache) {
        Photos.legacyCache = Photos.legacyCache.filter(function (p) { return ids.indexOf(p.id) < 0; });
      }
      Gallery.updateCount();
      Gallery.updateSelCount();
      show($('gallery-empty'), Gallery.items.length === 0);
    },

    /** After a "remove from album", the photo stays but loses one album. */
    dropAlbum: function (ids, albumKey) {
      ids.forEach(function (id) {
        var item = Gallery.index[id];
        if (!item || !item.albums) return;
        item.albums = item.albums.filter(function (k) { return k !== albumKey; });
      });
      if (Gallery.album === albumKey) Gallery.forget(ids);
    }
  };

  /* =========================================================================
   * 6. Viewer (lightbox)
   * ====================================================================== */

  var Viewer = {
    position: -1,

    mount: function () {
      on($('viewer-close'), 'click', Viewer.close);
      on($('viewer-prev'), 'click', function () { Viewer.step(-1); });
      on($('viewer-next'), 'click', function () { Viewer.step(1); });
      on($('viewer-delete'), 'click', function () {
        var item = Gallery.items[Viewer.position];
        if (item) { Viewer.close(); Deleter.askFor([item.id]); }
      });

      // Horizontal swipe to move between photos.
      var startX = 0, startY = 0, tracking = false;
      var stage = $('viewer-stage');
      on(stage, 'touchstart', function (e) {
        if (e.touches.length !== 1) { tracking = false; return; }
        tracking = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }, { passive: true });
      on(stage, 'touchend', function (e) {
        if (!tracking) return;
        tracking = false;
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        var dx = t.clientX - startX;
        var dy = t.clientY - startY;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) Viewer.step(dx < 0 ? 1 : -1);
        else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.4) Viewer.close();
      }, { passive: true });

      on(document, 'keydown', function (e) {
        if ($('viewer').hidden) return;
        if (e.key === 'Escape') Viewer.close();
        if (e.key === 'ArrowLeft') Viewer.step(-1);
        if (e.key === 'ArrowRight') Viewer.step(1);
      });
    },

    open: function (id) {
      var pos = -1;
      for (var i = 0; i < Gallery.items.length; i++) {
        if (Gallery.items[i].id === id) { pos = i; break; }
      }
      if (pos < 0) return;
      Viewer.position = pos;
      Viewer.render();
      show($('viewer'), true);
    },

    render: function () {
      var item = Gallery.items[Viewer.position];
      if (!item) { Viewer.close(); return; }
      var img = $('viewer-img');
      img.src = item.fullUrl || item.url;
      img.alt = item.fileName || 'Poza';
      var bits = [];
      if (item.createdAt) bits.push(formatDate(item.createdAt));
      if (item.albums) bits.push(Albums.describe(item.albums));
      text($('viewer-meta'), bits.join(' · '));
      text($('viewer-pos'), (Viewer.position + 1) + ' / ' + Gallery.items.length);
      $('viewer-prev').disabled = Viewer.position <= 0;
      $('viewer-next').disabled = Viewer.position >= Gallery.items.length - 1;
    },

    step: function (delta) {
      var next = Viewer.position + delta;
      if (next < 0 || next >= Gallery.items.length) return;
      Viewer.position = next;
      Viewer.render();
      // Reaching the end pulls the next page in, so swiping never dead-ends.
      if (next >= Gallery.items.length - 3) Gallery.loadMore();
    },

    close: function () {
      show($('viewer'), false);
      $('viewer-img').removeAttribute('src');
    }
  };

  /* =========================================================================
   * 7. Delete
   * ====================================================================== */

  var Deleter = {
    /** Which album can we "remove from" for this selection? */
    targetAlbum: function (ids) {
      if (Gallery.album !== ANY_ALBUM && Albums.byKey[Gallery.album]) return Gallery.album;
      var common = null;
      for (var i = 0; i < ids.length; i++) {
        var item = Gallery.index[ids[i]];
        if (!item || !item.albums || item.albums.length !== 1) return null;
        if (common === null) common = item.albums[0];
        else if (common !== item.albums[0]) return null;
      }
      return common && Albums.byKey[common] ? common : null;
    },

    askFor: function (ids) {
      if (!ids.length) return;
      var albumKey = Deleter.targetAlbum(ids);
      var album = albumKey ? Albums.byKey[albumKey] : null;
      var what = photoCountLabel(ids.length);

      var actions = [];
      if (album) {
        actions.push({
          label: 'Scoate de pe "' + album.name + '"',
          style: 'btn-primary',
          hint: 'Poza ramane in arhiva, dar nu se mai vede pe rama.',
          onSelect: function () { Deleter.run(ids, 'album', albumKey); }
        });
      }
      actions.push({
        label: 'Sterge definitiv',
        style: 'btn-danger',
        hint: album
          ? 'Dispare de pe toate ramele si din arhiva.'
          : 'Dispare de pe toate ramele si din arhiva. Nu se poate anula.',
        onSelect: function () { Deleter.confirmPermanent(ids); }
      });
      actions.push({ label: 'Renunta', style: 'btn-quiet' });

      Sheet.open({
        title: 'Ce fac cu ' + what + '?',
        text: album
          ? 'Poti doar sa le scoti de pe rama, sau sa le stergi cu totul.'
          : 'Pozele selectate sunt de pe mai multe rame, asa ca le pot doar sterge definitiv.',
        actions: actions
      });
    },

    confirmPermanent: function (ids) {
      Sheet.open({
        title: 'Stergi definitiv ' + photoCountLabel(ids.length) + '?',
        text: 'Nu se mai pot recupera din aplicatie.',
        actions: [
          {
            label: 'Da, sterge definitiv',
            style: 'btn-danger',
            onSelect: function () { Deleter.run(ids, 'permanent', null); }
          },
          { label: 'Nu, renunta', style: 'btn-quiet' }
        ]
      });
    },

    run: function (ids, mode, albumKey) {
      var total = ids.length;

      ids.forEach(function (id) {
        var node = Gallery.nodes[id];
        if (node) node.classList.add('dying');
      });
      toast('Sterg ' + photoCountLabel(total) + '...', null, 60000);

      var undying = function () {
        ids.forEach(function (id) {
          var node = Gallery.nodes[id];
          if (node) node.classList.remove('dying');
        });
      };

      Photos.remove(ids, mode, albumKey).then(function (res) {
        Gallery.setSelecting(false);
        if (!res.ok.length) {
          undying();
          toast('Nu am putut sterge nimic. Mai incearca.', 'bad', 5000);
          return;
        }
        if (mode === 'album') Gallery.dropAlbum(res.ok, albumKey);
        else Gallery.forget(res.ok);
        var n = res.ok.length;
        toast(mode === 'album'
          ? photoCountLabel(n) + ' ' + plural(n, 'scoasa', 'scoase', 'scoase') + ' de pe rama.'
          : photoCountLabel(n) + ' ' + plural(n, 'stearsa', 'sterse', 'sterse') + '.', 'good');
      }).catch(function (err) {
        undying();
        Gallery.setSelecting(false);
        if (Photos.missing(err)) {
          toast('Stergerea nu e inca disponibila pe server.', 'bad', 5000);
          return;
        }
        toast(humanError(err, 'Nu am putut sterge pozele. Mai incearca.'), 'bad', 5000);
      });
    }
  };

  /**
   * Run `worker` over `items` with at most `limit` in flight. Never rejects:
   * one failure must not stop the other 199 photos.
   *
   * `startOne` exists so the item is captured per call. Taking `items[i++]`
   * inside the while loop and closing over it would hand every worker the last
   * item the loop happened to reach — which silently uploads one file three
   * times and skips two.
   */
  function runPool(items, limit, worker) {
    return new Promise(function (resolve) {
      var i = 0, active = 0, finished = 0;
      var total = items.length;
      if (!total) { resolve(); return; }

      function startOne(item) {
        active++;
        Promise.resolve()
          .then(function () { return worker(item); })
          .catch(function () { /* worker owns its errors */ })
          .then(function () {
            active--;
            finished++;
            if (finished === total) resolve();
            else pump();
          });
      }

      function pump() {
        while (active < limit && i < total) startOne(items[i++]);
      }
      pump();
    });
  }

  /* =========================================================================
   * 8. Upload
   * ====================================================================== */

  var MAX_FILE_BYTES = 80 * 1024 * 1024;
  var UPLOAD_CONCURRENCY = 3;
  var PREVIEW_LIMIT = 60;

  /* Default upload target: the shared album, so a photo lands on BOTH frames unless the
   * sender picks otherwise. Must be a key the server knows ('all'), never a label. */
  var DEFAULT_UPLOAD_ALBUM = 'all';

  var Uploader = {
    album: DEFAULT_UPLOAD_ALBUM,
    tasks: [],
    running: false,
    cancelled: false,
    seq: 0,

    mount: function () {
      Uploader.album = attempt(function () { return localStorage.getItem('rama.album'); })
        || DEFAULT_UPLOAD_ALBUM;
      Uploader.reconcileAlbum();
      Uploader.buildAlbumPicker();

      on($('file-input'), 'change', function (e) {
        var files = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
        e.target.value = '';                       // let the same file be picked again
        Uploader.add(files);
      });
      on($('btn-cancel-uploads'), 'click', function () { Uploader.cancel(); });
      on($('btn-clear-list'), 'click', function () { Uploader.clear(); });
      on($('btn-see-gallery'), 'click', function () { App.goTab('gallery'); });
      on($('btn-retry-failed'), 'click', function () { Uploader.retryFailed(); });

      window.addEventListener('beforeunload', function (e) {
        if (!Uploader.running) return undefined;
        e.preventDefault();
        e.returnValue = '';
        return '';
      });
    },

    /**
     * Force `Uploader.album` onto a key the server will actually accept.
     *
     * This has to run again AFTER /api/admin/albums answers, not only at mount: at mount the
     * album list is still the built-in fallback, and a value left over in localStorage from an
     * older build (or from a renamed album) would sail straight through into the multipart
     * `album` field, where the server answers 400 "unknown album" and every single upload
     * fails with a generic "Esuat".
     */
    reconcileAlbum: function () {
      if (Albums.byKey[Uploader.album]) return;
      if (Albums.byKey[DEFAULT_UPLOAD_ALBUM]) {
        Uploader.album = DEFAULT_UPLOAD_ALBUM;
      } else if (Albums.list.length) {
        Uploader.album = Albums.list[Albums.list.length - 1].key;
      } else {
        Uploader.album = DEFAULT_UPLOAD_ALBUM;
      }
      attempt(function () { localStorage.setItem('rama.album', Uploader.album); });
    },

    buildAlbumPicker: function () {
      Uploader.reconcileAlbum();
      var box = $('upload-album');
      box.textContent = '';
      Albums.list.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', a.key === Uploader.album ? 'true' : 'false');
        b.dataset.key = a.key;
        b.textContent = a.name;
        on(b, 'click', function () { Uploader.setAlbum(a.key); });
        box.appendChild(b);
      });
    },

    setAlbum: function (key) {
      Uploader.album = key;
      attempt(function () { localStorage.setItem('rama.album', key); });
      var segs = $('upload-album').querySelectorAll('.seg');
      for (var i = 0; i < segs.length; i++) {
        segs[i].setAttribute('aria-checked', segs[i].dataset.key === key ? 'true' : 'false');
      }
    },

    add: function (files) {
      if (!files.length) return;
      var album = Uploader.album;
      var accepted = 0, rejected = 0;

      files.forEach(function (file) {
        var looksImage = /^image\//.test(file.type || '') ||
                         /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(file.name || '');
        var task = {
          key: 'u' + (++Uploader.seq),
          file: file,
          name: file.name || 'poza.jpg',
          album: album,
          pct: 0,
          status: 'waiting',
          message: 'In asteptare',
          xhr: null
        };
        if (!looksImage) {
          task.status = 'error';
          task.message = 'Nu e o poza';
          rejected++;
        } else if (file.size > MAX_FILE_BYTES) {
          task.status = 'error';
          task.message = 'Prea mare';
          rejected++;
        } else {
          accepted++;
        }
        Uploader.tasks.push(task);
        $('upload-list').appendChild(Uploader.row(task));
      });

      show($('upload-summary'), false);
      if (rejected) {
        toast(rejected + ' ' + plural(rejected, 'fisier a fost sarit', 'fisiere au fost sarite', 'de fisiere au fost sarite') + '.', 'bad');
      }
      if (accepted) Uploader.pump();
      else Uploader.finish();
    },

    row: function (task) {
      var li = document.createElement('li');
      li.className = 'up-item';
      li.dataset.key = task.key;

      var thumb = document.createElement('img');
      thumb.className = 'up-thumb';
      thumb.alt = '';
      // Previews cost memory; only make them for the first screenful.
      if (Uploader.tasks.length <= PREVIEW_LIMIT && task.file.size < 16 * 1024 * 1024 &&
          window.URL && window.URL.createObjectURL) {
        var url = attempt(function () { return URL.createObjectURL(task.file); });
        if (url) {
          thumb.src = url;
          var release = function () { attempt(function () { URL.revokeObjectURL(url); }); };
          on(thumb, 'load', release);
          on(thumb, 'error', release);
        }
      }
      li.appendChild(thumb);

      var body = document.createElement('div');
      body.className = 'up-body';
      var name = document.createElement('p');
      name.className = 'up-name';
      name.textContent = task.name;
      body.appendChild(name);
      var bar = document.createElement('div');
      bar.className = 'up-bar';
      var fill = document.createElement('span');
      bar.appendChild(fill);
      body.appendChild(bar);
      li.appendChild(body);

      var state = document.createElement('span');
      state.className = 'up-state';
      state.textContent = task.message;
      li.appendChild(state);

      task.el = li;
      task.fillEl = fill;
      task.stateEl = state;
      Uploader.paint(task);
      return li;
    },

    paint: function (task) {
      if (!task.el) return;
      task.el.classList.toggle('ok', task.status === 'ok');
      task.el.classList.toggle('error', task.status === 'error');
      task.fillEl.style.width = clamp(task.pct, 0, 100) + '%';
      task.stateEl.textContent = task.message;
    },

    pending: function () {
      return Uploader.tasks.filter(function (t) { return t.status === 'waiting'; });
    },

    pump: function () {
      if (Uploader.running) { Uploader.renderStrip(); return; }
      Uploader.running = true;
      Uploader.cancelled = false;
      show($('btn-cancel-uploads'), true);
      Uploader.renderStrip();

      var queue = Uploader.pending();
      runPool(queue, UPLOAD_CONCURRENCY, function (task) {
        if (Uploader.cancelled) {
          task.status = 'error';
          task.message = 'Oprita';
          Uploader.paint(task);
          return Promise.resolve();
        }
        return Uploader.send(task);
      }).then(function () {
        // New files may have been added while the pool was draining.
        if (Uploader.pending().length && !Uploader.cancelled) {
          Uploader.running = false;
          Uploader.pump();
          return;
        }
        Uploader.running = false;
        Uploader.finish();
      });
    },

    send: function (task) {
      return new Promise(function (resolve) {
        task.status = 'up';
        task.pct = 1;
        task.message = '1%';
        Uploader.paint(task);

        var form = new FormData();
        form.append('album', task.album);
        var stamp = new Date(task.file.lastModified || Date.now()).toISOString();
        form.append('fileCreatedAt', stamp);
        form.append('fileModifiedAt', stamp);
        form.append('deviceAssetId', task.name + '-' + (task.file.size || 0) + '-' + (task.file.lastModified || 0));
        form.append('file', task.file, task.name);

        var xhr = new XMLHttpRequest();
        task.xhr = xhr;
        xhr.open('POST', '/api/admin/photos', true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('accept', 'application/json');
        var csrf = readCookie('frameo_csrf');
        if (csrf) xhr.setRequestHeader('X-Frameo-CSRF', csrf);

        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          task.pct = Math.round((e.loaded / e.total) * 98);
          task.message = task.pct + '%';
          Uploader.paint(task);
          Uploader.renderStrip();
        };

        var settle = function (status, message) {
          task.xhr = null;
          task.status = status;
          task.message = message;
          task.pct = status === 'ok' ? 100 : task.pct;
          Uploader.paint(task);
          Uploader.renderStrip();
          resolve();
        };

        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            var body = attempt(function () { return JSON.parse(xhr.responseText || '{}'); }) || {};
            settle('ok', body.duplicate || body.status === 'duplicate' ? 'Deja acolo' : 'Gata');
            return;
          }
          if (xhr.status === 401 || xhr.status === 403) {
            Net.fireUnauthenticated();
            settle('error', 'Sesiune');
            return;
          }
          if (xhr.status === 404 || xhr.status === 501) { settle('error', 'Indisponibil'); return; }
          if (xhr.status === 413) { settle('error', 'Prea mare'); return; }
          if (xhr.status === 415) { settle('error', 'Format'); return; }
          if (xhr.status === 429) { settle('error', 'Prea repede'); return; }
          settle('error', 'Esuat');
        };
        xhr.onerror = function () { settle('error', 'Fara net'); };
        xhr.ontimeout = function () { settle('error', 'Prea lent'); };
        xhr.onabort = function () { settle('error', 'Oprita'); };
        xhr.timeout = 10 * 60 * 1000;

        try { xhr.send(form); }
        catch (e) { settle('error', 'Esuat'); }
      });
    },

    counts: function () {
      var c = { total: Uploader.tasks.length, ok: 0, error: 0, left: 0, active: 0 };
      Uploader.tasks.forEach(function (t) {
        if (t.status === 'ok') c.ok++;
        else if (t.status === 'error') c.error++;
        else if (t.status === 'waiting') c.left++;
        else c.active++;
      });
      return c;
    },

    renderStrip: function () {
      var c = Uploader.counts();
      var strip = $('upload-strip');
      var busy = c.left + c.active > 0;
      show(strip, busy);
      document.body.classList.toggle('has-strip', busy);

      var badge = $('tab-badge-upload');
      if (busy) {
        text(badge, String(c.left + c.active));
        show(badge, true);
      } else {
        show(badge, false);
      }
      if (!busy) return;

      var doneUnits = c.ok + c.error;
      var partial = 0;
      Uploader.tasks.forEach(function (t) { if (t.status === 'up') partial += t.pct / 100; });
      var pct = c.total ? Math.round(((doneUnits + partial) / c.total) * 100) : 0;
      $('upload-strip-fill').style.width = clamp(pct, 0, 100) + '%';
      text($('upload-strip-text'), 'Trimit pozele... ' + (doneUnits) + ' din ' + c.total);
    },

    /** Failures worth another try: a bad format or an oversized file is not one. */
    retryable: function () {
      return Uploader.tasks.filter(function (t) {
        return t.status === 'error' &&
          t.message !== 'Prea mare' && t.message !== 'Nu e o poza' && t.message !== 'Format';
      });
    },

    finish: function () {
      Uploader.renderStrip();
      show($('btn-cancel-uploads'), false);
      var c = Uploader.counts();
      if (!c.total) { show($('upload-summary'), false); return; }

      var failedWord = plural(c.error, 'nu a mers', 'nu au mers', 'nu au mers');
      var okWord = plural(c.ok, 'a ajuns', 'au ajuns', 'au ajuns');
      var line;
      if (c.error === 0) line = 'Gata! ' + photoCountLabel(c.ok) + ' ' + okWord + ' pe rama.';
      else if (c.ok === 0) line = 'Nicio poza nu a putut fi trimisa.';
      else line = photoCountLabel(c.ok) + ' ' + okWord + '. ' + c.error + ' ' + failedWord + '.';

      text($('summary-line'), line);
      show($('btn-retry-failed'), Uploader.retryable().length > 0);
      show($('upload-summary'), true);

      if (c.ok > 0) {
        // The gallery is now stale; refresh it in the background.
        Photos.forget();
        Gallery.reload();
      }
    },

    retryFailed: function () {
      var again = Uploader.retryable();
      again.forEach(function (t) {
        t.status = 'waiting';
        t.pct = 0;
        t.message = 'In asteptare';
        Uploader.paint(t);
      });
      if (!again.length) { toast('Pozele astea nu pot fi trimise.', 'bad'); return; }
      show($('upload-summary'), false);
      Uploader.pump();
    },

    cancel: function () {
      Uploader.cancelled = true;
      Uploader.tasks.forEach(function (t) {
        if (t.xhr) attempt(function () { t.xhr.abort(); });
        if (t.status === 'waiting') {
          t.status = 'error';
          t.message = 'Oprita';
          Uploader.paint(t);
        }
      });
      show($('btn-cancel-uploads'), false);
    },

    clear: function () {
      if (Uploader.running) { toast('Astept sa se termine ce e in lucru.', 'bad'); return; }
      Uploader.tasks = [];
      $('upload-list').textContent = '';
      show($('upload-summary'), false);
      Uploader.renderStrip();
    }
  };

  /* =========================================================================
   * 9. Signalling (WebSocket) — same protocol and message names as the tablet
   * ====================================================================== */

  var Signal = {
    ws: null,
    connected: false,
    registered: false,
    backoff: 1000,
    retryTimer: 0,
    beatTimer: 0,
    handlers: {},
    contacts: [],

    url: function () {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      return proto + location.host + '/ws';
    },

    on: function (type, fn) { Signal.handlers[type] = fn; },

    connect: function () {
      if (!Session.account) return;
      if (Signal.ws && (Signal.ws.readyState === 0 || Signal.ws.readyState === 1)) return;

      var ws;
      try { ws = new WebSocket(Signal.url()); }
      catch (e) { Signal.scheduleReconnect(); return; }
      Signal.ws = ws;

      ws.onopen = function () {
        Signal.connected = true;
        Signal.backoff = 1000;
        // Cookie-authenticated register: the session cookie was validated at
        // the HTTP upgrade, so no token travels in the message body.
        Signal.send({ type: 'register', id: Session.account.peerId });
        clearInterval(Signal.beatTimer);
        Signal.beatTimer = setInterval(function () {
          Signal.send({ type: 'heartbeat' });
        }, 20000);
        App.updateConnection();
      };

      ws.onmessage = function (ev) {
        var msg = attempt(function () { return JSON.parse(ev.data); });
        if (!msg || !msg.type) return;
        var fn = Signal.handlers[msg.type];
        if (fn) attempt(function () { fn(msg); });
      };

      ws.onclose = function () {
        Signal.connected = false;
        Signal.registered = false;
        clearInterval(Signal.beatTimer);
        App.updateConnection();
        Frames.markAllOffline();
        Signal.scheduleReconnect();
      };

      ws.onerror = function () { attempt(function () { ws.close(); }); };
    },

    scheduleReconnect: function () {
      clearTimeout(Signal.retryTimer);
      Signal.backoff = Math.min(Math.round(Signal.backoff * 1.7), 15000);
      Signal.retryTimer = setTimeout(function () { Signal.connect(); }, Signal.backoff);
    },

    disconnect: function () {
      clearTimeout(Signal.retryTimer);
      clearInterval(Signal.beatTimer);
      if (Signal.ws) attempt(function () { Signal.ws.close(); });
      Signal.ws = null;
      Signal.connected = false;
      Signal.registered = false;
    },

    send: function (msg) {
      if (!Signal.ws || Signal.ws.readyState !== 1) return false;
      try { Signal.ws.send(JSON.stringify(msg)); return true; }
      catch (e) { return false; }
    }
  };

  /* =========================================================================
   * 10. Frames list (call screen)
   * ====================================================================== */

  var Frames = {
    list: [],

    setContacts: function (contacts) {
      Frames.list = (contacts || []).filter(function (c) { return c.kind === 'frame'; });
      Frames.render();
    },

    update: function (id, online, busy) {
      Frames.list.forEach(function (c) {
        if (c.id !== id) return;
        c.online = !!online;
        c.busy = !!busy;
      });
      Frames.render();
    },

    markAllOffline: function () {
      Frames.list.forEach(function (c) { c.online = false; c.busy = false; });
      Frames.render();
    },

    anyOnline: function () {
      return Frames.list.some(function (c) { return c.online; });
    },

    render: function () {
      var box = $('frame-list');
      box.textContent = '';
      show($('frames-empty'), Frames.list.length === 0);

      Frames.list.forEach(function (c) {
        var card = document.createElement('div');
        card.className = 'frame-card' + (c.online ? ' online' : '') + (c.busy ? ' busy' : '');

        var name = document.createElement('p');
        name.className = 'frame-name';
        name.textContent = c.displayName || c.id;
        card.appendChild(name);

        var status = document.createElement('p');
        status.className = 'frame-status';
        var dot = document.createElement('span');
        dot.className = 'dot';
        status.appendChild(dot);
        var label = document.createElement('span');
        label.textContent = c.busy ? 'Vorbeste acum'
          : (c.online ? 'Pornita, gata de apel' : 'Nu e pornita');
        status.appendChild(label);
        card.appendChild(status);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary frame-call';
        btn.textContent = 'Suna ' + (c.displayName || '');
        btn.disabled = !c.online || !!c.busy || !Signal.connected;
        on(btn, 'click', function () { CallUI.start(c); });
        card.appendChild(btn);

        if (!c.online) {
          var hint = document.createElement('p');
          hint.className = 'micro';
          hint.textContent = 'Rama nu raspunde. Poate e stinsa sau nu are internet.';
          card.appendChild(hint);
        }

        box.appendChild(card);
      });

      show($('tab-dot-call'), Frames.anyOnline());
    }
  };

  /* =========================================================================
   * 11. ICE servers
   * ====================================================================== */

  var Ice = {
    servers: null,
    expiresAt: 0,

    /** Always resolves. An empty array still allows a direct/LAN call. */
    get: function () {
      var fresh = Ice.servers && (Ice.expiresAt - Date.now() > 30 * 60 * 1000);
      if (fresh) return Promise.resolve(Ice.servers);
      return Net.get('/api/turn-credentials').then(function (doc) {
        var servers = (doc && doc.iceServers) || [];
        if (!Array.isArray(servers)) servers = [];
        Ice.servers = servers;
        var exp = doc && doc.expiresAt ? Date.parse(doc.expiresAt) : NaN;
        Ice.expiresAt = isFinite(exp) ? exp
          : Date.now() + (Number(doc && doc.ttl) || 43200) * 1000;
        return Ice.servers;
      }).catch(function () {
        return Ice.servers || [];
      });
    }
  };

  /* =========================================================================
   * 12. Call (WebRTC)
   * ====================================================================== */

  /* How long ICE may sit in `failed` before the call is declared dead. An ICE
   * restart plus a fresh TURN allocation over a mobile link needs several
   * seconds; anything shorter kills calls that were about to recover. */
  var ICE_FAIL_GRACE_MS = 20000;

  var CallUI = {
    pc: null,
    local: null,
    remote: null,
    peer: null,             // contact object
    callId: null,
    role: null,             // 'caller' | 'callee'
    state: 'idle',          // idle | dialing | ringing-in | connecting | active
    pendingOffer: null,
    pendingCandidates: [],
    remoteReady: false,
    everConnected: false,   // media flowed at least once on this call
    iceRestarting: false,   // an iceRestart offer is in flight
    iceFailTimer: 0,
    acceptedLocally: false,
    facing: 'user',
    micOn: true,
    camOn: true,
    startedAt: 0,
    timer: 0,
    statsTimer: 0,
    wakeLock: null,
    warnedNoMedia: false,

    mount: function () {
      on($('btn-mic'), 'click', CallUI.toggleMic);
      on($('btn-cam'), 'click', CallUI.toggleCam);
      on($('btn-flip'), 'click', CallUI.flip);
      on($('btn-hangup'), 'click', function () { CallUI.hangup('user'); });
    },

    /* ---- UI plumbing --------------------------------------------------- */

    openUi: function () {
      show($('callui'), true);
      CallUI.acquireWakeLock();
    },

    closeUi: function () {
      show($('callui'), false);
      show($('ring'), false);
      show($('call-relay'), false);
      CallUI.releaseWakeLock();
    },

    ring: function (opts) {
      text($('ring-name'), opts.name || '');
      text($('ring-sub'), opts.sub || '');
      var actions = $('ring-actions');
      actions.textContent = '';
      (opts.actions || []).forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.style || 'btn-quiet');
        b.textContent = a.label;
        on(b, 'click', a.onSelect);
        actions.appendChild(b);
      });
      show($('ring'), true);
    },

    setStatus: function (message) { text($('call-status'), message); },

    /* ---- media --------------------------------------------------------- */

    constraints: function () {
      return {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        // 640x480 on purpose: this stream may be relayed over TCP through the
        // tunnel, where 720p turns into a slideshow.
        video: {
          facingMode: CallUI.facing,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 }
        }
      };
    },

    getMedia: function () {
      if (CallUI.local) return Promise.resolve(CallUI.local);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.resolve(null);
      }
      var c = CallUI.constraints();
      return navigator.mediaDevices.getUserMedia(c).catch(function () {
        // No camera or camera refused: audio alone is a perfectly good call.
        return navigator.mediaDevices.getUserMedia({ audio: c.audio, video: false });
      }).then(function (stream) {
        CallUI.local = stream;
        var v = $('local-video');
        v.srcObject = stream;
        attempt(function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); });
        CallUI.camOn = stream.getVideoTracks().length > 0;
        CallUI.micOn = stream.getAudioTracks().length > 0;
        CallUI.paintControls();
        return stream;
      }).catch(function () {
        // Camera AND microphone refused, or no devices at all. The call can
        // still go ahead one-way; say so instead of showing dead buttons.
        CallUI.local = null;
        CallUI.camOn = false;
        CallUI.micOn = false;
        CallUI.paintControls();
        if (!CallUI.warnedNoMedia) {
          CallUI.warnedNoMedia = true;
          toast('Telefonul nu mi-a dat voie la camera si microfon. Ii vezi si ii auzi, dar ei nu te aud.',
            'bad', 6000);
        }
        return null;
      });
    },

    /* ---- peer connection ------------------------------------------------ */

    createPeer: function (iceServers) {
      var pc = new RTCPeerConnection({
        iceServers: iceServers || [],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle'
      });
      CallUI.pc = pc;

      pc.onicecandidate = function (e) {
        if (!e.candidate) return;
        Signal.send({
          type: 'ice-candidate',
          callId: CallUI.callId,
          candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate
        });
      };

      pc.ontrack = function (e) {
        if (!CallUI.remote) CallUI.remote = new MediaStream();
        CallUI.remote.addTrack(e.track);
        var v = $('remote-video');
        v.srcObject = CallUI.remote;
        attempt(function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); });
      };

      pc.oniceconnectionstatechange = function () {
        if (pc !== CallUI.pc) return;               // a stale, already-closed pc
        var s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
          CallUI.everConnected = true;
          CallUI.iceRestarting = false;
          clearTimeout(CallUI.iceFailTimer);
          CallUI.iceFailTimer = 0;
          CallUI.markActive();
        } else if (s === 'disconnected') {
          CallUI.setStatus('Semnal slab, incerc sa refac legatura...');
        } else if (s === 'failed') {
          CallUI.setStatus('Semnal slab, incerc sa refac legatura...');
          if (CallUI.role === 'caller') CallUI.restartIce();
          // Give the restart a real chance before giving up. Ending the call the
          // instant ICE reports `failed` is what made every call die at ~5 s.
          if (!CallUI.iceFailTimer) {
            CallUI.iceFailTimer = setTimeout(function () {
              CallUI.iceFailTimer = 0;
              if (CallUI.state === 'idle' || !CallUI.pc) return;
              var st = CallUI.pc.iceConnectionState;
              if (st === 'connected' || st === 'completed') return;
              CallUI.fail('Legatura nu s-a putut reface.');
            }, ICE_FAIL_GRACE_MS);
          }
        }
      };

      return pc;
    },

    /* One restart at a time. `failed` can fire repeatedly, and firing an
     * iceRestart offer per event produced duplicate offers within the same
     * millisecond, which the far side answered twice. */
    restartIce: function () {
      var pc = CallUI.pc;
      if (!pc || CallUI.iceRestarting) return;
      CallUI.iceRestarting = true;
      attempt(function () {
        pc.createOffer({ iceRestart: true }).then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          Signal.send({ type: 'offer', callId: CallUI.callId, sdp: pc.localDescription });
        }).catch(function () {
          CallUI.iceRestarting = false;
        });
      });
    },

    /** §3.6 of the architecture: cap the phone's uplink. Mandatory, not tuning. */
    capBitrate: function () {
      var pc = CallUI.pc;
      if (!pc || !pc.getSenders) return;
      pc.getSenders().forEach(function (sender) {
        if (!sender.track || sender.track.kind !== 'video') return;
        attempt(function () {
          var params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 600000;
          params.encodings[0].maxFramerate = 24;
          params.encodings[0].scaleResolutionDownBy = 1;
          params.encodings[0].networkPriority = 'high';
          params.degradationPreference = 'maintain-framerate';
          var p = sender.setParameters(params);
          if (p && p.catch) p.catch(function () {});
        });
      });
    },

    addLocalTracks: function (pc) {
      if (CallUI.local) {
        CallUI.local.getTracks().forEach(function (t) {
          var already = pc.getSenders().some(function (s) { return s.track === t; });
          if (!already) pc.addTrack(t, CallUI.local);
        });
      } else {
        attempt(function () {
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
        });
      }
      CallUI.capBitrate();
    },

    /* ---- outgoing ------------------------------------------------------- */

    start: function (contact) {
      if (CallUI.state !== 'idle') return;
      if (!Signal.connected || !Signal.registered) {
        toast('Nu sunt conectat la server. Astept internetul.', 'bad');
        return;
      }
      CallUI.reset();
      CallUI.peer = contact;
      CallUI.role = 'caller';
      CallUI.state = 'dialing';

      text($('call-peer'), contact.displayName || contact.id);
      CallUI.setStatus('Sun...');
      CallUI.openUi();
      CallUI.ring({
        name: contact.displayName || contact.id,
        sub: 'Suna la rama...',
        actions: [{
          label: 'Renunta',
          style: 'btn-danger',
          onSelect: function () { CallUI.hangup('user'); }
        }]
      });

      CallUI.getMedia();
      Ice.get();                                  // warm the credentials
      Signal.send({ type: 'call-request', to: contact.id });
    },

    onRinging: function (msg) {
      if (CallUI.role !== 'caller') return;
      CallUI.callId = msg.callId;
      text($('ring-sub'), 'Suna la rama... raspunde imediat');
    },

    onAccepted: function (msg) {
      CallUI.callId = msg.callId || CallUI.callId;
      show($('ring'), false);
      CallUI.state = 'connecting';
      CallUI.setStatus('Va conectez...');
      if (!msg.shouldCreateOffer) return;         // callee waits for the offer

      Promise.all([CallUI.getMedia(), Ice.get()]).then(function (out) {
        var pc = CallUI.createPeer(out[1]);
        CallUI.addLocalTracks(pc);
        return pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          Signal.send({ type: 'offer', callId: CallUI.callId, sdp: pc.localDescription });
        });
      }).catch(function () {
        CallUI.fail('Nu am putut porni apelul.');
      });
    },

    /* ---- incoming ------------------------------------------------------- */

    onIncoming: function (msg) {
      if (CallUI.state !== 'idle') {
        Signal.send({ type: 'call-decline', callId: msg.callId, reason: 'busy-here' });
        return;
      }
      CallUI.reset();
      CallUI.role = 'callee';
      CallUI.callId = msg.callId;
      CallUI.peer = { id: msg.from, displayName: msg.fromName || msg.from };
      CallUI.state = 'ringing-in';

      text($('call-peer'), CallUI.peer.displayName);
      CallUI.setStatus('Apel primit');
      CallUI.openUi();
      CallUI.ring({
        name: CallUI.peer.displayName,
        sub: 'Te suna',
        actions: [
          { label: 'Raspunde', style: 'btn-primary', onSelect: CallUI.accept },
          {
            label: 'Refuza', style: 'btn-danger',
            onSelect: function () {
              Signal.send({ type: 'call-decline', callId: CallUI.callId, reason: 'declined' });
              CallUI.teardown('Apel refuzat');
            }
          }
        ]
      });
      attempt(function () { if (navigator.vibrate) navigator.vibrate([300, 200, 300]); });
    },

    accept: function () {
      CallUI.acceptedLocally = true;
      show($('ring'), false);
      CallUI.state = 'connecting';
      CallUI.setStatus('Va conectez...');
      Signal.send({ type: 'call-accept', callId: CallUI.callId });
      Promise.all([CallUI.getMedia(), Ice.get()]).then(function (out) {
        if (!CallUI.pc) CallUI.createPeer(out[1]);
        CallUI.drainOffer();
      }).catch(function () {
        CallUI.fail('Nu am putut porni apelul.');
      });
    },

    /* ---- negotiation ---------------------------------------------------- */

    onOffer: function (msg) {
      CallUI.pendingOffer = msg.sdp || null;
      if (CallUI.acceptedLocally) CallUI.drainOffer();
    },

    drainOffer: function () {
      var sdp = CallUI.pendingOffer;
      if (!sdp) return;
      CallUI.pendingOffer = null;

      var run = CallUI.pc
        ? Promise.resolve(CallUI.pc)
        : Ice.get().then(function (servers) { return CallUI.createPeer(servers); });

      run.then(function (pc) {
        return pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(function () {
          CallUI.remoteReady = true;
          CallUI.flushCandidates();
          CallUI.addLocalTracks(pc);
          return pc.createAnswer();
        }).then(function (answer) {
          return pc.setLocalDescription(answer);
        }).then(function () {
          Signal.send({ type: 'answer', callId: CallUI.callId, sdp: pc.localDescription });
          CallUI.capBitrate();
        });
      }).catch(function () {
        CallUI.fail('Nu am putut raspunde la apel.');
      });
    },

    onAnswer: function (msg) {
      var pc = CallUI.pc;
      if (!pc || !msg.sdp) return;
      // Only an outstanding local offer can take an answer. Anything else is a
      // duplicate or late answer (the far side answers every offer it sees, and
      // an ICE restart puts a second one in flight); applying it throws
      // InvalidStateError. Dropping it is correct and harmless.
      if (pc.signalingState !== 'have-local-offer') return;
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(function () {
        CallUI.remoteReady = true;
        CallUI.iceRestarting = false;
        CallUI.flushCandidates();
      }).catch(function () {
        CallUI.iceRestarting = false;
        // Never tear down a call that is already carrying media. A rejected
        // answer mid-call means one renegotiation failed, not that the call is
        // over; the existing connection keeps running and ICE retries.
        if (!CallUI.everConnected) CallUI.fail('Nu am putut lega apelul.');
      });
    },

    onCandidate: function (msg) {
      if (!msg.candidate) return;
      if (!CallUI.pc || !CallUI.remoteReady) {
        CallUI.pendingCandidates.push(msg.candidate);
        return;
      }
      attempt(function () {
        var p = CallUI.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        if (p && p.catch) p.catch(function () {});
      });
    },

    flushCandidates: function () {
      var queued = CallUI.pendingCandidates;
      CallUI.pendingCandidates = [];
      queued.forEach(function (c) {
        attempt(function () {
          var p = CallUI.pc.addIceCandidate(new RTCIceCandidate(c));
          if (p && p.catch) p.catch(function () {});
        });
      });
    },

    /* ---- live call ------------------------------------------------------ */

    markActive: function () {
      if (CallUI.state === 'active') return;
      CallUI.state = 'active';
      show($('ring'), false);
      CallUI.startedAt = Date.now();
      clearInterval(CallUI.timer);
      CallUI.timer = setInterval(function () {
        CallUI.setStatus(formatDuration((Date.now() - CallUI.startedAt) / 1000));
      }, 1000);
      CallUI.setStatus('0:00');
      CallUI.startStats();
      CallUI.paintControls();
    },

    startStats: function () {
      clearInterval(CallUI.statsTimer);
      if (!CallUI.pc || !CallUI.pc.getStats) return;
      CallUI.statsTimer = setInterval(function () {
        if (!CallUI.pc) return;
        CallUI.pc.getStats(null).then(function (report) {
          var relayed = false;
          var pairs = {}, candidates = {};
          report.forEach(function (s) {
            if (s.type === 'candidate-pair') pairs[s.id] = s;
            if (s.type === 'local-candidate' || s.type === 'remote-candidate') candidates[s.id] = s;
          });
          Object.keys(pairs).forEach(function (id) {
            var p = pairs[id];
            if (!(p.selected || p.state === 'succeeded' && p.nominated)) return;
            var local = candidates[p.localCandidateId];
            var remote = candidates[p.remoteCandidateId];
            if ((local && local.candidateType === 'relay') ||
                (remote && remote.candidateType === 'relay')) relayed = true;
          });
          show($('call-relay'), relayed);
        }).catch(function () {});
      }, 4000);
    },

    paintControls: function () {
      var hasVideo = !!(CallUI.local && CallUI.local.getVideoTracks().length);
      var hasAudio = !!(CallUI.local && CallUI.local.getAudioTracks().length);

      $('btn-mic').setAttribute('aria-pressed', CallUI.micOn ? 'false' : 'true');
      text($('btn-mic-text'), CallUI.micOn ? 'Microfon' : 'Fara sunet');
      $('btn-mic').disabled = !hasAudio;

      $('btn-cam').setAttribute('aria-pressed', CallUI.camOn ? 'false' : 'true');
      text($('btn-cam-text'), CallUI.camOn ? 'Camera' : 'Fara video');
      $('btn-cam').disabled = !hasVideo;
      $('btn-flip').disabled = !hasVideo;

      $('local-video').classList.toggle('off', !hasVideo || !CallUI.camOn);
      $('local-video').classList.toggle('env', CallUI.facing === 'environment');
    },

    toggleMic: function () {
      if (!CallUI.local) return;
      CallUI.micOn = !CallUI.micOn;
      CallUI.local.getAudioTracks().forEach(function (t) { t.enabled = CallUI.micOn; });
      CallUI.paintControls();
    },

    toggleCam: function () {
      if (!CallUI.local) return;
      CallUI.camOn = !CallUI.camOn;
      CallUI.local.getVideoTracks().forEach(function (t) { t.enabled = CallUI.camOn; });
      CallUI.paintControls();
    },

    flip: function () {
      if (!CallUI.local || !navigator.mediaDevices) return;
      var next = CallUI.facing === 'user' ? 'environment' : 'user';
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: next }, width: { ideal: 640 }, height: { ideal: 480 } }
      }).then(function (stream) {
        var track = stream.getVideoTracks()[0];
        if (!track) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        CallUI.facing = next;

        var sender = CallUI.pc && CallUI.pc.getSenders().filter(function (s) {
          return s.track && s.track.kind === 'video';
        })[0];
        var old = CallUI.local.getVideoTracks()[0];
        if (old) { CallUI.local.removeTrack(old); old.stop(); }
        CallUI.local.addTrack(track);
        track.enabled = CallUI.camOn;
        $('local-video').srcObject = CallUI.local;
        if (sender) {
          var p = sender.replaceTrack(track);
          if (p && p.catch) p.catch(function () {});
        }
        CallUI.capBitrate();
        CallUI.paintControls();
      }).catch(function () {
        toast('Nu am gasit cealalta camera.', 'bad');
      });
    },

    /* ---- endings -------------------------------------------------------- */

    hangup: function () {
      if (CallUI.callId) {
        Signal.send({
          type: CallUI.state === 'dialing' ? 'call-cancel' : 'hangup',
          callId: CallUI.callId,
          reason: 'user'
        });
      }
      CallUI.teardown(null);
    },

    fail: function (message) {
      if (CallUI.callId) Signal.send({ type: 'hangup', callId: CallUI.callId, reason: 'client-error' });
      CallUI.teardown(message);
    },

    /** The single exit path. Always safe to call, in any state. */
    teardown: function (message) {
      clearInterval(CallUI.timer);
      clearInterval(CallUI.statsTimer);
      CallUI.timer = 0;
      CallUI.statsTimer = 0;

      if (CallUI.pc) {
        attempt(function () { CallUI.pc.ontrack = null; CallUI.pc.onicecandidate = null; });
        attempt(function () { CallUI.pc.close(); });
      }
      CallUI.pc = null;

      if (CallUI.local) {
        CallUI.local.getTracks().forEach(function (t) { attempt(function () { t.stop(); }); });
      }
      CallUI.local = null;
      CallUI.remote = null;
      attempt(function () { $('local-video').srcObject = null; });
      attempt(function () { $('remote-video').srcObject = null; });

      CallUI.closeUi();
      CallUI.reset();
      if (message) toast(message, null, 4000);
    },

    reset: function () {
      CallUI.callId = null;
      CallUI.role = null;
      CallUI.state = 'idle';
      CallUI.peer = null;
      CallUI.pendingOffer = null;
      CallUI.pendingCandidates = [];
      CallUI.remoteReady = false;
      CallUI.acceptedLocally = false;
      CallUI.micOn = true;
      CallUI.camOn = true;
      CallUI.facing = 'user';
      CallUI.startedAt = 0;
      CallUI.everConnected = false;
      CallUI.iceRestarting = false;
      clearTimeout(CallUI.iceFailTimer);
      CallUI.iceFailTimer = 0;
    },

    acquireWakeLock: function () {
      if (!navigator.wakeLock || CallUI.wakeLock) return;
      attempt(function () {
        navigator.wakeLock.request('screen').then(function (lock) {
          CallUI.wakeLock = lock;
          lock.addEventListener('release', function () { CallUI.wakeLock = null; });
        }).catch(function () {});
      });
    },

    releaseWakeLock: function () {
      if (!CallUI.wakeLock) return;
      attempt(function () { CallUI.wakeLock.release(); });
      CallUI.wakeLock = null;
    }
  };

  var CALL_FAIL_MSG = {
    'callee-offline': 'Rama nu e pornita acum.',
    'caller-offline': 'M-am deconectat. Incearca din nou.',
    'busy':           'Rama vorbeste deja cu cineva.',
    'not-allowed':    'Contul tau nu are voie sa sune la rama asta.',
    'server-busy':    'Serverul e ocupat. Incearca peste un minut.'
  };

  function wireSignalHandlers() {
    Signal.on('registered', function (msg) {
      Signal.registered = true;
      Frames.setContacts(msg.contacts || []);
      App.updateConnection();
    });

    Signal.on('presence', function (msg) {
      Frames.update(msg.id, msg.online, msg.busy);
    });

    Signal.on('call-ringing', function (msg) { CallUI.onRinging(msg); });
    Signal.on('incoming-call', function (msg) { CallUI.onIncoming(msg); });
    Signal.on('call-accepted', function (msg) { CallUI.onAccepted(msg); });
    Signal.on('offer', function (msg) { CallUI.onOffer(msg); });
    Signal.on('answer', function (msg) { CallUI.onAnswer(msg); });
    Signal.on('ice-candidate', function (msg) { CallUI.onCandidate(msg); });

    Signal.on('call-declined', function (msg) {
      CallUI.teardown((msg.byName || 'Rama') + ' nu a raspuns la apel.');
    });
    Signal.on('call-cancelled', function () {
      CallUI.teardown('Apelul a fost anulat.');
    });
    Signal.on('hangup', function () {
      CallUI.teardown('Apelul s-a incheiat.');
    });
    Signal.on('call-ended', function (msg) {
      if (CallUI.state === 'idle') return;
      var why = msg.outcome === 'missed' ? 'Nu a raspuns nimeni.' : 'Apelul s-a incheiat.';
      CallUI.teardown(why);
    });
    Signal.on('call-failed', function (msg) {
      CallUI.teardown(CALL_FAIL_MSG[msg.code] || 'Apelul nu a putut porni.');
      Frames.render();
    });

    Signal.on('error', function (msg) {
      if (msg.code === 'auth-failed') {
        Signal.registered = false;
        App.updateConnection();
        return;
      }
      if (msg.code === 'not-allowed' || msg.code === 'peer-offline') {
        CallUI.teardown(CALL_FAIL_MSG[msg.code] || 'Apelul s-a intrerupt.');
      }
    });

    Signal.on('heartbeat-ack', function () { /* liveness only */ });
  }

  /* =========================================================================
   * 13. App shell / navigation / boot
   * ====================================================================== */

  var TAB_TITLES = { gallery: 'Poze', upload: 'Incarca poze', call: 'Apel video' };

  var App = {
    tab: 'gallery',
    online: navigator.onLine !== false,

    mount: function () {
      Login.mount();
      Gallery.mount();
      Viewer.mount();
      Uploader.mount();
      CallUI.mount();
      wireSignalHandlers();

      var tabs = $('tabbar').querySelectorAll('.tab');
      for (var i = 0; i < tabs.length; i++) {
        (function (btn) {
          on(btn, 'click', function () { App.goTab(btn.dataset.tab); });
        })(tabs[i]);
      }

      on($('btn-account'), 'click', App.accountSheet);
      on($('sheet-backdrop'), 'click', Sheet.close);

      window.addEventListener('online', function () {
        App.online = true;
        App.updateConnection();
        Signal.connect();
      });
      window.addEventListener('offline', function () {
        App.online = false;
        App.updateConnection();
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (Session.account) Signal.connect();
        if (CallUI.state !== 'idle') CallUI.acquireWakeLock();
      });

      Net.onUnauthenticated = function () {
        if (!Session.account) return;
        Session.account = null;
        Signal.disconnect();
        CallUI.teardown(null);
        App.showLogin('Sesiunea a expirat. Intra din nou cu parola.');
      };
    },

    goTab: function (tab) {
      if (!TAB_TITLES[tab]) tab = 'gallery';
      App.tab = tab;
      show($('screen-gallery'), tab === 'gallery');
      show($('screen-upload'), tab === 'upload');
      show($('screen-call'), tab === 'call');
      text($('topbar-title'), TAB_TITLES[tab]);

      var tabs = $('tabbar').querySelectorAll('.tab');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].dataset.tab === tab) tabs[i].setAttribute('aria-current', 'page');
        else tabs[i].removeAttribute('aria-current');
      }
      show($('selbar'), tab === 'gallery' && Gallery.selecting);
      attempt(function () { window.scrollTo(0, 0); });
      if (tab === 'gallery') Gallery.start();
    },

    updateConnection: function () {
      var banner = $('banner');
      var message = '';

      if (!App.online) message = 'Nu ai internet. Astept sa revina.';
      else if (Session.account && !Signal.connected) message = 'Ma reconectez la server...';
      else if (Session.account && !Signal.registered) message = 'Ma conectez pentru apeluri...';

      text(banner, message);
      show(banner, !!message);
      document.body.classList.toggle('has-banner', !!message);

      text($('topbar-sub'), Session.account ? Session.account.displayName : '');
      Frames.render();
    },

    accountSheet: function () {
      var name = Session.account ? Session.account.displayName : '';
      Sheet.open({
        title: name,
        text: Signal.connected
          ? 'Esti conectat. Pozele si apelurile merg.'
          : 'Nu sunt conectat la server chiar acum.',
        actions: [
          {
            label: 'Iesi din cont',
            style: 'btn-quiet',
            onSelect: function () { App.doLogout(false); }
          },
          {
            label: 'Iesi de pe toate telefoanele',
            style: 'btn-danger-quiet',
            hint: 'Foloseste asta daca ai pierdut un telefon.',
            onSelect: function () { App.doLogout(true); }
          },
          { label: 'Inapoi', style: 'btn-quiet' }
        ]
      });
    },

    doLogout: function (everywhere) {
      Session.logout(everywhere).then(function () {
        Session.account = null;
        Signal.disconnect();
        CallUI.teardown(null);
        App.showLogin('');
      });
    },

    showLogin: function (message) {
      document.body.classList.add('no-shell');
      document.body.classList.remove('has-strip');
      show($('shell'), false);
      show($('screen-login'), true);
      Login.build();
      if (message) Login.error(message); else Login.clearError();
      App.updateConnection();
      App.hideBoot();
    },

    enterShell: function () {
      document.body.classList.remove('no-shell');
      show($('screen-login'), false);
      show($('shell'), true);
      text($('avatar-initial'),
        (Session.account.displayName || '?').charAt(0));
      App.hideBoot();

      Gallery.hardReset();
      Albums.load().then(function () {
        Gallery.buildFilter();
        Uploader.buildAlbumPicker();
      });

      App.goTab('gallery');
      App.updateConnection();
      Signal.connect();
    },

    hideBoot: function () {
      var boot = $('boot');
      if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
    },

    boot: function () {
      App.mount();
      Session.fetch().then(function (account) {
        if (account && account.peerId) App.enterShell();
        else if (account && !account.peerId) {
          // Authenticated but the server did not bind us to a roster peer:
          // photos work, calls do not. Say so once, in the call tab.
          App.enterShell();
          toast('Contul tau nu are inca acces la apeluri video.', 'bad', 5000);
        } else {
          App.showLogin('');
        }
      }).catch(function (err) {
        App.showLogin(err && err.status === 0
          ? 'Nu am putut ajunge la server. Verifica internetul si reincarca.'
          : '');
      });
    }
  };

  /* =========================================================================
   * 14. Service worker (PWA install + offline shell)
   * ====================================================================== */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      attempt(function () {
        navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () {});
      });
    });
  }

  /* ---- go ------------------------------------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', App.boot);
  } else {
    App.boot();
  }

}());
