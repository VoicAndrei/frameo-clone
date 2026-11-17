/* =============================================================================
 * Rama — tablet application
 * =============================================================================
 * One page, one state at a time, single tap only.
 *
 *   idle ──tap──► call-grid ──tap tile──► dialing ──accepted──► in-call ──► post-call ──► idle
 *     ▲                │                    │                     │
 *     │                └──"Inapoi la poze"──┘                     │
 *     │                                     └──declined──► unavailable ──► idle
 *     │
 *     ├──incoming──► incoming-ring ──"RASPUNDE"──► in-call
 *     │                   │
 *     │                   ├──"NU ACUM"──► decline-undo(5s) ──"RASPUNDE"──► in-call
 *     │                   │                      └──timeout──► missed(60s) ──► idle
 *     │                   └──45s──► missed(60s) ──► idle
 *     │
 *     └──unrecoverable──► fault (self-healing, no error text ever)
 *
 * Everything below is deliberately dependency-free: one file, no build step,
 * works with the network completely down.
 * ========================================================================== */

(function () {
  'use strict';

  /* ==========================================================================
   * 0. Tiny helpers
   * ======================================================================== */

  var Q = new URLSearchParams(location.search);
  var DEBUG = Q.get('debug') === '1';
  var FORCE_MOCK = Q.get('mock') === '1';

  function now() { return Date.now(); }
  function $(sel) { return document.querySelector(sel); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* Console output only in debug. Nothing is ever printed on screen. */
  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[rama]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* Promise that never rejects — the whole app is built on "quietly carry on". */
  function safe(promise, fallback) {
    return Promise.resolve(promise).catch(function () { return fallback; });
  }

  function fetchJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        reject(new Error('timeout'));
      }, timeoutMs || 8000);
      fetch(url, ctrl ? { signal: ctrl.signal, credentials: 'same-origin' }
                      : { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('http');
          return r.json();
        })
        .then(function (j) { if (!done) { done = true; clearTimeout(t); resolve(j); } })
        .catch(function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }

  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  /* Named timers, cleared wholesale on every state change so no stale timeout
   * can ever yank the screen out from under the user. */
  var Timers = {
    _m: {},
    set: function (name, ms, fn) {
      this.clear(name);
      this._m[name] = setTimeout(function () { delete Timers._m[name]; fn(); }, ms);
    },
    every: function (name, ms, fn) {
      this.clear(name);
      this._m[name] = setInterval(fn, ms);
    },
    clear: function (name) {
      if (this._m[name]) { clearTimeout(this._m[name]); clearInterval(this._m[name]); delete this._m[name]; }
    },
    clearAll: function () { for (var k in this._m) this.clear(k); }
  };

  /* Timers that must survive state changes (manifest refresh, socket, …). */
  var Persistent = Object.create(Timers);
  Persistent._m = {};

  /* ==========================================================================
   * 1b. ICE servers
   * --------------------------------------------------------------------------
   * The frame MUST have STUN/TURN or a call from a phone on mobile data can
   * only ever connect when ICE happens to find a direct path. The server mints
   * the list per principal (ARCHITECTURE-PUBLIC.md §3.6: a frame gets the
   * TAILNET coturn profile and deliberately no public STUN), so it is fetched,
   * never hard-coded, and it is refreshed well before the credential expires.
   *
   * `Call.createPeer()` is synchronous, so the list is primed in the background
   * and simply read out of CFG.iceServers when a peer connection is built. A
   * refresh is also kicked off the moment a call starts in either direction, so
   * a frame that has been idle for days is never left with a stale credential.
   * ======================================================================== */
  var Ice = {
    fetchedAt: 0,
    expiresAt: 0,
    inFlight: null,

    /** Best effort, never rejects, never blocks the UI. */
    refresh: function (force) {
      var now = Date.now();
      if (Ice.inFlight) return Ice.inFlight;
      /* Still comfortably valid (30 min of headroom) and fetched recently. */
      if (!force && Ice.expiresAt - now > 30 * 60 * 1000 && now - Ice.fetchedAt < 60 * 60 * 1000) {
        return Promise.resolve(CFG.iceServers);
      }
      /* The device cookie is minted from ?device=&token=, but a kiosk that has
       * lost the cookie can still authenticate with the roster token it keeps
       * in localStorage — ice.js accepts either. */
      var url = '/api/ice';
      if (Store.deviceId && Store.authToken) {
        url += '?device=' + encodeURIComponent(Store.deviceId) +
               '&token=' + encodeURIComponent(Store.authToken);
      }
      Ice.inFlight = fetchJSON(url, 8000).then(function (doc) {
        var servers = (doc && doc.iceServers) || [];
        if (!Array.isArray(servers)) servers = [];
        if (servers.length) {
          CFG.iceServers = servers;
          lsSet('frame.iceServers', servers);
        }
        var exp = doc && doc.expiresAt ? Date.parse(doc.expiresAt) : NaN;
        Ice.expiresAt = isFinite(exp) ? exp
          : Date.now() + (Number(doc && doc.ttl) || 43200) * 1000;
        Ice.fetchedAt = Date.now();
        log('ice servers', servers.length, doc && doc.profile);
        return CFG.iceServers;
      }).catch(function () {
        /* 503 (TURN not deployed yet) or a dead network. Keep whatever we have:
         * a direct/tailnet path still works without a relay. */
        return CFG.iceServers;
      }).then(function (out) {
        Ice.inFlight = null;
        return out;
      });
      return Ice.inFlight;
    },

    /** Restore the last known list so the very first call after a reboot is not naked. */
    init: function () {
      var cached = lsGet('frame.iceServers', null);
      if (Array.isArray(cached) && cached.length && !(CFG.iceServers || []).length) {
        CFG.iceServers = cached;
      }
    }
  };

  /* ==========================================================================
   * 1. Configuration
   * ======================================================================== */

  var DEFAULTS = {
    photosUrl: '/api/photos?limit=300',
    photoUrlTemplate: '/api/photo/{id}',
    wsUrl: null,
    wsPath: '/ws',
    /* Identity. These MUST match a peer in the server's roster.json: the
     * signalling server authenticates every socket and rejects unknown ids or
     * bad tokens. Provisioned per tablet via the kiosk URL
     *   https://<magicdns>/?device=frame-a&token=<authToken>
     * which is persisted to localStorage on first load. */
    deviceId: null,
    deviceName: null,
    authToken: null,
    screenDiagonalIn: 11,
    pxPerMm: null,
    slideDwellMs: 25000,
    slideFadeMs: 1500,
    ringArmMs: 800,
    ringMs: 45000,
    missedMs: 60000,
    declineUndoMs: 5000,
    dialUndoMs: 3000,
    gridIdleMs: 30000,
    outgoingRingMs: 45000,
    unavailMs: 8000,
    postCallMs: 6000,
    reconnectGraceMs: 2000,
    callFailMs: 25000,
    activationLockMs: 1500,
    maxHoldMs: 2500,
    maxContactRadiusMm: 15,
    photoCacheLimit: 300,
    manifestRefreshMs: 600000,
    iceServers: []
  };

  var CFG = {};
  (function buildConfig() {
    var injected = window.FRAME_CONFIG || {};
    for (var k in DEFAULTS) CFG[k] = DEFAULTS[k];
    for (var j in injected) if (injected[j] !== undefined && injected[j] !== null) CFG[j] = injected[j];
    /* Query-string overrides, dev only but harmless in production. */
    for (var q in DEFAULTS) {
      if (!Q.has(q)) continue;
      var raw = Q.get(q);
      CFG[q] = (typeof DEFAULTS[q] === 'number') ? parseFloat(raw) : raw;
    }
  })();

  /* ==========================================================================
   * 2. Physical metrics — the millimetre is the unit of this UI
   * ======================================================================== */

  var Metrics = {
    pxPerMm: 8.104,

    compute: function () {
      var w = (screen && screen.width) || window.innerWidth || 1920;
      var h = (screen && screen.height) || window.innerHeight || 1200;
      /* CSS-pixel diagonal / physical diagonal in mm.
       * devicePixelRatio cancels: (devPx/dpr) / (devPx / pxPerMmPhysical / dpr). */
      var diagPx = Math.sqrt(w * w + h * h);
      var diagMm = (CFG.screenDiagonalIn || 11) * 25.4;
      var v = CFG.pxPerMm ? Number(CFG.pxPerMm) : (diagPx / diagMm);
      if (!isFinite(v) || v <= 0) v = 8.104;
      this.pxPerMm = clamp(v, 2, 24);
      document.documentElement.style.setProperty('--mm', this.pxPerMm.toFixed(4) + 'px');
      document.documentElement.style.setProperty('--fade', CFG.slideFadeMs + 'ms');
      this.fitControls();
      return this.pxPerMm;
    },

    /**
     * Guarantee the Answer/Decline row physically fits across the panel.
     *
     * The three hard constraints are non-negotiable, so the only thing allowed
     * to give is the overall size of the pair:
     *   - 27 mm dead zone between them            (fixed)
     *   - 10 mm clear of every screen edge        (fixed)
     *   - Answer area = 2.40 x Decline area       (fixed)
     * Scaling both dimensions of both buttons by one factor keeps the ratio
     * exact. The factor is clamped at 0.5, below which Decline's short side
     * would drop under the 20 mm touch-target minimum.
     *
     * On the 11" / 1920x1200 reference panel the required width is
     *   120 + 27 + 55 = 202 mm  vs  237 - 20 = 217 mm available
     * so the factor is 1 and the buttons are exactly the specified size.
     */
    fitControls: function () {
      var wMm = (window.innerWidth || 1920) / this.pxPerMm;
      var availMm = wMm - 2 * 10 - 27;             /* edges + dead zone */
      var needMm = 120 + 55;                       /* the two widths at scale 1 */
      var s = clamp(availMm / needMm, 0.5, 1);
      if (!isFinite(s) || s <= 0) s = 1;
      this.btnScale = s;
      document.documentElement.style.setProperty('--btn-scale', s.toFixed(4));
      return s;
    },

    mm: function (n) { return n * this.pxPerMm; },
    toMm: function (px) { return px / this.pxPerMm; }
  };

  /* ==========================================================================
   * 3. DOM references
   * ======================================================================== */

  var SCREENS = {
    idle:    $('#screen-idle'),
    ring:    $('#screen-ring'),
    undo:    $('#screen-undo'),
    grid:    $('#screen-grid'),
    dial:    $('#screen-dial'),
    call:    $('#screen-call'),
    post:    $('#screen-post'),
    missed:  $('#screen-missed'),
    unavail: $('#screen-unavail'),
    fault:   $('#screen-fault')
  };

  var el = {
    slideA:        $('#slide-a'),
    slideB:        $('#slide-b'),
    ringName:      $('#ring-name'),
    btnAnswer:     $('#btn-answer'),
    btnDecline:    $('#btn-decline'),
    undoName:      $('#undo-name'),
    btnUndoAnswer: $('#btn-undo-answer'),
    undoCountdown: $('#undo-countdown'),
    tiles:         $('#tiles'),
    btnBack:       $('#btn-back'),
    dialName:      $('#dial-name'),
    btnDialStop:   $('#btn-dial-stop'),
    dialCountdown: $('#dial-countdown'),
    remoteVideo:   $('#remote-video'),
    selfVideo:     $('#self-video'),
    audioBg:       $('#audio-bg'),
    audioFace:     $('#audio-face'),
    audioRing:     $('#audio-ring'),
    btnHangup:     $('#btn-hangup'),
    missedName:    $('#missed-name'),
    unavailName:   $('#unavail-name'),
    debug:         $('#debug'),
    debugMetrics:  $('#debug-metrics'),
    mmOverlay:     $('#mm-overlay')
  };

  /* ==========================================================================
   * 4. Input guard
   * --------------------------------------------------------------------------
   * The single most important accessibility component. Rules:
   *   - activation on POINTERUP, and only if the pointer is still inside the
   *     target rect (a badly-landed finger slides off to abort);
   *   - two or more simultaneous pointers poison the whole gesture;
   *   - contact radius > 15 mm (palm, cheek, sleeve) is ignored;
   *   - holds longer than 2500 ms do not activate;
   *   - after any successful activation, ALL input is ignored for 1500 ms.
   * ======================================================================== */

  var Guard = (function () {
    var pointers = new Map();
    var poisoned = false;
    var unpoisonTimer = null;
    var lockUntil = 0;

    function poison() {
      poisoned = true;
      if (unpoisonTimer) { clearTimeout(unpoisonTimer); unpoisonTimer = null; }
    }
    function maybeUnpoison() {
      if (pointers.size > 0 || !poisoned) return;
      if (unpoisonTimer) clearTimeout(unpoisonTimer);
      /* Fingers rarely lift at the same instant — wait a beat before trusting
       * the screen again. */
      unpoisonTimer = setTimeout(function () { poisoned = false; unpoisonTimer = null; }, 300);
    }

    window.addEventListener('pointerdown', function (e) {
      pointers.set(e.pointerId, now());
      if (pointers.size >= 2) poison();
    }, true);

    function release(e) { pointers.delete(e.pointerId); maybeUnpoison(); }
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);

    /* Kill every gesture the browser would otherwise interpret. */
    ['contextmenu', 'selectstart', 'dragstart', 'dblclick', 'gesturestart',
     'gesturechange', 'gestureend'].forEach(function (type) {
      window.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false, capture: true });
    });
    window.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false, capture: true });
    window.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false, capture: true });
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, true);
    window.addEventListener('keydown', function (e) {
      /* No keyboard on the tablet; on the desktop harness keys must not leak. */
      if (!DEBUG) e.preventDefault();
    }, true);

    function radiusMm(e) {
      var w = e.width || 0, h = e.height || 0;
      if (!w && !h) return 0;                     /* mouse / synthetic: unknown */
      return (Math.max(w, h) / 2) / Metrics.pxPerMm;
    }

    function inside(node, e) {
      var r = node.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right &&
             e.clientY >= r.top  && e.clientY <= r.bottom;
    }

    return {
      lock: function (ms) { lockUntil = Math.max(lockUntil, now() + (ms || 0)); },
      isLocked: function () { return now() < lockUntil; },
      isPoisoned: function () { return poisoned; },
      pointerCount: function () { return pointers.size; },
      radiusMm: radiusMm,
      inside: inside,
      reset: function () { pointers.clear(); poisoned = false; lockUntil = 0; }
    };
  })();

  /**
   * Bind a single-tap handler to an element. This is the ONLY way any control
   * in this app becomes interactive.
   */
  function bindTap(node, handler) {
    if (!node) return;
    var cand = null;

    function clearPressed() { node.classList.remove('is-pressed'); }

    function reset() {
      if (cand && cand.capture) { try { node.releasePointerCapture(cand.id); } catch (e) {} }
      cand = null;
      clearPressed();
    }

    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;         /* right/middle click */
      if (Guard.isLocked() || Guard.isPoisoned()) { reset(); return; }
      if (Guard.pointerCount() > 1) { reset(); return; }
      if (Guard.radiusMm(e) > CFG.maxContactRadiusMm) { reset(); return; }

      cand = { id: e.pointerId, t: now(), capture: false };
      try { node.setPointerCapture(e.pointerId); cand.capture = true; } catch (err) {}
      node.classList.add('is-pressed');
    });

    node.addEventListener('pointermove', function (e) {
      if (!cand || e.pointerId !== cand.id) return;
      /* Visual only: the finger may wander back in and still activate. */
      if (Guard.inside(node, e)) node.classList.add('is-pressed');
      else clearPressed();
    });

    node.addEventListener('pointerup', function (e) {
      if (!cand || e.pointerId !== cand.id) { reset(); return; }
      var held = now() - cand.t;
      var ok = !Guard.isPoisoned() &&
               !Guard.isLocked() &&
               held <= CFG.maxHoldMs &&
               Guard.inside(node, e);
      reset();
      if (!ok) { log('tap rejected', { held: held, poisoned: Guard.isPoisoned(), locked: Guard.isLocked() }); return; }
      Guard.lock(CFG.activationLockMs);
      Ringer.unlockAudio();
      try { handler(e); } catch (err) { Fault.raise(err); }
    });

    node.addEventListener('pointercancel', reset);
    node.addEventListener('lostpointercapture', function () { clearPressed(); });
  }

  /* ==========================================================================
   * 5. Generated imagery (used as a fallback and by the desktop harness)
   * ======================================================================== */

  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var AVATAR_COLORS = ['#2F4858', '#33658A', '#55636F', '#3E5641', '#5B4B49', '#463F56'];

  /** Neutral avatar used whenever a contact has no stored photo. */
  function avatarFor(name) {
    var label = (name || '?').trim().charAt(0).toUpperCase() || '?';
    var code = 0;
    for (var i = 0; i < (name || '?').length; i++) code += (name || '?').charCodeAt(i);
    var bg = AVATAR_COLORS[code % AVATAR_COLORS.length];
    return svgDataUri(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">' +
      '<rect width="800" height="800" fill="' + bg + '"/>' +
      '<circle cx="400" cy="315" r="140" fill="rgba(255,255,255,0.86)"/>' +
      '<path d="M160 720c0-135 108-235 240-235s240 100 240 235z" fill="rgba(255,255,255,0.86)"/>' +
      '<text x="400" y="356" font-family="sans-serif" font-size="170" font-weight="700" ' +
      'text-anchor="middle" fill="' + bg + '">' + label.replace(/[<>&"]/g, '') + '</text>' +
      '</svg>'
    );
  }

  /** Placeholder slideshow imagery for the desktop harness / empty first run. */
  function mockPhotos(count) {
    var out = [];
    var shapes = [[1600, 1200], [1200, 1600], [1400, 1400], [1920, 1080]];
    for (var i = 0; i < count; i++) {
      var s = shapes[i % shapes.length];
      var hue = (i * 47) % 360;
      out.push({
        id: 'mock-' + i,
        url: svgDataUri(
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + s[0] + '" height="' + s[1] + '">' +
          '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="hsl(' + hue + ',48%,42%)"/>' +
          '<stop offset="1" stop-color="hsl(' + ((hue + 60) % 360) + ',44%,22%)"/>' +
          '</linearGradient></defs>' +
          '<rect width="100%" height="100%" fill="url(#g)"/>' +
          '<circle cx="' + (s[0] * 0.5) + '" cy="' + (s[1] * 0.42) + '" r="' + (Math.min(s[0], s[1]) * 0.18) + '" fill="rgba(255,255,255,0.9)"/>' +
          '<text x="50%" y="' + (s[1] * 0.82) + '" font-family="sans-serif" font-size="' + (Math.min(s[0], s[1]) * 0.14) +
          '" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,0.92)">' + (i + 1) + '</text>' +
          '</svg>'
        )
      });
    }
    return out;
  }

  var MOCK_CONTACTS = [
    { id: 'ana', name: 'Ana' },
    { id: 'maria',  name: 'Maria'  },
    { id: 'ioana',  name: 'Ioana'  },
    { id: 'radu',   name: 'Radu'   }
  ];

  /* ==========================================================================
   * 6. Store — device identity, contacts, photo manifest
   * --------------------------------------------------------------------------
   * Cache first, network second, always. A dead server changes nothing about
   * what the tablet shows.
   * ======================================================================== */

  var Store = {
    deviceId: null,
    deviceName: null,
    authToken: null,
    contacts: [],
    photos: [],
    usingMock: false,

    init: function () {
      /* Identity is provisioned once per tablet through the kiosk URL and then
       * lives in localStorage. There is deliberately NO random fallback id: the
       * server authenticates against roster.json, so an invented id could only
       * ever produce an endless auth-failed reconnect loop. */
      this.deviceId = CFG.deviceId || Q.get('device') || lsGet('frame.deviceId', null);
      this.authToken = CFG.authToken || Q.get('token') || lsGet('frame.authToken', null);
      if (this.deviceId) lsSet('frame.deviceId', this.deviceId);
      if (this.authToken) lsSet('frame.authToken', this.authToken);
      this.deviceName = CFG.deviceName || lsGet('frame.deviceName', null) || this.deviceId || '';

      this.contacts = normalizeContacts(lsGet('frame.contacts', []));
      this.photos = normalizePhotos(lsGet('frame.photos', []));

      if (FORCE_MOCK || (DEBUG && !this.photos.length)) {
        this.usingMock = true;
        this.photos = mockPhotos(12);
      }
      if (FORCE_MOCK || (DEBUG && !this.contacts.length)) {
        this.usingMock = true;
        this.contacts = normalizeContacts(MOCK_CONTACTS);
      }
    },

    contactById: function (id) {
      if (!id) return null;
      for (var i = 0; i < this.contacts.length; i++) {
        if (String(this.contacts[i].id) === String(id)) return this.contacts[i];
      }
      return null;
    },

    /** Resolve a peer from a signalling message into something displayable. */
    peerFrom: function (msg) {
      var id = msg && (msg.from || msg.peer || msg.caller || msg.id);
      var known = this.contactById(id);
      if (known) return known;
      var name = (msg && (msg.name || msg.fromName || msg.callerName)) || String(id || '');
      return { id: id, name: name, photo: avatarFor(name) };
    },

    /**
     * The contact list is NOT fetched over HTTP: the signalling server sends it
     * in the `registered` frame, already filtered to the mutually-allowed peers
     * of this device. That is the same list the whitelist is enforced against,
     * so the grid can never offer somebody the server would refuse to dial.
     */
    applyRegistered: function (msg) {
      if (msg.id) { this.deviceId = msg.id; lsSet('frame.deviceId', msg.id); }
      if (msg.displayName) { this.deviceName = msg.displayName; lsSet('frame.deviceName', msg.displayName); }
      var list = normalizeContacts(msg.contacts || []);
      if (!list.length) return;
      this.contacts = list;
      this.usingMock = false;
      lsSet('frame.contacts', list.map(function (c) {
        return { id: c.id, name: c.name, photo: c.rawPhoto || null };
      }));
      if (State.current === 'grid') Grid.render();
    },

    /** Photo manifest: cache first, refresh in the background, warm the SW cache. */
    refreshPhotos: function () {
      var self = this;
      if (FORCE_MOCK) return Promise.resolve();
      return safe(fetchJSON(CFG.photosUrl, 12000).then(function (json) {
        var list = normalizePhotos(json);
        if (!list.length) return;
        self.photos = list;
        self.usingMock = false;
        lsSet('frame.photos', list);
        Slideshow.onManifestChanged();
        PhotoCache.warm(list.slice(0, CFG.photoCacheLimit).map(function (p) { return p.url; }));
        Fault.clearIfHealthy();
      }));
    }
  };

  function normalizeContacts(raw) {
    if (!raw) return [];
    var arr = Array.isArray(raw) ? raw : (raw.contacts || raw.peers || []);
    var out = [];
    for (var i = 0; i < arr.length && out.length < 4; i++) {   /* 2x2 grid MAX */
      var c = arr[i];
      if (!c) continue;
      if (typeof c === 'string') c = { id: c, name: c };
      var name = c.name || c.displayName || c.id || '';
      if (!name) continue;
      var photo = c.photo || c.photoUrl || c.avatar || c.image || null;
      out.push({ id: c.id != null ? c.id : name, name: String(name), rawPhoto: photo, photo: photo || avatarFor(name) });
    }
    return out;
  }

  function normalizePhotos(raw) {
    if (!raw) return [];
    var arr = Array.isArray(raw) ? raw
            : (raw.photos || raw.items || raw.assets || raw.results || []);
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length && out.length < CFG.photoCacheLimit; i++) {
      var p = arr[i];
      if (!p) continue;
      var url = null, id = null;
      if (typeof p === 'string') { url = p; id = p; }
      else {
        id = p.id != null ? p.id : (p.assetId != null ? p.assetId : null);
        url = p.url || p.src || p.path || p.thumbnail || null;
        if (!url && id != null) url = CFG.photoUrlTemplate.replace('{id}', encodeURIComponent(id));
      }
      if (!url) continue;
      out.push({ id: id != null ? String(id) : url, url: String(url) });
    }
    return out;
  }

  /* ==========================================================================
   * 7. Photo cache bridge (talks to sw.js)
   * ======================================================================== */

  var PhotoCache = {
    reg: null,
    pending: {},          /* messages queued until a worker exists, keyed by type */

    register: function () {
      if (!('serviceWorker' in navigator)) return;
      var self = this;

      navigator.serviceWorker.register('sw.js', { scope: './' })
        .then(function (reg) { log('service worker registered', reg.scope); })
        .catch(function (e) { log('service worker failed (non-fatal)', e); });

      /* On a first visit the worker does not control the page yet, so anything
       * posted to navigator.serviceWorker.controller is silently dropped and
       * the photo cache never gets primed. Wait for `ready` (which resolves to
       * an *active* worker regardless of control) and flush the queue. */
      navigator.serviceWorker.ready.then(function (reg) {
        self.reg = reg;
        var queued = self.pending;
        self.pending = {};
        for (var type in queued) self.post(queued[type]);
      }).catch(function () {});

      /* A replacement worker starts with an empty view of the world: re-prime. */
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (Store.photos.length) {
          self.warm(Store.photos.slice(0, CFG.photoCacheLimit).map(function (p) { return p.url; }));
        }
      });
    },

    post: function (msg) {
      var target = (this.reg && this.reg.active) ||
                   (navigator.serviceWorker && navigator.serviceWorker.controller);
      if (!target) { this.pending[msg.type] = msg; return; }
      try { target.postMessage(msg); } catch (e) { this.pending[msg.type] = msg; }
    },

    /** Ask the SW to pull the newest photos into the cache and trim to the cap. */
    warm: function (urls) {
      if (!urls || !urls.length) return;
      this.post({ type: 'warm', urls: urls, limit: CFG.photoCacheLimit });
    },

    drop: function () { this.post({ type: 'drop' }); }
  };

  /* ==========================================================================
   * 8. Slideshow
   * --------------------------------------------------------------------------
   * 25 s dwell, 1.5 s crossfade, object-fit CONTAIN over a blurred dimmed copy
   * of the same photo. No Ken Burns, no motion, no chrome beyond the hint bar.
   * ======================================================================== */

  var Slideshow = {
    index: 0,
    front: null,
    back: null,
    running: false,
    broken: {},          /* urls that failed to decode */
    shownOnce: false,

    init: function () {
      this.front = el.slideA;
      this.back = el.slideB;
      this.index = lsGet('frame.slideIndex', 0) || 0;
    },

    list: function () { return Store.photos; },

    start: function () {
      if (this.running) return;
      this.running = true;
      if (!this.list().length) { Fault.noPhotos(); return; }
      this.show(this.index, true);
      this.schedule();
    },

    stop: function () {
      this.running = false;
      Timers.clear('slide');
    },

    schedule: function () {
      var self = this;
      Timers.set('slide', CFG.slideDwellMs, function () {
        if (!self.running) return;
        self.next();
      });
    },

    next: function () {
      var list = this.list();
      if (!list.length) { Fault.noPhotos(); return; }
      this.index = (this.index + 1) % list.length;
      lsSet('frame.slideIndex', this.index);
      this.show(this.index, false);
      this.schedule();
    },

    /** Preload, then crossfade. A photo that fails to load is skipped silently. */
    show: function (i, immediate) {
      var self = this;
      var list = this.list();
      if (!list.length) return;
      var attempts = 0;

      function attempt(idx) {
        if (attempts++ > Math.min(list.length, 12)) {
          if (!self.shownOnce) Fault.noPhotos();
          return;
        }
        var photo = list[idx % list.length];
        if (!photo || self.broken[photo.url]) { attempt(idx + 1); return; }
        var img = new Image();
        img.decoding = 'async';
        img.onload = function () {
          self.paint(photo.url, immediate);
          self.shownOnce = true;
          self.index = idx % list.length;
          Fault.clearIfHealthy();
          self.preloadAhead(idx + 1);
        };
        img.onerror = function () {
          self.broken[photo.url] = true;
          attempt(idx + 1);
        };
        img.src = photo.url;
      }
      attempt(i);
    },

    paint: function (url, immediate) {
      var back = this.back;
      var fg = back.querySelector('.slide-fg');
      var bg = back.querySelector('.slide-bg');
      fg.src = url;
      bg.src = url;
      if (immediate) {
        back.style.transition = 'none';
        /* force style flush so the transition suppression takes effect */
        void back.offsetWidth;
      }
      back.classList.add('is-front');
      this.front.classList.remove('is-front');
      if (immediate) {
        void back.offsetWidth;
        back.style.transition = '';
      }
      var tmp = this.front; this.front = back; this.back = tmp;
    },

    /** Warm the next few photos so a crossfade never waits on the network. */
    preloadAhead: function (from) {
      var list = this.list();
      if (!list.length) return;
      for (var k = 0; k < 3; k++) {
        var p = list[(from + k) % list.length];
        if (!p || this.broken[p.url]) continue;
        var im = new Image();
        im.decoding = 'async';
        im.src = p.url;
      }
    },

    onManifestChanged: function () {
      this.broken = {};
      if (this.index >= this.list().length) this.index = 0;
      if (this.running && !this.shownOnce) { this.show(this.index, true); this.schedule(); }
    }
  };

  /* ==========================================================================
   * 9. Ringer — warm, low-frequency two-tone bell, 55% -> 100% over 6 s
   * --------------------------------------------------------------------------
   * Presbycusis kills high frequencies, and a sudden loud tone next to an
   * 80-year-old is a fall risk. Synthesised with WebAudio so there is no asset
   * to fetch and nothing to fail offline.
   * ======================================================================== */

  var Ringer = {
    ctx: null,
    master: null,
    startedAt: 0,
    running: false,

    ensure: function () {
      if (this.ctx) return this.ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        var lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;          /* warm, no piercing harmonics */
        this.master.connect(lp);
        lp.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; }
      return this.ctx;
    },

    /* Browsers gate audio behind a gesture; every tap calls this. */
    unlockAudio: function () {
      var ctx = this.ensure();
      if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    },

    bell: function (t0) {
      var ctx = this.ctx;
      var tones = [[330, 0.55], [247, 0.85]];     /* E4 then B3 — a soft two-tone */
      var t = t0;
      for (var i = 0; i < tones.length; i++) {
        var freq = tones[i][0], dur = tones[i][1];
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.9, t + 0.05);   /* soft attack */
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g);
        g.connect(this.master);
        osc.start(t);
        osc.stop(t + dur + 0.05);
        t += dur * 0.82;
      }
      return t;
    },

    start: function () {
      var ctx = this.ensure();
      if (!ctx || this.running) return;
      this.unlockAudio();
      this.running = true;
      this.startedAt = ctx.currentTime;
      var self = this;

      /* Volume ramp 55% -> 100% across the first 6 s of ringing. */
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.setValueAtTime(0.55, ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 6);

      function pulse() {
        if (!self.running || !self.ctx) return;
        try { self.bell(self.ctx.currentTime + 0.02); } catch (e) {}
      }
      pulse();
      Timers.every('ring-audio', 2600, pulse);
    },

    stop: function () {
      this.running = false;
      Timers.clear('ring-audio');
      if (!this.ctx || !this.master) return;
      try {
        this.master.gain.cancelScheduledValues(this.ctx.currentTime);
        this.master.gain.setValueAtTime(this.master.gain.value, this.ctx.currentTime);
        this.master.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.25);
      } catch (e) {}
    }
  };

  /* ==========================================================================
   * 10. Signalling client
   * --------------------------------------------------------------------------
   * Message types are exactly:
   *   register, call-request, call-accept, call-decline, call-cancel,
   *   offer, answer, ice-candidate, hangup, heartbeat
   * A dead socket is never surfaced to the user in any way.
   * ======================================================================== */

  var Signal = {
    ws: null,
    connected: false,
    backoff: 1000,
    handlers: {},

    url: function () {
      if (CFG.wsUrl) return CFG.wsUrl;
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      return proto + location.host + CFG.wsPath;
    },

    connect: function () {
      var self = this;
      if (FORCE_MOCK) return;
      /* No credentials -> the server would close every socket with auth-failed.
       * Stay silent instead of hammering it; a provisioning reload fixes it. */
      if (!Store.deviceId || !Store.authToken) { log('signalling: no identity provisioned'); return; }
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      var ws;
      try { ws = new WebSocket(this.url()); } catch (e) { this.scheduleReconnect(); return; }
      this.ws = ws;

      ws.onopen = function () {
        self.connected = true;
        self.backoff = 1000;
        log('signalling open');
        /* Exactly the shape the server's handleRegister() expects: id + token.
         * Anything else is rejected with auth-failed and the socket is closed. */
        self.send({ type: 'register', id: Store.deviceId, authToken: Store.authToken });
        Persistent.every('heartbeat', 20000, function () {
          self.send({ type: 'heartbeat' });
        });
      };

      ws.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.type) return;
        log('<<', msg.type, msg);
        var fn = self.handlers[msg.type];
        if (fn) { try { fn(msg); } catch (err) { Fault.raise(err); } }
      };

      ws.onclose = function () {
        self.connected = false;
        Persistent.clear('heartbeat');
        self.scheduleReconnect();
      };

      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    },

    scheduleReconnect: function () {
      var self = this;
      this.backoff = Math.min(this.backoff * 1.7, 10000);
      Persistent.set('reconnect', this.backoff, function () { self.connect(); });
    },

    on: function (type, fn) { this.handlers[type] = fn; },

    send: function (msg) {
      if (!this.ws || this.ws.readyState !== 1) { log('>> dropped', msg.type); return false; }
      try {
        msg.from = msg.from || Store.deviceId;
        this.ws.send(JSON.stringify(msg));
        log('>>', msg.type, msg);
        return true;
      } catch (e) { return false; }
    }
  };

  /* ==========================================================================
   * 11. Call engine (WebRTC)
   * ======================================================================== */

  var Call = {
    pc: null,
    localStream: null,
    remoteStream: null,
    peer: null,
    callId: null,
    role: null,               /* 'caller' | 'callee' */
    pendingCandidates: [],
    remoteReady: false,
    iceRestarting: false,     /* an iceRestart offer is in flight */
    audioOnly: false,
    forcedAudioOnly: false,
    analyser: null,
    levelRaf: 0,
    lastStats: null,
    badTicks: 0,
    goodTicks: 0,

    /* Call ids are allocated by the signalling server and never by the client;
     * see startOutgoing(). Nothing here invents one. */

    /* ---- media ---------------------------------------------------------- */

    getLocalMedia: function () {
      var self = this;
      if (this.localStream) return Promise.resolve(this.localStream);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
      var full = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
      };
      return navigator.mediaDevices.getUserMedia(full)
        .catch(function () {
          /* No camera / permission denied — audio still works, silently. */
          return navigator.mediaDevices.getUserMedia({ audio: full.audio, video: false });
        })
        .then(function (stream) {
          self.localStream = stream;
          try {
            el.selfVideo.srcObject = stream;
            var p = el.selfVideo.play();
            if (p && p.catch) p.catch(function () {});
          } catch (e) {}
          /* No local camera: hide the (empty) PiP, but do NOT force photo mode
           * — the other side may still be sending perfectly good video. */
          if (!stream.getVideoTracks().length) {
            el.selfVideo.style.display = 'none';
            self.setAudioOnly(true);
          } else {
            el.selfVideo.style.display = '';
          }
          return stream;
        })
        .catch(function () { return null; });
    },

    /* ---- peer connection ------------------------------------------------ */

    createPeer: function () {
      var self = this;
      var conf = { iceServers: CFG.iceServers || [], bundlePolicy: 'max-bundle' };
      var pc = new RTCPeerConnection(conf);
      this.pc = pc;

      pc.onicecandidate = function (e) {
        if (!e.candidate) return;
        Signal.send({
          type: 'ice-candidate',
          callId: self.callId,
          candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate
        });
      };

      pc.ontrack = function (e) {
        if (!self.remoteStream) self.remoteStream = new MediaStream();
        self.remoteStream.addTrack(e.track);
        try {
          el.remoteVideo.srcObject = self.remoteStream;
          var p = el.remoteVideo.play();
          if (p && p.catch) p.catch(function () {});
        } catch (err) {}
        if (e.track.kind === 'audio') self.attachLevelMeter(self.remoteStream);
        if (e.track.kind === 'video') self.evaluateVideo();
        e.track.onmute = function () { self.evaluateVideo(); };
        e.track.onunmute = function () { self.evaluateVideo(); };
        e.track.onended = function () { self.evaluateVideo(); };
      };

      pc.oniceconnectionstatechange = function () {
        var s = pc.iceConnectionState;
        log('ice', s);
        if (s === 'connected' || s === 'completed') {
          self.iceRestarting = false;
          self.setReconnecting(false);
          if (State.current === 'dial') State.go('call', { peer: self.peer });
        } else if (s === 'disconnected' || s === 'failed') {
          self.setReconnecting(true);
          if (s === 'failed' && self.role === 'caller') self.tryIceRestart();
        }
      };

      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'connected') self.setReconnecting(false);
        if (pc.connectionState === 'closed') self.setReconnecting(false);
      };

      return pc;
    },

    /* One restart at a time: `failed` fires repeatedly and an offer per event
     * produces duplicates the far side answers twice. */
    tryIceRestart: function () {
      var self = this;
      if (!this.pc || this.role !== 'caller' || this.iceRestarting) return;
      this.iceRestarting = true;
      safe(this.pc.createOffer({ iceRestart: true }).then(function (offer) {
        return self.pc.setLocalDescription(offer).then(function () {
          Signal.send({ type: 'offer', callId: self.callId, sdp: self.pc.localDescription });
        });
      }).catch(function () { self.iceRestarting = false; }));
    },

    /* ---- outgoing ------------------------------------------------------- */

    /**
     * The CALL ID IS THE SERVER'S, not ours. `call-request` carries only `to`;
     * the server allocates the id, checks the whitelist, and hands it back in
     * `call-ringing`. Every later frame (offer / answer / ice / hangup) is
     * validated against that id, so inventing one locally would get every
     * subsequent message rejected with "no-such-call".
     */
    startOutgoing: function (contact) {
      this.reset();
      this.peer = contact;
      this.role = 'caller';
      this.callId = null;
      Signal.send({ type: 'call-request', to: contact.id });
      this.getLocalMedia();     /* warm the camera while the other side rings */
    },

    /** Remote side pressed RASPUNDE: build the offer. */
    onAccepted: function () {
      var self = this;
      if (this.role !== 'caller') return;
      this.getLocalMedia().then(function (stream) {
        var pc = self.createPeer();
        if (stream) stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
        else { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); }
        return pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          Signal.send({ type: 'offer', callId: self.callId, sdp: pc.localDescription });
        });
      }).catch(function (e) { Call.abort(); });
    },

    /* ---- incoming ------------------------------------------------------- */

    prepareIncoming: function (peer, callId) {
      this.reset();
      this.peer = peer;
      this.role = 'callee';
      this.callId = callId;
    },

    /** Local user pressed RASPUNDE. */
    accept: function () {
      var self = this;
      Signal.send({ type: 'call-accept', callId: this.callId });
      this.getLocalMedia().then(function () {
        if (!self.pc) self.createPeer();
        self.drainOffer();
      });
    },

    /** Offers can arrive before or after the user answers; both are handled. */
    onOffer: function (msg) {
      this.pendingOffer = msg.sdp || msg.description || msg.offer || null;
      if (this.acceptedLocally) this.drainOffer();
      else if (State.current === 'call') this.drainOffer();
    },

    drainOffer: function () {
      var self = this;
      var sdp = this.pendingOffer;
      if (!sdp) return;
      this.pendingOffer = null;
      if (!this.pc) this.createPeer();
      var pc = this.pc;
      safe(pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(function () {
        self.remoteReady = true;
        self.flushCandidates();
        if (self.localStream) {
          self.localStream.getTracks().forEach(function (t) {
            var already = pc.getSenders().some(function (s) { return s.track === t; });
            if (!already) pc.addTrack(t, self.localStream);
          });
        }
        return pc.createAnswer();
      }).then(function (answer) {
        if (!answer) return;
        return pc.setLocalDescription(answer).then(function () {
          Signal.send({ type: 'answer', callId: self.callId, sdp: pc.localDescription });
        });
      }));
    },

    onAnswer: function (msg) {
      var self = this;
      var sdp = msg.sdp || msg.description || msg.answer;
      if (!this.pc || !sdp) return;
      // Only an outstanding local offer can take an answer; a duplicate or late
      // one would throw InvalidStateError. See the same guard in admin/app.js.
      if (this.pc.signalingState !== 'have-local-offer') return;
      safe(this.pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(function () {
        self.remoteReady = true;
        self.iceRestarting = false;
        self.flushCandidates();
      }));
    },

    onCandidate: function (msg) {
      var c = msg.candidate || msg.iceCandidate;
      if (!c) return;
      if (!this.pc || !this.remoteReady) { this.pendingCandidates.push(c); return; }
      safe(this.pc.addIceCandidate(new RTCIceCandidate(c)));
    },

    flushCandidates: function () {
      var self = this;
      var list = this.pendingCandidates;
      this.pendingCandidates = [];
      list.forEach(function (c) { safe(self.pc.addIceCandidate(new RTCIceCandidate(c))); });
    },

    /* ---- quality watchdog ------------------------------------------------
     * If video stalls or bandwidth collapses we swap to the stored photo plus
     * an audio-level ring. It is never announced and never shows black.
     * -------------------------------------------------------------------- */

    startWatchdog: function () {
      var self = this;
      this.badTicks = 0;
      this.goodTicks = 0;
      this.lastStats = null;
      this.callStartedAt = now();
      Timers.every('call-stats', 2000, function () { self.tick(); });
    },

    tick: function () {
      var self = this;
      if (!this.pc || !this.pc.getStats) return;
      this.pc.getStats(null).then(function (report) {
        var frames = null, bytes = null, ts = null;
        report.forEach(function (s) {
          if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
            frames = s.framesDecoded != null ? s.framesDecoded : frames;
            bytes = s.bytesReceived != null ? s.bytesReceived : bytes;
            ts = s.timestamp;
          }
        });
        if (frames == null && bytes == null) { self.evaluateVideo(); return; }
        var prev = self.lastStats;
        self.lastStats = { frames: frames || 0, bytes: bytes || 0, ts: ts || now() };
        if (!prev) return;
        /* Grace period: a call always starts with no decoded frames, and we
         * must not flap to the photo in the first seconds of every call. */
        if (now() - self.callStartedAt < 6000) return;
        var dt = Math.max(0.001, (self.lastStats.ts - prev.ts) / 1000);
        var fps = ((self.lastStats.frames - prev.frames) / dt);
        var kbps = ((self.lastStats.bytes - prev.bytes) * 8 / 1000) / dt;
        var bad = (fps < 1) || (kbps < 40);       /* ~150 kbps is the design floor */
        var good = (fps >= 4) && (kbps >= 120);
        if (bad) { self.badTicks++; self.goodTicks = 0; } else if (good) { self.goodTicks++; self.badTicks = 0; }
        else { self.badTicks = 0; self.goodTicks = 0; }
        if (self.badTicks >= 2 && !self.audioOnly) self.setAudioOnly(true);
        if (self.goodTicks >= 2 && self.audioOnly && !self.forcedAudioOnly) self.setAudioOnly(false);
      }).catch(function () {});
    },

    /**
     * Decide between the video presentation and the stored-photo presentation.
     * Called on every track event, on every <video> readiness event and from
     * the stats watchdog. Video is only shown once the element has actually
     * painted a frame, so the user never sees a black rectangle.
     */
    evaluateVideo: function () {
      var hasLive = false;
      if (this.remoteStream) {
        this.remoteStream.getVideoTracks().forEach(function (t) {
          if (t.readyState === 'live' && !t.muted) hasLive = true;
        });
      }
      if (!hasLive) { this.setAudioOnly(true); return; }
      var painted = el.remoteVideo.videoWidth > 0 && el.remoteVideo.videoHeight > 0;
      if (painted && !this.forcedAudioOnly && this.badTicks < 2) this.setAudioOnly(false);
    },

    setAudioOnly: function (on, forced) {
      if (forced) this.forcedAudioOnly = !!on;
      if (this.audioOnly === !!on) return;
      this.audioOnly = !!on;
      SCREENS.call.classList.toggle('is-audio-only', this.audioOnly);
      log('audio-only', this.audioOnly);
    },

    setReconnecting: function (on) {
      var self = this;
      if (on) {
        if (Timers._m['reconnect-show'] || SCREENS.call.classList.contains('is-reconnecting')) {
          /* already pending or shown */
        } else {
          Timers.set('reconnect-show', CFG.reconnectGraceMs, function () {
            SCREENS.call.classList.add('is-reconnecting');
          });
        }
        if (!Timers._m['reconnect-fail']) {
          Timers.set('reconnect-fail', CFG.callFailMs, function () {
            State.go('post');
          });
        }
      } else {
        Timers.clear('reconnect-show');
        Timers.clear('reconnect-fail');
        SCREENS.call.classList.remove('is-reconnecting');
      }
    },

    /* ---- audio level ring ---------------------------------------------- */

    attachLevelMeter: function (stream) {
      var self = this;
      var ctx = Ringer.ensure();
      if (!ctx || !stream || !stream.getAudioTracks().length) return;
      try {
        var src = ctx.createMediaStreamSource(stream);
        var an = ctx.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0.85;
        src.connect(an);
        this.analyser = an;
      } catch (e) { return; }

      var buf = new Uint8Array(this.analyser.frequencyBinCount);
      var level = 0;
      function frame() {
        if (!self.analyser) return;
        self.analyser.getByteFrequencyData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        var rms = Math.sqrt(sum / buf.length) / 255;
        level += (clamp(rms * 2.4, 0, 1) - level) * 0.25;    /* gentle */
        el.audioRing.style.setProperty('--level', level.toFixed(3));
        self.levelRaf = requestAnimationFrame(frame);
      }
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = requestAnimationFrame(frame);
    },

    /* ---- teardown -------------------------------------------------------- */

    hangup: function () {
      if (this.callId) Signal.send({ type: 'hangup', callId: this.callId });
      this.reset();
    },

    /* Only legal while the call is still ringing; after that it is a hangup.
     * Skipped entirely when the server has not allocated a call id yet (the
     * user tapped "Opreste" before call-ringing came back). */
    cancel: function () {
      if (this.callId) Signal.send({ type: 'call-cancel', callId: this.callId });
      this.reset();
    },

    /**
     * NOT sent when the user taps "NU ACUM". The UI offers a 5 s undo, and the
     * server tears the call down the moment it sees a decline, so the decline is
     * deferred until the undo window has actually expired (or the ring times
     * out). Until then the call stays alive and one tap still answers it.
     */
    decline: function () {
      if (this.callId) Signal.send({ type: 'call-decline', callId: this.callId, reason: 'declined-by-callee' });
    },

    abort: function () { this.reset(); },

    reset: function () {
      Timers.clear('call-stats');
      Timers.clear('reconnect-show');
      Timers.clear('reconnect-fail');
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = 0;
      this.analyser = null;
      if (this.pc) {
        try { this.pc.onicecandidate = null; this.pc.ontrack = null; this.pc.close(); } catch (e) {}
      }
      this.pc = null;
      if (this.localStream) {
        this.localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      }
      this.localStream = null;
      this.remoteStream = null;
      try {
        el.remoteVideo.srcObject = null;
        el.selfVideo.srcObject = null;
        el.selfVideo.style.display = '';
      } catch (e) {}
      this.peer = null;
      this.callId = null;
      this.role = null;
      this.pendingCandidates = [];
      this.pendingOffer = null;
      this.remoteReady = false;
      this.iceRestarting = false;
      this.acceptedLocally = false;
      this.forcedAudioOnly = false;
      this.setAudioOnly(false);
      SCREENS.call.classList.remove('is-reconnecting');
    }
  };

  /* ==========================================================================
   * 12. Fault handling — the ONE permitted failure screen
   * --------------------------------------------------------------------------
   * Network and server outages must NEVER reach this. Only a truly empty frame
   * (no photos anywhere, not even cached) or a crash gets here, and it heals
   * itself in the background.
   * ======================================================================== */

  var Fault = {
    active: false,
    raisedAt: 0,

    noPhotos: function () {
      if (Store.photos.length) return;
      this.show();
    },

    raise: function (err) {
      log('fault', err);
      this.show();
    },

    show: function () {
      if (this.active) return;
      this.active = true;
      this.raisedAt = now();
      State.go('fault');
    },

    /** Called whenever something proves the frame is working again. */
    clearIfHealthy: function () {
      if (!this.active) return;
      if (!Store.photos.length) return;
      this.active = false;
      if (State.current === 'fault') State.go('idle');
    }
  };

  /* ==========================================================================
   * 13. Call grid
   * ======================================================================== */

  var Grid = {
    render: function () {
      var list = Store.contacts.slice(0, 4);
      el.tiles.setAttribute('data-count', String(list.length));
      el.tiles.innerHTML = '';
      list.forEach(function (contact) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'tile';

        var photo = document.createElement('span');
        photo.className = 'tile-photo';

        var bg = document.createElement('img');
        bg.className = 'person-bg';
        bg.alt = '';
        bg.decoding = 'async';
        bg.src = contact.photo;

        var fg = document.createElement('img');
        fg.className = 'person-fg';
        fg.alt = '';
        fg.decoding = 'async';
        fg.src = contact.photo;
        fg.onerror = function () { fg.src = avatarFor(contact.name); bg.src = fg.src; };

        photo.appendChild(bg);
        photo.appendChild(fg);

        var name = document.createElement('span');
        name.className = 'tile-name';
        name.textContent = contact.name;

        tile.appendChild(photo);
        tile.appendChild(name);
        el.tiles.appendChild(tile);

        bindTap(tile, function () { State.go('dial', { peer: contact }); });
      });
    }
  };

  /* ==========================================================================
   * 14. Screen painting helpers
   * ======================================================================== */

  function paintPerson(screen, peer) {
    var src = (peer && peer.photo) || avatarFor(peer && peer.name);
    var bg = screen.querySelector('.person-bg');
    var fg = screen.querySelector('.person-fg');
    if (bg) bg.src = src;
    if (fg) {
      fg.onerror = function () {
        var a = avatarFor(peer && peer.name);
        fg.onerror = null;
        fg.src = a;
        if (bg) bg.src = a;
      };
      fg.src = src;
    }
  }

  function runCountdown(node, ms) {
    if (!node) return;
    node.classList.remove('is-running');
    node.style.setProperty('--countdown', ms + 'ms');
    void node.offsetWidth;                       /* restart the animation */
    node.classList.add('is-running');
  }

  function armActions(screen, ms) {
    var actions = screen.querySelector('.actions');
    if (!actions) return;
    actions.classList.add('is-arming');
    Timers.set('arm', ms, function () { actions.classList.remove('is-arming'); });
  }

  /* ==========================================================================
   * 15. State machine
   * ======================================================================== */

  var State = {
    current: null,
    peer: null,

    go: function (name, opts) {
      opts = opts || {};
      var prev = this.current;
      log('state', prev, '->', name);

      this.exit(prev, name);
      Timers.clearAll();

      this.current = name;
      for (var k in SCREENS) SCREENS[k].classList.toggle('is-active', k === name);
      document.body.setAttribute('data-state', name);

      /* Baseline arming on every transition: nothing is tappable for a moment
       * after the screen changes, so a tap aimed at the previous screen can
       * never activate the new one. */
      Guard.lock(opts.armMs != null ? opts.armMs : 600);

      this.enter(name, opts);
    },

    exit: function (name, nextName) {
      if (name === 'idle') Slideshow.stop();
      if (name === 'ring' || name === 'undo') Ringer.stop();
      if (name === 'call' && nextName !== 'call') Call.reset();
    },

    enter: function (name, opts) {
      var self = this;
      switch (name) {

        /* ---------------- IDLE ------------------------------------------- */
        case 'idle':
          this.peer = null;
          Call.reset();
          Slideshow.start();
          break;

        /* ---------------- CALL GRID (outgoing) --------------------------- */
        case 'grid':
          Grid.render();
          Timers.set('grid-idle', CFG.gridIdleMs, function () { self.go('idle'); });
          break;

        /* ---------------- DIALING ---------------------------------------- */
        case 'dial':
          this.peer = opts.peer;
          paintPerson(SCREENS.dial, this.peer);
          el.dialName.textContent = 'Suna pe ' + this.peer.name + '...';

          /* Button starts as the 3 s undo, then becomes the hang-up. */
          el.btnDialStop.classList.remove('is-hangup');
          el.btnDialStop.querySelector('.btn-label').textContent = 'Opreste';
          el.btnDialStop.querySelector('use').setAttribute('href', '#ic-stop');
          el.btnDialStop.dataset.mode = 'undo';
          runCountdown(el.dialCountdown, CFG.dialUndoMs);
          Timers.set('dial-undo', CFG.dialUndoMs, function () {
            el.btnDialStop.classList.add('is-hangup');
            el.btnDialStop.querySelector('.btn-label').textContent = 'INCHIDE';
            el.btnDialStop.querySelector('use').setAttribute('href', '#ic-hangup');
            el.btnDialStop.dataset.mode = 'hangup';
            el.dialCountdown.classList.remove('is-running');
          });

          if (!opts.mock) Call.startOutgoing(this.peer);
          Timers.set('dial-timeout', CFG.outgoingRingMs, function () {
            Call.cancel();
            self.go('unavail', { peer: self.peer });
          });
          break;

        /* ---------------- INCOMING RING ---------------------------------- */
        case 'ring':
          this.peer = opts.peer;
          paintPerson(SCREENS.ring, this.peer);
          el.ringName.textContent = this.peer.name + ' te suna';
          Guard.lock(CFG.ringArmMs);              /* both buttons inert 800 ms */
          armActions(SCREENS.ring, CFG.ringArmMs);
          Ringer.start();
          Timers.set('ring-timeout', CFG.ringMs, function () {
            Call.decline();
            self.go('missed', { peer: self.peer });
          });
          break;

        /* ---------------- DECLINE UNDO (5 s) ----------------------------- */
        case 'undo':
          this.peer = opts.peer || this.peer;
          paintPerson(SCREENS.undo, this.peer);
          el.undoName.textContent = this.peer.name + ' te suna';
          runCountdown(el.undoCountdown, CFG.declineUndoMs);
          armActions(SCREENS.undo, 400);
          Timers.set('undo-timeout', CFG.declineUndoMs, function () {
            /* Undo window over: only now does the caller learn it was declined. */
            Call.decline();
            self.go('missed', { peer: self.peer });
          });
          break;

        /* ---------------- IN CALL ---------------------------------------- */
        case 'call':
          this.peer = opts.peer || this.peer || Call.peer;
          /* The audio-only layer doubles as the "connecting" visual: the
           * person's photo is on screen from the very first frame. */
          var src = (this.peer && this.peer.photo) || avatarFor(this.peer && this.peer.name);
          el.audioBg.src = src;
          el.audioFace.src = src;
          el.audioFace.onerror = function () {
            var a = avatarFor(self.peer && self.peer.name);
            el.audioFace.onerror = null;
            el.audioFace.src = a;
            el.audioBg.src = a;
          };
          if (!opts.mock) {
            Call.evaluateVideo();
            Call.startWatchdog();
          }
          break;

        /* ---------------- POST CALL -------------------------------------- */
        case 'post':
          Call.reset();
          Timers.set('post', CFG.postCallMs, function () { self.go('idle'); });
          break;

        /* ---------------- MISSED ----------------------------------------- */
        case 'missed':
          this.peer = opts.peer || this.peer;
          Call.reset();
          paintPerson(SCREENS.missed, this.peer);
          el.missedName.textContent = (this.peer ? this.peer.name : '') + ' a sunat';
          Timers.set('missed', CFG.missedMs, function () { self.go('idle'); });
          break;

        /* ---------------- UNAVAILABLE ------------------------------------ */
        case 'unavail':
          this.peer = opts.peer || this.peer;
          Call.reset();
          paintPerson(SCREENS.unavail, this.peer);
          el.unavailName.textContent = (this.peer ? this.peer.name : '') + ' nu poate raspunde acum.';
          Timers.set('unavail', CFG.unavailMs, function () { self.go('idle'); });
          break;

        /* ---------------- FAULT ------------------------------------------ */
        case 'fault':
          Call.reset();
          /* Heal in the background, forever, without saying anything. */
          Timers.every('fault-retry', 15000, function () {
            Store.refreshPhotos();
            Signal.connect();
          });
          break;
      }
    }
  };

  /* ==========================================================================
   * 16. Wiring — controls
   * ======================================================================== */

  function wireControls() {
    /* IDLE: the whole screen is the target. */
    bindTap(SCREENS.idle, function () {
      if (!Store.contacts.length) return;         /* nothing to dial: stay put */
      State.go('grid');
    });

    /* RING */
    bindTap(el.btnAnswer, function () {
      Ringer.stop();
      Call.acceptedLocally = true;
      Call.accept();
      State.go('call', { peer: State.peer });
    });

    bindTap(el.btnDecline, function () {
      Ringer.stop();
      /* Deliberately NOT Call.decline() here: the server ends the call the
       * instant it sees a decline, which would make the 5 s undo card a lie.
       * The decline is sent when the undo window expires. */
      State.go('undo', { peer: State.peer });
    });

    /* UNDO */
    bindTap(el.btnUndoAnswer, function () {
      Call.acceptedLocally = true;
      Call.accept();
      State.go('call', { peer: State.peer });
      /* If the caller already gave up, nothing will connect — fall through to
       * the missed screen rather than sitting on a photo forever. */
      Timers.set('undo-connect', 12000, function () {
        if (State.current === 'call' && (!Call.pc || Call.pc.iceConnectionState === 'new')) {
          State.go('missed', { peer: State.peer });
        }
      });
    });

    /* GRID */
    bindTap(el.btnBack, function () { State.go('idle'); });

    /* DIALING */
    bindTap(el.btnDialStop, function () {
      Call.cancel();
      State.go(el.btnDialStop.dataset.mode === 'undo' ? 'grid' : 'idle');
    });

    /* IN CALL — the only control */
    bindTap(el.btnHangup, function () {
      Call.hangup();
      State.go('post');
    });

    /* Non-idle informational screens: one tap moves things along. */
    bindTap(SCREENS.post, function () { State.go('idle'); });
    bindTap(SCREENS.missed, function () { State.go('grid'); });
    bindTap(SCREENS.unavail, function () { State.go('grid'); });

    /* The moment the remote <video> actually has pixels, leave photo mode.
     * 'resize' fires when videoWidth/Height first become known. */
    ['loadeddata', 'playing', 'resize'].forEach(function (evt) {
      el.remoteVideo.addEventListener(evt, function () {
        if (State.current === 'call') Call.evaluateVideo();
      });
    });
    /* And if the stream dies mid-call, go straight to the photo. */
    ['emptied', 'stalled', 'suspend'].forEach(function (evt) {
      el.remoteVideo.addEventListener(evt, function () {
        if (State.current === 'call') Call.evaluateVideo();
      });
    });
  }

  /* ==========================================================================
   * 17. Wiring — signalling
   * ======================================================================== */

  /* Message names below are the SERVER's, verbatim (see signalling/README.md
   * §4 "Server -> client"). Note the deliberate asymmetry: what we SEND is
   * `call-accept` / `call-decline` / `call-cancel`, what we RECEIVE is
   * `call-accepted` / `call-declined` / `call-cancelled` / `incoming-call`. */
  function wireSignalling() {
    /* Identity + the authoritative, already-whitelisted contact list. */
    Signal.on('registered', function (msg) {
      Store.applyRegistered(msg);
    });

    /* A contact came online or went offline. Refresh the grid if it is up. */
    Signal.on('presence', function (msg) {
      var c = Store.contactById(msg.id);
      if (!c) return;
      c.online = !!msg.online;
      c.busy = !!msg.busy;
      if (State.current === 'grid') Grid.render();
    });

    Signal.on('incoming-call', function (msg) {
      var peer = Store.peerFrom(msg);
      var callId = msg.callId;
      var here = State.current;

      /* The kiosk ring-push (?from=…&call=…) can put this screen up before the
       * socket message lands, and the user may even have answered already. In
       * that case adopt the real call id rather than restarting the ring. */
      if (!Call.callId && (here === 'ring' || here === 'undo' || here === 'call')) {
        Call.peer = Call.peer || peer;
        Call.role = 'callee';
        Call.callId = callId;
        if (Call.acceptedLocally) Call.accept();
        return;
      }

      if (here === 'call') {
        /* Busy: refuse quietly, the caller's own device tells them. */
        if (callId) Signal.send({ type: 'call-decline', callId: callId, reason: 'busy' });
        return;
      }
      if (here === 'dial') Call.cancel();

      Call.prepareIncoming(peer, callId);
      State.go('ring', { peer: peer, armMs: CFG.ringArmMs });
    });

    /* Our outgoing call was accepted by the server: adopt ITS call id. */
    Signal.on('call-ringing', function (msg) {
      if (Call.role !== 'caller') return;
      Call.callId = msg.callId || Call.callId;
    });

    /* The whitelist, the busy check or the capacity cap refused the call. */
    Signal.on('call-failed', function (msg) {
      if (Call.role !== 'caller') return;
      var peer = Call.peer || State.peer;
      Call.reset();
      if (State.current === 'dial') State.go('unavail', { peer: peer });
    });

    Signal.on('call-accepted', function (msg) {
      if (msg.callId && Call.callId && msg.callId !== Call.callId) return;
      if (msg.callId) Call.callId = msg.callId;
      Timers.clear('dial-timeout');
      /* The server names the role and says who creates the offer. Only the
       * caller does; the callee just waits for it. */
      if (msg.shouldCreateOffer && Call.role === 'caller') Call.onAccepted();
    });

    Signal.on('call-declined', function (msg) {
      if (Call.role !== 'caller') return;
      if (msg.callId && Call.callId && msg.callId !== Call.callId) return;
      var peer = Call.peer || State.peer;
      Call.reset();
      State.go('unavail', { peer: peer });
    });

    Signal.on('call-cancelled', function (msg) {
      if (msg.callId && Call.callId && msg.callId !== Call.callId) return;
      if (State.current === 'ring' || State.current === 'undo') {
        var peer = State.peer;
        Call.reset();
        State.go('missed', { peer: peer });
      } else if (State.current === 'call') {
        State.go('post');
      }
    });

    Signal.on('offer', function (msg) { Call.onOffer(msg); });
    Signal.on('answer', function (msg) { Call.onAnswer(msg); });
    Signal.on('ice-candidate', function (msg) { Call.onCandidate(msg); });

    Signal.on('hangup', function (msg) {
      if (msg.callId && Call.callId && msg.callId !== Call.callId) return;
      if (State.current === 'call' || State.current === 'dial') State.go('post');
    });

    /* Authoritative end-of-call. It also covers the cases the server decides
     * on its own: ring timeout, peer disconnect, admin hangup. Whatever the
     * reason, the call object on this side is dead once this arrives. */
    Signal.on('call-ended', function (msg) {
      if (msg.callId && Call.callId && msg.callId !== Call.callId) return;
      var here = State.current;
      var peer = Call.peer || State.peer;
      if (here !== 'call' && here !== 'dial' && here !== 'ring' && here !== 'undo') return;
      Call.reset();
      if (here === 'call') State.go('post');
      else if (here === 'dial') State.go('unavail', { peer: peer });
      else State.go('missed', { peer: peer });
    });

    /* Protocol errors are logged and otherwise ignored: nothing the server can
     * say about a message is worth putting on a grandparent's screen. */
    Signal.on('error', function (msg) { log('server error', msg && msg.code, msg && msg.detail); });

    /* Reply to our application-level keepalive; nothing to do. */
    Signal.on('heartbeat-ack', function () {});
  }

  /* ==========================================================================
   * 18. Screen wake lock (belt and braces; the kiosk app also keeps it on)
   * ======================================================================== */

  var Wake = {
    lock: null,
    request: function () {
      var self = this;
      if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
      safe(navigator.wakeLock.request('screen').then(function (l) {
        self.lock = l;
        l.addEventListener('release', function () { self.lock = null; });
      }));
    }
  };

  /* ==========================================================================
   * 19. Desktop-only test harness (?debug=1)
   * ======================================================================== */

  var Harness = {
    fakePeer: function () {
      return State.peer || Store.contacts[0] || { id: 'test', name: 'Ana', photo: avatarFor('Ana') };
    },

    init: function () {
      if (!DEBUG) return;
      /* NOTE: 'debug-mode', not 'debug' — a bare `.debug` rule in style.css
       * would otherwise match <body> and hide the entire application. */
      document.body.classList.add('debug-mode');
      el.debug.hidden = false;
      this.updateMetrics();
      window.addEventListener('resize', this.updateMetrics.bind(this));

      var self = this;
      el.debug.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button[data-dbg]');
        if (!btn) return;
        ev.preventDefault();
        Guard.reset();                 /* the harness bypasses the input guard */
        self.run(btn.getAttribute('data-dbg'));
      });

      /* Keyboard shortcuts: 1..9,0 walk the states. */
      window.addEventListener('keydown', function (ev) {
        var map = { '1': 'idle', '2': 'grid', '3': 'dial', '4': 'ring', '5': 'undo',
                    '6': 'call', '7': 'call-audio', '8': 'post', '9': 'missed', '0': 'fault' };
        if (map[ev.key]) { Guard.reset(); self.run(map[ev.key]); }
      });
    },

    updateMetrics: function () {
      var mm = Metrics.pxPerMm;
      el.debugMetrics.textContent =
        'viewport ' + window.innerWidth + 'x' + window.innerHeight +
        '  screen ' + screen.width + 'x' + screen.height + ' @dpr' + (window.devicePixelRatio || 1) +
        '\n--mm = ' + mm.toFixed(3) + ' px/mm  (diag ' + CFG.screenDiagonalIn + '")' +
        '\n10mm edge=' + Math.round(mm * 10) + 'px  20mm target=' + Math.round(mm * 20) +
        'px  27mm gap=' + Math.round(mm * 27) + 'px' +
        '\nanswer=' + Math.round(mm * 120) + 'x' + Math.round(mm * 44) +
        '  decline=' + Math.round(mm * 55) + 'x' + Math.round(mm * 40) + '  ratio 2.40' +
        '\nstate=' + State.current + '  photos=' + Store.photos.length +
        '  contacts=' + Store.contacts.length + (Store.usingMock ? ' (mock)' : '');
    },

    run: function (what) {
      var peer = this.fakePeer();
      switch (what) {
        case 'idle':   State.go('idle'); break;
        case 'grid':   State.go('grid'); break;
        case 'dial':   State.peer = peer; State.go('dial', { peer: peer, mock: true }); break;
        case 'ring':   State.peer = peer; Call.prepareIncoming(peer, 'debug-call'); State.go('ring', { peer: peer, armMs: CFG.ringArmMs }); break;
        case 'undo':   State.peer = peer; State.go('undo', { peer: peer }); break;

        case 'call':
          State.peer = peer;
          State.go('call', { peer: peer, mock: true });
          this.fakeVideo(false);
          break;

        case 'call-audio':
          State.peer = peer;
          State.go('call', { peer: peer, mock: true });
          Call.setAudioOnly(true, true);
          this.fakeLevel();
          break;

        case 'call-reconnect':
          State.peer = peer;
          State.go('call', { peer: peer, mock: true });
          SCREENS.call.classList.add('is-reconnecting');
          break;

        case 'post':    State.go('post'); break;
        case 'missed':  State.peer = peer; State.go('missed', { peer: peer }); break;
        case 'unavail': State.peer = peer; State.go('unavail', { peer: peer }); break;
        case 'fault':   Fault.active = false; Fault.show(); break;

        case 'next-photo':   Slideshow.next(); break;
        case 'drop-cache':   PhotoCache.drop(); try { localStorage.clear(); } catch (e) {} break;
        case 'grid-overlay': el.mmOverlay.hidden = !el.mmOverlay.hidden; break;
        case 'hide':         el.debug.hidden = true; break;
      }
      this.updateMetrics();
    },

    /** Use the local camera (if allowed) as a stand-in for the remote stream. */
    fakeVideo: function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (s) {
        Call.localStream = s;
        try {
          el.remoteVideo.srcObject = s;
          el.selfVideo.srcObject = s;
          el.remoteVideo.play().catch(function () {});
          el.selfVideo.play().catch(function () {});
        } catch (e) {}
        Call.setAudioOnly(false, true);
      }).catch(function () {
        /* No webcam on this desktop: show the audio-only presentation instead. */
        Call.setAudioOnly(true, true);
        Harness.fakeLevel();
      });
    },

    /** Animate the audio-level ring without a real stream. */
    fakeLevel: function () {
      var t0 = now();
      function frame() {
        if (State.current !== 'call') return;
        var t = (now() - t0) / 1000;
        var v = Math.abs(Math.sin(t * 1.7)) * 0.5 + Math.abs(Math.sin(t * 4.3)) * 0.35;
        el.audioRing.style.setProperty('--level', clamp(v, 0, 1).toFixed(3));
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }
  };

  /* ==========================================================================
   * 20. Boot
   * ======================================================================== */

  /* =========================================================================
   * Clock stamp — time, date and current weather, top-right over the photos.
   *
   * Replaces the old "Atinge ecranul ca sa suni" bar. Design constraints:
   *   - never a tap target (CSS pointer-events:none) — the whole idle screen
   *     stays one big call button;
   *   - the clock is device-local and must keep working with the network down.
   *     Weather is the only networked part and it fails invisibly: no icon, no
   *     temperature, no error, no gap;
   *   - repaint once a minute, not once a second. Nothing on this screen shows
   *     seconds, and this panel is on 24/7.
   * ====================================================================== */
  var Stamp = {
    tickTimer: 0,

    /* WMO weather codes (open-meteo) -> sprite id. Grouped the way a person
     * looking out of a window would group them, not the way the spec does. */
    icon: function (code, isDay) {
      if (code === 0) return isDay ? 'wx-clear' : 'wx-night';
      if (code === 1 || code === 2) return isDay ? 'wx-partly' : 'wx-night';
      if (code === 3) return 'wx-cloud';
      if (code === 45 || code === 48) return 'wx-fog';
      if (code >= 95) return 'wx-storm';
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'wx-snow';
      if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'wx-rain';
      return 'wx-cloud';
    },

    paintClock: function () {
      var now = new Date();
      var h = now.getHours(), m = now.getMinutes();
      var timeEl = document.getElementById('stamp-time');
      var dateEl = document.getElementById('stamp-date');
      if (timeEl) timeEl.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
      if (dateEl) {
        var txt = '';
        try {
          /* "9 aug." — Romanian, no weekday: the weekday adds a diacritic and
           * a third of the width for information nobody reads off a frame. */
          txt = now.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
        } catch (e) {
          txt = now.getDate() + '.' + (now.getMonth() + 1);
        }
        dateEl.textContent = txt;
      }
    },

    /* Re-arm exactly on the next minute boundary so the displayed minute is
     * never late, without a once-a-second timer. */
    scheduleTick: function () {
      var self = this;
      clearTimeout(this.tickTimer);
      var delay = 60000 - (Date.now() % 60000) + 250;
      this.tickTimer = setTimeout(function () {
        self.paintClock();
        self.scheduleTick();
      }, delay);
    },

    paintWeather: function (w) {
      var iconEl = document.getElementById('stamp-icon');
      var useEl = document.getElementById('stamp-icon-use');
      var tempEl = document.getElementById('stamp-temp');
      if (!iconEl || !tempEl || !useEl) return;
      /* NOTE: attributes, not the .hidden property. `hidden` is an HTMLElement
       * IDL attribute and this element is an SVGElement, so `el.hidden = false`
       * only sets a JS expando and leaves hidden="" in the DOM \u2014 the icon then
       * stays invisible via the .stamp-icon[hidden] rule, with a gap where it
       * should be. */
      if (!w || typeof w.tempC !== 'number') {
        iconEl.setAttribute('hidden', '');
        tempEl.textContent = '';
        return;
      }
      useEl.setAttribute('href', '#' + this.icon(w.code, w.isDay !== false));
      iconEl.removeAttribute('hidden');
      tempEl.textContent = w.tempC + '\u00B0';
    },

    refreshWeather: function () {
      var self = this;
      var url = '/api/weather';
      if (Store.deviceId && Store.authToken) {
        url += '?device=' + encodeURIComponent(Store.deviceId) +
               '&token=' + encodeURIComponent(Store.authToken);
      }
      /* Deliberately no .catch that shows anything: a weather outage is not an
       * event in a grandparent's living room. */
      safe(fetchJSON(url, 8000).then(function (doc) {
        self.paintWeather(doc && doc.weather);
      }).catch(function () { /* keep the last reading on screen */ }));
    },

    init: function () {
      this.paintClock();
      this.scheduleTick();
      this.refreshWeather();
      Persistent.every('weather-refresh', 15 * 60 * 1000, function () {
        Stamp.refreshWeather();
      });
      /* A tablet that was asleep or had its clock corrected by NTP must not
       * show a stale minute when it comes back. */
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          Stamp.paintClock();
          Stamp.scheduleTick();
        }
      });
    }
  };

  function boot() {
    Metrics.compute();
    window.addEventListener('resize', function () { Metrics.compute(); });
    window.addEventListener('orientationchange', function () { Metrics.compute(); });

    Store.init();
    Slideshow.init();
    Stamp.init();
    PhotoCache.register();
    wireControls();
    wireSignalling();
    Harness.init();

    /* Nothing on screen may ever be an error, so swallow everything loudly
     * into the console and quietly into the self-healing fault screen. */
    window.addEventListener('error', function (e) {
      log('window error', e && e.message);
      if (!Slideshow.shownOnce && !Store.photos.length) Fault.show();
    });
    window.addEventListener('unhandledrejection', function (e) {
      log('unhandled rejection', e && e.reason);
    });

    /* Cache first: paint whatever we already have before touching the network. */
    State.go('idle');

    /* Then refresh quietly, forever. The contact list is not fetched here:
     * it arrives in the signalling `registered` frame. */
    Store.refreshPhotos();
    Persistent.every('manifest-refresh', CFG.manifestRefreshMs, function () {
      Store.refreshPhotos();
    });

    /* STUN/TURN. Primed from the last known good list, then refreshed from the
     * server; without this the frame offers host candidates only and a phone on
     * mobile data can never reach it. */
    Ice.init();
    /* FORCE on boot. The cached list is primed from localStorage above so the
     * frame is never without one, but that cache is valid for the credential's
     * full 12 h TTL — which also pins the SERVER'S CHOICE of ICE servers for
     * 12 h. When the server started handing frames a public TURN URL as well
     * as the tailnet one, every frame kept using the stale tailnet-only list
     * and calls from a phone off the tailnet still failed. A single extra
     * request per page load buys correctness the moment a frame reloads. */
    Ice.refresh(true);
    Persistent.every('ice-refresh', 30 * 60 * 1000, function () { Ice.refresh(false); });

    Signal.connect();
    Wake.request();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      Wake.request();
      Signal.connect();
      if (State.current === 'idle') { Slideshow.stop(); Slideshow.start(); }
    });

    /* Optional: a URL like https://…/?from=family-ana&call=<id> opens the page
     * already ringing; the WebSocket offer catches up. Nothing in this repo
     * uses it - normal ringing arrives as `incoming-call` on the WebSocket. */
    var ringFrom = Q.get('from') || Q.get('ring');
    if (ringFrom) {
      var peer = Store.contactById(ringFrom) ||
                 { id: ringFrom, name: Q.get('name') || ringFrom, photo: avatarFor(Q.get('name') || ringFrom) };
      /* No locally invented call id: the server owns it. If the kiosk URL did
        * not carry one, the `incoming-call` frame supplies it moments later. */
      Call.prepareIncoming(peer, Q.get('call') || null);
      State.go('ring', { peer: peer, armMs: CFG.ringArmMs });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Expose a tiny surface for the harness and for manual poking in devtools. */
  window.Rama = { State: State, Store: Store, Call: Call, Signal: Signal,
                  Slideshow: Slideshow, Metrics: Metrics, CFG: CFG };
})();
