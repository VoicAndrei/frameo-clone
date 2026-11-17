/* =============================================================================
 * Rama familiei — admin service worker
 * =============================================================================
 * Scope: /admin/ only. It exists for exactly two reasons:
 *
 *   1. Installability. Android Chrome only offers "Add to home screen" for a
 *      page with a manifest AND a service worker that handles fetch.
 *   2. A usable shell on a bad connection: the HTML/CSS/JS load from cache and
 *      the app then explains, in Romanian, that the server is unreachable.
 *
 * What it deliberately does NOT do:
 *
 *   - It never touches /api/*. Photos, sessions and uploads must always be the
 *     live truth; a stale gallery or a cached 401 would be worse than a spinner.
 *   - It never caches a navigation response. The server redirects an
 *     unauthenticated /admin/ to /login, and caching that redirect would lock
 *     the parents out of their own app.
 *   - It never caches anything outside /admin/, so the tablet's own service
 *     worker at the root scope keeps owning its files.
 * ========================================================================== */

'use strict';

var VERSION = 'admin-v2';   /* bumped: per-socket call routing + ICE restart hardening */
var SHELL = 'rama-admin-shell-' + VERSION;

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      // One missing file must not abort the whole install.
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
        if (name.indexOf('rama-admin-') !== 0 || name === SHELL) return null;
        return caches.delete(name);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function inScope(url) {
  return url.origin === self.location.origin &&
         url.pathname.indexOf('/admin/') === 0;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Anything that is not an /admin/ asset — including every /api/ call and the
  // WebSocket upgrade — goes straight to the network, untouched.
  if (!inScope(url)) return;

  // Navigations: network first, cached shell only as a last resort. This keeps
  // the login redirect working while still opening offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html', { cacheName: SHELL }).then(function (hit) {
          return hit || caches.match('./');
        }).then(function (hit) {
          return hit || new Response(
            '<!doctype html><meta charset="utf-8"><title>Rama</title>' +
            '<p>Nu am internet acum. Incearca din nou peste putin timp.</p>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  /* Static assets: NETWORK FIRST, cache as the fallback.
   *
   * Cache-first would be faster by a few milliseconds and would be the wrong
   * trade: this app is redeployed from a laptop at night, the whole shell is
   * well under 100 KB, and a parent opening a stale app.js against a newer
   * server is a bug report nobody can debug over the phone. Freshness wins;
   * the cache exists so the app still opens with no signal. */
  event.respondWith(
    caches.open(SHELL).then(function (cache) {
      return fetch(request).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
      }).catch(function () {
        return cache.match(request).then(function (hit) {
          return hit || new Response('', { status: 504, statusText: 'offline' });
        });
      });
    })
  );
});
