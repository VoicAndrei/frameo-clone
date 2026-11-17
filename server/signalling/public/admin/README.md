# `/admin/` — the phone app

The app family members open on their phones, from anywhere on the public internet, to manage the
photos on the grandparents' frames and to start a video call. It is also the only upload path:
family photos go in through this app (`POST /api/admin/photos`), not through Immich share links.
The examples below use the placeholder accounts `ana`, `ion` and `maria`.

It is served by the same Node process as everything else (`signalling/server.js`, `PUBLIC_DIR`),
at **`https://your-machine.your-tailnet.ts.net/admin/`**. There is no build step, no bundler,
no dependency and no CDN: four files plus icons, served as-is.

| File | What it is |
|---|---|
| `index.html` | The whole DOM. No inline `<script>`, no inline `<style>`, no `onclick=` — the CSP in ARCHITECTURE-PUBLIC.md §2.9 forbids all three. |
| `app.js` | Everything: auth, gallery, upload queue, delete, signalling, WebRTC. One IIFE, no modules. |
| `style.css` | One dark theme. No light variant on purpose — one look, tested once, in every room. |
| `sw.js` | Service worker, scope `/admin/`. Exists for PWA installability and an offline shell. Never touches `/api/*`. |
| `manifest.webmanifest` | PWA manifest. `display: standalone`, `scope: /admin/`. |
| `icon.svg`, `icon-180.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons. `icon-180.png` is the iOS `apple-touch-icon`. |

### Languages: English and Romanian

The app speaks **English** or **Romanian**. The language is decided once, at startup:

1. `?lang=en` or `?lang=ro` in the URL wins, and is saved to `localStorage` (`admin.lang`);
2. otherwise the saved `admin.lang`;
3. otherwise `navigator.language` — anything starting with `ro` gets Romanian, everything else
   English.

`<html lang>` is set to match. The account sheet (avatar, top right) has a small link naming the
other language (`English` / `Romana`); it saves the choice, drops any `?lang=` from the address and
reloads. The login screen has no language control on purpose.

* **One dictionary**, `STRINGS = { en: {...}, ro: {...} }` near the top of `app.js`, with the same
  keys in both. `t(key, vars)` fills `{name}` placeholders; `tn(key, n, vars)` picks a plural form
  (English `one`/`other`; Romanian `one`/`few`/`many` — *1 poza / 12 poze / 20 de poze*). A
  missing key falls back to English, then to the key itself. Every visible string, aria-label,
  placeholder, toast, banner and error goes through it.
* **`index.html`** keeps its Romanian text as the no-JS fallback and marks each string with
  `data-i18n` (text), `data-i18n-aria`, `data-i18n-placeholder`, `data-i18n-title` or
  `data-i18n-content` (meta tags). `applyI18n()` runs first thing in `App.boot()`, while the boot
  splash still covers the page. Dictionary strings may contain `<strong>…</strong>` and nothing
  else; they are built as DOM nodes, never through `innerHTML`.
* **Album names** come from the dictionary by key (`album.a.name`, `album.a.tab`, …): English
  *Frame A / Frame B / Both frames* (tabs *All · Frame A · Frame B · Both*), Romanian
  *Bunicii A / Bunicii B / Ambele rame* (tabs *Toate · Bunicii A · Bunicii B · Ambele*). The
  server's album `name` is used only when it sends `customName: true` for that album.
* **Frame names on the call screen** (`Bunicii A`, …) come from the server roster as they are; the
  app does not translate them.
* Dates use the dictionary's short month names (`3 Nov 2026` / `3 noi 2026`), not `Intl`, so the
  Romanian form stays exactly what it was.

The Romanian copy is written without diacritics — the frames' font stack and the parents'
keyboards both handle plain ASCII more predictably, and "Sterge" is not less clear than "Șterge".
Keep new Romanian strings in that style.

---

## 1. Screens

### 1.1 Login

The only screen visible without a session. Nothing else is on it.

* **"Cine esti?"** — one big chip per account (`Ana`, `Ion`, `Maria`), plus `Altcineva` which
  reveals a free-text username field. The chip list comes from `GET /api/auth/session` if that
  endpoint returns an `accounts` array; otherwise it falls back to the `DEFAULT_ACCOUNTS` list in
  `app.js` (the three placeholder names; edit it for your family, or rely on the server list).
  The last used name is remembered in `localStorage` under `rama.user` and pre-selected, so the
  parents only ever type a password.
* **Parola** — one field, 60px tall, with an `Arata` / `Ascunde` toggle because typing a
  passphrase blind on a phone is where people give up. `autocomplete="current-password"` so the
  password manager offers to fill it.
* **Errors** are a red block above the button, never an `alert()`, never a status code:
  * wrong password or unknown user → *"Parola nu e buna. Mai incearca o data."* (the server
    deliberately returns the same 401 for both — see §2.6 of the architecture doc);
  * HTTP 429 → *"Prea multe incercari. Mai incearca peste N minute."*, N from `Retry-After`;
  * no network → *"Nu am internet spre server. Verifica conexiunea telefonului."*
* The password field is cleared on every failure.
* **The session is remembered for 90 days** by the server's `frameo_sid` cookie. Nobody is asked
  for a password on a schedule.

### 1.2 Galerie (tab "Poze")

* A **segmented filter**: `Toate` · `Bunicii A` · `Bunicii B` · `Ambele`. The first shows
  everything; the other three are the three Immich albums. If the server has no album-aware photo
  endpoint yet, the filter hides itself and a one-line note explains that all photos are shown
  together — the screen still works.
* A **square grid**, newest first, `auto-fill` at 104px minimum, so it is 3 columns on an iPhone
  SE and 5 on a Pixel Pro. Thumbnails are `loading="lazy"` and fade in.
* **Infinite scroll**: an `IntersectionObserver` 700px below the fold pulls the next page of 60.
* **Per photo**: a corner badge saying which frames show it — `A`, `B`, or `A+B`. The letters come
  from the album→frame mapping, not from guessing at the album name.
* **Tap** opens the photo full screen. In the viewer: swipe left/right for the next photo, swipe
  down or tap ✕ to close, the date and *"Se vede pe: …"* at the top, and a delete button.
  Reaching the last loaded photo quietly fetches the next page, so swiping never dead-ends.
* **Long-press** (480ms) or the `Selecteaza` button enters multi-select. Checkboxes appear, the
  count shows in a floating bar, and `Sterge` opens the confirm sheet.
* `Actualizeaza` throws the client cache away and re-reads page 1.

### 1.3 Incarca (tab "Incarca")

Two numbered steps, because "which frame does this go to" must be answered *before* the file
picker opens — a phone photo picker is a full-screen modal and anything behind it is forgotten.

1. **"Unde sa apara pozele?"** — the album picker. The choice is remembered in `localStorage`
   (`rama.album`), defaulting to `Ambele rame`.
2. **"Alege pozele"** — a 148px dashed target wrapping
   `<input type="file" accept="image/*,.heic,.heif" multiple>`. On iOS this opens the Photos
   picker with multi-select; on Android, the gallery.

Then:

* Every file becomes a row with a thumbnail, its name and a progress bar. Previews are only made
  for the first 60 files under 16MB, and the object URL is revoked as soon as the image loads —
  200 live object URLs is how a phone browser tab gets killed.
* **Three uploads run at a time** (`UPLOAD_CONCURRENCY`). One failure never stops the queue.
  Uploading 200 photos works; adding 200 rows to the DOM measures ~10ms.
* Uploads use `XMLHttpRequest`, not `fetch`, because `fetch` has no upload progress event.
* **The queue survives screen changes.** A strip under the top bar shows overall progress on every
  screen, and the "Incarca" tab shows a badge with how many are left. Closing the tab while an
  upload is running triggers the browser's "are you sure" prompt.
* **HEIC**: iPhone photos are handed to the server untouched. iOS usually converts to JPEG when a
  photo is picked through `accept="image/*"`; when it does not, Immich handles HEIC server-side.
  Nothing is transcoded in the browser.
* Files that are not images, or over 80MB, are marked failed immediately without being sent.
* **At the end**: *"Gata! 30 de poze au ajuns pe rama."* or *"27 au ajuns. 3 nu au mers."*, with
  `Mai incearca pozele nereusite` — which only appears when a failure is actually retryable
  (a wrong format or an oversized file is not).
* On success the gallery is refreshed in the background.

### 1.4 Stergere

Reached from multi-select or from the viewer. It is a bottom sheet that names the count
("Ce fac cu 12 poze?") and offers two genuinely different things:

* **`Scoate de pe "Bunicii A"`** — removes the photo from that album. *"Poza ramane in arhiva, dar
  nu se mai vede pe rama."* Offered only when a single target album is unambiguous: either the
  gallery is filtered to one album, or every selected photo belongs to exactly one, and the same
  one.
* **`Sterge definitiv`** — *"Dispare de pe toate ramele si din arhiva."* This one asks a second
  time, with a separate sheet and a `Da, sterge definitiv` button. Two taps, two different words.

Deletes run three at a time with a live toast, tiles dim while in flight, and the result is
honest: *"12 poze sterse."*, *"9 sterse, 3 nu au mers."*, or *"Nu am putut sterge nimic."*

### 1.5 Apel video (tab "Apel video")

* One card per frame, from the WebSocket `registered` message's `contacts` list — filtered to
  `kind === "frame"`. The roster is the authority; this screen never invents a contact.
* Status is a coloured dot plus words: **"Pornita, gata de apel"** (green), **"Vorbeste acum"**
  (amber), **"Nu e pornita"** (grey, button disabled, with the reason spelled out underneath).
  `presence` messages update it live; a dropped socket marks everything offline.
* **`Suna Bunicii A`** is a 62px button. Tapping it:
  1. opens the full-screen call UI with a pulsing "Suna la rama…" and a `Renunta` button,
  2. asks for camera + microphone and fetches ICE servers **in parallel**, so the permission
     prompt appears while the frame is ringing,
  3. sends `call-request`; the **server** allocates the call id and returns it in `call-ringing`.
     The client never invents a call id — every later frame is validated against the server's.
* On `call-accepted` with `shouldCreateOffer`, it builds the `RTCPeerConnection`, adds the tracks,
  applies the bitrate cap, and sends the offer. ICE candidates that arrive before the remote
  description are queued and flushed afterwards.
* **Incoming calls are handled too.** A grandparent pressing the big green button on the frame
  rings the phone with `Raspunde` / `Refuza` and a vibration. If a call is already up, the new one
  is declined automatically with `busy-here`.
* **Call controls**: mute microphone, camera on/off, flip front/back camera (via `replaceTrack`,
  no renegotiation), and a red `Inchide`. Buttons whose device is missing are disabled rather than
  dead. A call timer runs in the header.
* **"Conexiune prin server"** appears when `getStats()` reports the selected candidate pair is a
  relay. That badge is the first thing to ask about when someone says the call was bad.
* The screen is kept awake with `navigator.wakeLock` where available.
* If the phone refuses camera *and* microphone, the call still goes ahead one-way and the user is
  told exactly that, once.

### 1.6 Things present on every screen

* **The connection banner**, under the top bar: *"Nu ai internet. Astept sa revina."* /
  *"Ma reconectez la server..."* / *"Ma conectez pentru apeluri..."*. It never covers the account
  button, because covering the way out of a stuck session is how support calls start.
* **The account sheet** (avatar, top right): `Iesi din cont`, `Iesi de pe toate telefoanele`
  (the lost-phone button, `POST /api/auth/logout-all`), `Inapoi`.
* **Toasts** for anything transient. No `alert()`, no `confirm()`, no stack trace, ever. Every
  failure goes through `humanError()`, which turns a status code into one plain sentence in the app's language.

---

## 2. What the app expects from the server

The auth trio is required. Everything else degrades gracefully — a `404`/`405`/`501` on an admin
endpoint switches that feature to a read-only fallback or a plain "not available yet" message
instead of an error screen.

| Method & path | Request | Response the client reads |
|---|---|---|
| `GET /api/auth/session` | — | `{authenticated, username, displayName, peerId}`; optional `accounts:[{username,displayName}]` to populate the login chips. `{"authenticated":false}` when anonymous. |
| `POST /api/auth/login` | `{username, password}` | Same shape as `session` on success. `401 {"error":"invalid-credentials"}`. `429` + `Retry-After` when locked out. |
| `POST /api/auth/logout` | — | anything 2xx |
| `POST /api/auth/logout-all` | — | anything 2xx |
| `GET /api/admin/albums` | — | `{albums:[{key,id,name,customName,count}]}`. `name` is shown only when `customName === true`; otherwise the label comes from the app's dictionary. Keys are **`a`, `b`, `all`** — the server's own vocabulary. `frames` is not sent; the client re-attaches it by key for the A/B tile badge. |
| `GET /api/admin/photos?album=&page=&pageSize=` | `album` is `a`\|`b`\|`all`\|`both`\|`any`\|`""`; `page` is 1-based. **`any` means "every album"** — `all` is the key of the *Toti* album and filters to just that one. | `{photos:[{id,filename,date,favorite,albums:[key],thumbnailUrl,previewUrl}], page, pageCount, total, albums}` |
| `POST /api/admin/photos` | `multipart/form-data`: `album=<key>`, `fileCreatedAt`, then one or more file parts (any field name) | `{ok, uploaded, failed, results:[{filename, ok, assetId, duplicate}]}`. `duplicate:true` shows as "Deja acolo". |
| `POST /api/admin/photos/delete` | `{ids:[…], mode:"album"\|"library", album?}` — the bulk form the client uses | `{ok, mode, removed\|deleted}` |
| `DELETE /api/admin/photos` | same JSON body | same |
| `DELETE /api/admin/photos/:id?mode=&album=` | single photo, options in the query string | same |
| `GET /api/turn-credentials` | — | `{iceServers:[…], ttl, expiresAt}` — handed straight to `RTCPeerConnection` |
| `GET /api/photos?limit=` | — | the tablets' existing manifest; used **only** as the gallery fallback. Album-scoped per frame via `FRAME_ALBUM_MAP`. |
| `GET /api/photo/:id` | — | image bytes |
| `WS /ws` | `register`, `call-request`, `call-accept`, `call-decline`, `call-cancel`, `offer`, `answer`, `ice-candidate`, `hangup`, `heartbeat` | `registered`, `presence`, `incoming-call`, `call-ringing`, `call-accepted`, `call-declined`, `call-cancelled`, `call-ended`, `call-failed`, `hangup`, `heartbeat-ack`, `error` |

Rules the client follows, from ARCHITECTURE-PUBLIC.md:

* Every non-`GET` request carries `X-Frameo-CSRF`, read from the `frameo_csrf` cookie
  (double-submit, §2.8). Uploads are `multipart/form-data` and carry it as a **header**, never as
  a form field.
* All requests use `credentials: 'same-origin'` and `cache: 'no-store'`.
* The WebSocket URL is exactly `wss://<host>/ws` with **no query string** — the session cookie
  validated at the HTTP upgrade is the credential, and `register` carries only `{type, id}` where
  `id` is the account's `peerId`. Tailscale Funnel is known to strip query parameters from
  upgrade requests (§1.8); nothing here depends on them.
* A `401`, or an HTML body where JSON was expected (i.e. a redirect to `/login`), drops the
  session, closes the socket, ends any call and returns to the login screen with
  *"Sesiunea a expirat. Intra din nou cu parola."*
* ICE servers are **always fetched**, never hardcoded, and refreshed when less than 30 minutes of
  validity remain.
* `iceTransportPolicy` is `"all"`, never `"relay"`.
* The video sender is capped at 600 kbps / 24 fps with `degradationPreference:
  "maintain-framerate"` and captures at 640×480 (§3.6). This is mandatory, not tuning: the phone
  is the side that will be relaying over TCP.

### How the server routes `/admin`

1. **`/admin` redirects to `/admin/`.** `serveStatic()` redirects an existing directory to its
   trailing-slash form; without that, the bare path would hit the SPA fallback and return the
   *tablet* app. A logged-in admin who opens `/` is also redirected to `/admin/`.
2. **`/admin/*` static files are gated** like everything else that is not in
   `PUBLIC_ASSET_PATHS`: an anonymous browser is redirected to `/login`. The shell holds no data
   either way (every photo, session and roster byte is behind an authenticated `/api/*` call), and
   the app also copes with a shell served publicly: it detects an HTML response where JSON was
   expected and shows its own login screen.

---

## 3. PWA and caching

* `manifest.webmanifest` + `sw.js` make the app installable. On iOS, Share → "Adauga pe ecranul
  principal" gives a standalone app with the amber icon; on Android, Chrome offers the install
  prompt.
* **The manifest is in English only** (`name` and `short_name` "Family frame"). A static manifest
  cannot follow each phone's language without the server generating it per user, so Android shows
  "Family frame" under the icon whatever the app's language. On iOS the home-screen name comes from
  the `apple-mobile-web-app-title` meta tag, which `applyI18n()` sets at runtime (`Family frame` /
  `Rama`), so it follows the app's language at the moment the icon is added.
* After changing any shell file, bump `VERSION` in `sw.js` (now `admin-v3`) so installed phones
  replace their cached copy.
* The service worker scope is `/admin/`, which is narrower than the tablet's root-scoped
  `sw.js`, so it wins for these pages and the tablet's cache is left alone.
* **Static assets are network-first, cache-fallback.** Cache-first would be a few milliseconds
  faster and would be wrong: this app can be redeployed at any time, the whole shell is
  under 100KB, and a parent running a stale `app.js` against a newer server is a bug nobody can
  debug over the phone. The cache exists so the app opens with no signal, not to save bandwidth.
* **`/api/*` is never cached.** Not the photo list, not the session, not a `401`.
* Navigations are network-first so the login redirect is never cached.

---

## 4. Accessibility and touch

* Minimum touch target 46px; primary actions 52–62px.
* Body text 17px, never below 16px — under 16px iOS zooms the page on input focus.
* Contrast: body text 14:1 on the background, amber buttons 8:1 with near-black text.
* `role="radiogroup"` / `role="tablist"` on the segmented controls, `aria-selected` /
  `aria-checked` / `aria-current` maintained in JS, `role="alert"` on the login error,
  `aria-live="polite"` on the toast and the connection banner.
* Keyboard: Escape closes the viewer, arrows move between photos. `:focus-visible` outlines.
* `prefers-reduced-motion` disables every animation.
* Safe-area insets on the top bar, tab bar, sheets, the viewer and the call controls, so nothing
  hides under a notch or a home indicator.

---

## 5. Local development

There is no build step — edit the files and reload. To run against a fake server, serve
`signalling/public/` on `http://localhost:8080` and implement the table in §2; set
`EXTRA_ALLOWED_ORIGINS=http://localhost:8080` so the WebSocket upgrade's `Origin` check passes.

Remember to unregister the service worker (DevTools → Application → Service Workers) when
switching between servers on the same port; it is scoped to `/admin/` and will otherwise serve
the previous app shell if the network is unreachable.
