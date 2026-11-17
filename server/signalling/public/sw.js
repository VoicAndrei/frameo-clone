/* =============================================================================
 * Rama — service worker
 * =============================================================================
 * One job above all others: a server, network or laptop outage must be
 * COMPLETELY INVISIBLE while the frame is idle. That means:
 *
 *   app shell   -> cache first, revalidated in the background
 *   photos      -> cache first, capped at PHOTO_LIMIT entries (~300 newest)
 *   manifests   -> network first with a short timeout, cache as the fallback
 *
 * Nothing here ever rejects into the page: every path ends in a Response or a
 * harmless empty one, so the UI never sees a failure it would have to explain.
 * ========================================================================== */

'use strict';

var VERSION      = 'v7';   /* bumped: clock-stamp scrim box removed, NU ACUM label
                              no longer overflows its button (style.css).
                              MUST match the ?v= on the asset URLs in
                              index.html — see the comment on its <link>. */
var SHELL_CACHE  = 'rama-shell-' + VERSION;
var DATA_CACHE   = 'rama-data-'  + VERSION;
var PHOTO_CACHE  = 'rama-photos';        /* deliberately un-versioned: never
                                            throw away 300 warmed photos just
                                            because the HTML changed */
var PHOTO_LIMIT  = 300;
var NET_TIMEOUT  = 6000;

/* The query strings must match index.html EXACTLY: the Cache API keys entries by
   FULL url, so precaching a bare './style.css' would never satisfy the page's
   request for './style.css?v=7' and the frame would boot unstyled when offline.
   Derived from VERSION ('v7' -> '7') so there is one number to bump, not three. */
var ASSET_Q      = '?v=' + VERSION.replace(/^v/, '');

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.js' + ASSET_Q,
  './style.css' + ASSET_Q
];

/* --------------------------------------------------------------------------
 * Install / activate
 * ------------------------------------------------------------------------ */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      /* Add one by one: a single 404 must not abort the whole install. */
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name === SHELL_CACHE || name === DATA_CACHE || name === PHOTO_CACHE) return null;
        if (name.indexOf('rama-') !== 0) return null;      /* leave other apps alone */
        return caches.delete(name);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* --------------------------------------------------------------------------
 * Request classification
 * ------------------------------------------------------------------------ */

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPhoto(request, url) {
  if (!isSameOrigin(url)) return false;
  if (request.destination === 'image') return true;
  return /^\/(api\/photo\/|photos?\/|thumbs?\/|media\/)/.test(url.pathname);
}

function isManifest(url) {
  if (!isSameOrigin(url)) return false;
  return url.pathname.indexOf('/api/photos') === 0;
}

function isShell(request, url) {
  if (!isSameOrigin(url)) return false;
  if (request.mode === 'navigate') return true;
  return /\.(html|css|js|woff2?|svg|ico|webmanifest)$/.test(url.pathname) || url.pathname === '/';
}

/* --------------------------------------------------------------------------
 * Strategies
 * ------------------------------------------------------------------------ */

function fetchWithTimeout(request, ms) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('timeout')); }
    }, ms);
    fetch(request).then(function (res) {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(res);
    }, function (err) {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });
  });
}

/** Cache first; on a miss go to the network and store the result. */
function cacheFirst(cacheName, request, opts) {
  opts = opts || {};
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) {
        if (opts.revalidate) {
          /* Background refresh, failures ignored. */
          fetch(request).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
          }).catch(function () {});
        }
        return hit;
      }
      return fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(request, res.clone()).then(function () {
            if (opts.limit) trim(cacheName, opts.limit);
          }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return emptyResponse(request);
      });
    });
  });
}

/** Network first with a short timeout; the cache is the safety net. */
function networkFirst(cacheName, request) {
  return caches.open(cacheName).then(function (cache) {
    return fetchWithTimeout(request, NET_TIMEOUT).then(function (res) {
      if (res && res.ok) cache.put(request, res.clone()).catch(function () {});
      return res;
    }).catch(function () {
      return cache.match(request).then(function (hit) {
        return hit || emptyResponse(request);
      });
    });
  });
}

/** Never surface a network failure as a thrown error. */
function emptyResponse(request) {
  if (request.destination === 'image') {
    /* 1x1 transparent GIF: the slideshow treats it as a broken photo and
       silently skips to the next one. */
    var gif = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x01, 0x00,
      0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3B
    ]);
    return new Response(gif, { status: 200, headers: { 'Content-Type': 'image/gif' } });
  }
  return new Response('', { status: 504, statusText: 'offline' });
}

/** Keep only the newest `limit` entries. Cache.keys() preserves insertion order. */
function trim(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= limit) return;
      return Promise.all(keys.slice(0, keys.length - limit).map(function (k) {
        return cache.delete(k);
      }));
    });
  }).catch(function () {});
}

/* --------------------------------------------------------------------------
 * Fetch
 * ------------------------------------------------------------------------ */

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Never intercept the signalling socket or media. */
  if (url.pathname.indexOf('/ws') === 0) return;

  if (isPhoto(request, url)) {
    event.respondWith(cacheFirst(PHOTO_CACHE, request, { limit: PHOTO_LIMIT }));
    return;
  }

  if (isManifest(url)) {
    event.respondWith(networkFirst(DATA_CACHE, request));
    return;
  }

  if (isShell(request, url)) {
    event.respondWith(
      cacheFirst(SHELL_CACHE, request, { revalidate: true }).then(function (res) {
        if (res && res.status !== 504) return res;
        /* A navigation that missed the cache and the network: hand back the
           cached shell so the frame still boots into the slideshow. */
        if (request.mode === 'navigate') {
          return caches.open(SHELL_CACHE).then(function (c) {
            return c.match('./index.html').then(function (hit) { return hit || res; });
          });
        }
        return res;
      })
    );
  }
});

/* --------------------------------------------------------------------------
 * Messages from the page
 *   { type:'warm', urls:[…], limit:n }  pull the newest photos into the cache
 *   { type:'drop' }                     wipe the photo cache (debug harness)
 *   { type:'skipWaiting' }              activate a new worker immediately
 * ------------------------------------------------------------------------ */

self.addEventListener('message', function (event) {
  var data = event.data || {};

  if (data.type === 'skipWaiting') { self.skipWaiting(); return; }

  if (data.type === 'drop') {
    event.waitUntil(caches.delete(PHOTO_CACHE).catch(function () {}));
    return;
  }

  if (data.type === 'warm' && Array.isArray(data.urls)) {
    var limit = data.limit || PHOTO_LIMIT;
    event.waitUntil(warm(data.urls.slice(0, limit), limit));
  }
});

/**
 * Fetch every photo we do not already hold, four at a time so the tablet's
 * Wi-Fi is never saturated while a call might be starting.
 */
function warm(urls, limit) {
  return caches.open(PHOTO_CACHE).then(function (cache) {
    var queue = urls.slice();
    var workers = [];

    function nextOne() {
      if (!queue.length) return Promise.resolve();
      var url = queue.shift();
      var req = new Request(url, { credentials: 'same-origin' });
      return cache.match(req).then(function (hit) {
        if (hit) return null;
        return fetchWithTimeout(req, 15000).then(function (res) {
          if (res && res.ok) return cache.put(req, res.clone());
          return null;
        });
      }).catch(function () { return null; }).then(nextOne);
    }

    for (var i = 0; i < 4; i++) workers.push(nextOne());
    return Promise.all(workers).then(function () { return trim(PHOTO_CACHE, limit); });
  }).catch(function () {});
}
