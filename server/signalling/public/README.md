# Rama — tablet-facing web UI

The entire user experience of the frame. It runs full-screen in a locked-down
kiosk browser on an 11" Android tablet, in front of someone who has never used a
computer. There is no settings screen, no menu, no keyboard, and no way to get
lost.

Five files, no build step, no dependencies, no CDN:

| File | Purpose |
|---|---|
| `index.html` | App shell. Every state is a `<section class="screen">`; exactly one carries `.is-active`. Runtime config lives in one inline `<script>` block near the top. |
| `app.js` | State machine, input guard, slideshow, WebRTC, signalling client, debug harness. |
| `style.css` | All geometry in real millimetres via the `--mm` custom property. |
| `sw.js` | Service worker: app-shell cache + a ~300 photo cache. |
| `README.md` | This file. |

---

## 1. Millimetres, not pixels

Every touch target, gap and margin in the accessibility spec is a physical
measurement, so the CSS is written in physical measurements.

**The CSS `mm` unit cannot be used.** CSS pins `1mm` to exactly `96/25.4 =
3.7795px` no matter what panel it renders on, so it is a typographic fiction,
not a millimetre. `app.js` measures the real panel instead:

```
cssPxPerMm = hypot(screen.width, screen.height) / (screenDiagonalIn * 25.4)
```

`devicePixelRatio` cancels out of that ratio, so the same formula is correct on
a 1x, 1.75x or 2x density tablet. The result is written to `--mm` on
`:root`, and every dimension is `calc(var(--mm) * N)`.

### Reference device — 11", 1920x1200

```
diagonal      = hypot(1920, 1200) = 2264.2 px  over  11" = 279.4 mm
--mm          = 8.104 px per mm
```

| Spec requirement | mm | px | Verified |
|---|---|---|---|
| Clear of every screen edge | 10 | 81 | 10.0 mm on all four edges |
| Minimum touch target | 20 | 162 | smallest control is 30 mm |
| Answer ↔ Decline dead zone | 27 | 219 | 27.00 mm |
| Button border | 1.5 | 12 | 1.5 mm |
| **RASPUNDE** | 120 x 44 | 972 x 357 | area 5280 mm² |
| **NU ACUM** | 55 x 40 | 446 x 324 | area 2200 mm² |
| Answer : Decline **area** ratio | 2.40 | — | **2.4000** |
| Grid tile | 103.5 x 42 | 839 x 340 | 4 tiles, 10 mm gutters |
| "Inapoi la poze" bar | 216.9 x 26 | 1758 x 211 | full width inside the margin |
| **INCHIDE** | 62 x 30 | 502 x 243 | bottom-right, 10 mm clear |
| Self-view PiP | 46 x 34 | 373 x 276 | bottom-left, `pointer-events: none` |

The fallback `--mm: 8.104px` in `style.css` equals the reference device, so the
first paint is already correct before JS runs.

### Smaller panels

`Metrics.fitControls()` scales **both dimensions of both** ring buttons by one
factor, which leaves the 2.40 area ratio mathematically exact. The 27 mm dead
zone and the 10 mm margins never scale. The factor is clamped at 0.5, below
which Decline's short side would break the 20 mm minimum — so the design floor
is about 135 mm of usable width (a ~6" panel). On the reference tablet the
factor is 1 and the buttons are exactly the specified size.

---

## 2. States

```
idle ──tap anywhere──► call-grid ──tap tile──► dialing ──accepted──► in-call ──► post-call ──► idle
  ▲                        │                     │                     │
  │                        └─"Inapoi la poze"────┘                     │
  │                                               └──declined──► unavailable ──► idle
  │
  ├──call-request──► incoming-ring ──"RASPUNDE"──► in-call
  │                       │
  │                       ├──"NU ACUM"──► decline-undo (5 s) ──"RASPUNDE"──► in-call
  │                       │                        └──timeout──► missed (60 s) ──► idle
  │                       └──45 s──────────────────────────────► missed (60 s) ──► idle
  │
  └──no photos at all / crash──► fault  (self-healing, retries every 15 s)
```

| State | What is on screen | Leaves when |
|---|---|---|
| **idle** | Full-screen photo, `object-fit: contain` over a blurred+dimmed `cover` copy of the *same* photo so faces are never cropped. 25 s dwell, 1.5 s crossfade, no Ken Burns. Only chrome: the permanent bottom bar `Atinge ecranul ca sa suni`. | tap anywhere → call-grid |
| **call-grid** | Up to 2x2 face tiles, each with its name on its own solid band (never over the face), plus a full-width grey `Inapoi la poze` bar. No dialer, no keyboard, no text input. | tap tile → dialing · back bar → idle · **30 s no touch → idle** |
| **dialing** | Their photo + `Suna pe <Nume>...`. A 3 s `Opreste` undo with a shrinking progress line — *not* a confirm dialog. After 3 s the same button becomes `INCHIDE` so the call can always be ended in one tap. | accepted → in-call · declined / 45 s → unavailable |
| **incoming-ring** | Their photo, `<Nume> te suna` on a solid band, `RASPUNDE` (green `#1B5E20`) and `NU ACUM` (`#8C1D18`). Both **inert for 800 ms**; the row fades in over that period so an early tap has a visible reason for doing nothing. Warm two-tone bell ramping 55%→100% over 6 s. | answer → in-call · decline → decline-undo · **45 s → missed** |
| **decline-undo** | Full-screen, 5 s. Deliberately nothing new to read: the same band plus the same green `RASPUNDE`. An accidental decline costs exactly one tap. | answer → in-call · 5 s → missed |
| **in-call** | Remote video full-screen (`cover`), self-view PiP bottom-left (**not tappable**), and exactly **one** control: `INCHIDE` bottom-right, permanently visible. No mute, no camera flip, no chat. `Se reconecteaza...` appears on a solid band only after 2 s of ICE trouble. | INCHIDE / remote hangup → post-call · 25 s of failed ICE → post-call |
| **post-call** | `Convorbirea s-a incheiat.` | 6 s or one tap → idle |
| **missed** | Their photo + `<Nume> a sunat` | 60 s → idle · tap → call-grid |
| **unavailable** | Their photo + `<Nume> nu poate raspunde acum.` | 8 s → idle · tap → call-grid |
| **fault** | Two calm lines on a dark card: `Rama se repara singura.` / `Nu trebuie sa faci nimic.` ("The frame is fixing itself." / "You don't need to do anything."). No error text, no button, no number, no code. | heals itself the moment photos are available again |

### Audio-only fallback

If the remote video track is absent, muted, ended, or the watchdog sees video
frames stall or bandwidth collapse (`< 1 fps` or `< 40 kbps` for two
consecutive 2 s samples), the UI swaps to the person's **stored photo**
full-screen with a gentle audio-level ring driven by a WebAudio analyser.

- It is **never announced** — no text, no icon, no sound.
- It **never shows black**: the photo is on screen from the first frame of the
  call, and video only replaces it once `<video>` reports real pixels
  (`videoWidth > 0`).
- It recovers on its own with hysteresis (two good samples at `≥ 4 fps` and
  `≥ 120 kbps`), and a 6 s grace period at call start stops it flapping.

### Every string that can appear

The full vocabulary of the UI, plus contact names substituted for `<Nume>`:

```
Atinge ecranul ca sa suni      <Nume> te suna              RASPUNDE
NU ACUM                        <Nume> a sunat              INCHIDE
Inapoi la poze                 Opreste                     Suna pe <Nume>...
<Nume> nu poate raspunde acum.  Se reconecteaza...         Convorbirea s-a incheiat.
Rama se repara singura.        Nu trebuie sa faci nimic.
```

English (`?lang=en`, see §7 *Language*):

```
<Name> is calling              ANSWER                      NOT NOW
<Name> called                  HANG UP                     Back to photos
Stop                           Calling <Name>...           <Name> can't answer right now.
Connecting again...            The call has ended.         The frame is fixing itself.
You don't need to do anything.
```

Both sets live in one dictionary, `STRINGS` at the top of `app.js`, with
identical keys; every visible string goes through `t(key, { name })`.

The words *eroare, conexiune, server, retea* (in English: *error, connection,
server, network*), any error code and any stack
trace are never rendered under any circumstance. Network and server failures
are swallowed into the console (debug builds only) and, at worst, into the
self-healing fault screen. There is an automated audit for this — see §5.

---

## 3. Input rules

Single tap only. No swipe, double-tap, long-press, drag, pinch or scroll
anywhere in the app. `touch-action: none`, `overscroll-behavior: none` and
capture-phase `preventDefault` on `touchmove` / `wheel` / `contextmenu` /
`dblclick` / `gesture*` remove them at the browser level.

`bindTap()` in `app.js` is the only way any control becomes interactive:

| Rule | Behaviour |
|---|---|
| **Activate on pointerup** | The pointer is captured on `pointerdown`, so we always see the release. Activation requires the release point to be **inside the target rect** — a badly-landed finger can slide off to abort. |
| **Multi-touch** | Two or more simultaneous pointers poison the whole gesture. The screen stays poisoned until every finger lifts, plus 300 ms. |
| **Fat contact** | `max(event.width, event.height) / 2 / pxPerMm > 15 mm` is ignored — palm, cheek, sleeve. |
| **Long hold** | Held longer than 2500 ms does not activate. |
| **Post-activation lockout** | After any successful activation, **all** input is ignored for 1500 ms. |
| **State-change arming** | Every transition arms a 600 ms lockout (800 ms on incoming-ring), so a tap aimed at the previous screen can never hit the new one. |

Buttons are `icon + text + 1.5 mm border`, so colour is never the sole
differentiator. All surfaces are dark (`#111`), never white, and every text
contrast is ≥ 7:1 (measured: 7.87 on the green Answer button, 9.11 on the red
buttons, 14–19 elsewhere).

---

## 4. Photo cache — the frame must survive the server dying

This is the single highest-value reliability decision in the project, so it is
worth being precise about.

- `sw.js` keeps a versioned shell cache `rama-shell-<VERSION>` (HTML/CSS/JS,
  **cache-first** with a background revalidate), a versioned `rama-data-<VERSION>`
  cache, and `rama-photos` (**cache-first**, capped at 300 entries, trimmed
  oldest-first).
- `rama-photos` is deliberately **un-versioned**: shipping new HTML must never
  throw away 300 warmed photos.
- The manifest (`/api/photos`) is **network-first with a 6 s timeout** and
  the cache as the safety net.
- The page renders from `localStorage` on boot **before touching the network**,
  then refreshes quietly every 10 minutes.
- On a first visit the worker does not control the page yet, so the "warm the
  cache" message is posted to `navigator.serviceWorker.ready`'s *active* worker
  (queued if necessary) rather than to `.controller`, which would be `null`.
  It also re-primes on `controllerchange`.
- A failed photo fetch returns a 1x1 transparent GIF rather than an error, so
  the slideshow just skips to the next photo.

**Verified end to end:** with the backend process killed outright, a reload
still boots to the slideshow, renders cached photos with the correct
contain/cover treatment, and crossfades between them. The only text on screen
is `Atinge ecranul ca sa suni`. Nothing about the outage is observable.

### Deploying a change — bump `VERSION`

The shell is cache-first, which is exactly what makes the frame outage-proof
and also means **a tablet will happily run the old UI forever** unless the
worker itself changes. Whenever `index.html`, `app.js` or `style.css` is
edited, bump `VERSION` at the top of `sw.js` (`'v7'` → `'v8'` …) **and** the
matching `?v=` on the asset URLs in `index.html`. The browser
re-fetches `sw.js`, sees different bytes, installs the new worker, builds a new
`rama-shell-vN`, and `skipWaiting` + `clients.claim` hand over immediately. The
old shell cache is deleted on activate; `rama-photos` is untouched, so the 300
warmed photos survive the upgrade.

Serve `sw.js` with `Cache-Control: no-cache` (or a very short max-age) so that
check actually reaches the origin. Everything else can be cached normally — the
worker is the thing that controls freshness.

---

## 5. Testing on a desktop browser

Everything below works with no tablet, no camera and no backend.

```bash
cd server/signalling/public
python3 -m http.server 8080 --bind 127.0.0.1
```

Open **<http://127.0.0.1:8080/index.html?debug=1&mock=1>**.

> Use `127.0.0.1`, not a `file://` URL — service workers and `getUserMedia`
> need a secure context, and `localhost` counts as one.

`?debug=1` reveals the harness panel (top-left) and unlocks console logging.
`?mock=1` replaces the backend with 12 generated photos of assorted aspect
ratios and 4 fake contacts, so the slideshow and the 2x2 grid both have real
content.

### Harness buttons

| Button | Shows |
|---|---|
| `idle` | The slideshow. |
| `call-grid` | The 2x2 outgoing grid. |
| `dialing` | `Suna pe <Nume>...` with the live 3 s `Opreste` countdown, then the switch to `INCHIDE`. No signalling is sent in mock mode. |
| `incoming-ring` | The full ring screen, including the real 800 ms arming delay and the bell (after one click anywhere, for autoplay policy). |
| `decline-undo` | The 5 s undo card with its countdown. |
| `in-call` | In-call. Uses your webcam as a stand-in for the remote stream; with no webcam it falls through to the audio-only presentation. |
| `audio-only` | Forces the fallback: stored photo + animated level ring. |
| `reconnecting` | Adds the `Se reconecteaza...` band. |
| `post-call`, `missed`, `unavailable`, `fault` | The message states. |
| `mm overlay` | Draws the 10 mm edge margin, a 20 mm target square and a 27 mm gap bar over the UI, so the geometry can be checked against a ruler on screen. |
| `next photo` | Advances the slideshow immediately instead of waiting 25 s. |
| `drop cache` | Wipes the photo cache and `localStorage` — use this to re-test a cold first boot. |
| `hide panel` | Hides the harness without reloading. |

Keys `1`–`9` and `0` map to the same states in order.

The panel also prints the live metrics: viewport, `screen`, `devicePixelRatio`,
the computed `--mm`, and the derived px for the 10/20/27 mm rules and both ring
buttons — the fastest way to confirm the geometry on whatever panel you are on.

The harness bypasses the input guard (it uses ordinary `click`), so it can
never mask a guard bug.

### Testing things the buttons do not cover

**Simulate the real tablet exactly.** Set the viewport to 1920x1200 and load
`?debug=1&mock=1&pxPerMm=8.104`. Any `CFG` key can be overridden by a query
parameter of the same name, which is also how you shorten timers:
`?debug=1&mock=1&slideDwellMs=3000&ringMs=8000`.

**The input guard.** Every rule is observable with synthetic `PointerEvent`s
from the devtools console — dispatch `pointerdown` then `pointerup` on
`#btn-back` and vary one thing at a time: release outside the rect, hold 2700
ms, add a second `pointerId`, set `width`/`height` above 30 mm, or tap twice
inside 1500 ms. Only the clean tap should change `window.Rama.State.current`.

**The offline guarantee.** Load the page once with a backend running, wait for
`caches.open('rama-photos')` to fill, kill the backend, and reload. The
slideshow must be indistinguishable from the online case.

**The fault screen.** Clear `localStorage` and the caches, then load with
`?photosUrl=/api/nope` (no `mock`). It appears within a
couple of seconds, and points back at the real endpoints heal it within 15 s
with no interaction.

**A real call** needs two browsers, the signalling server and an HTTPS origin.
Serve the page through `tailscale serve --https=443 localhost:8080` and load it
by MagicDNS name — an IP address is not a secure origin, and the camera fails
silently.

`window.Rama` exposes `{ State, Store, Call, Signal, Slideshow, Metrics, CFG }`
in every build for poking at from the console.

---

## 6. What this expects from the backend

Same origin as the page. The only credential on the tablet is its own roster
`authToken` (kept in `localStorage`, plus the `frameo_device` cookie minted from
it); there are no server secrets client-side, so there is nothing for this
directory to contribute to `.env.example`. The whitelist is enforced
server-side, never by hiding UI.

### HTTP

| Endpoint | Response |
|---|---|
| `GET /api/photos?limit=300` | `{ "photos": [ { "id": "...", "url": "/..." } ] }`, **newest first**. |
| `GET /api/photo/<id>` | The image bytes (the signalling server proxies Immich). |
| `GET /api/ice` | `{ iceServers, ttl, expiresAt }` — the tailnet TURN profile with short-lived credentials, refreshed before expiry. |
| `GET /api/weather` | Optional reading for the clock screen; the server keeps it off unless `WEATHER_LAT`/`WEATHER_LON` are set. |

There is **no `/api/config`**. Device identity is provisioned per tablet (see
below) and the contact list arrives in the WebSocket `registered` frame,
already filtered by the server to the mutually-allowed peers of this device —
so the grid can never offer somebody the server would refuse to dial.

The photo parser is deliberately forgiving: `photos` may also arrive as
`items`, `assets` or `results`; entries may be bare URL strings, or objects
carrying `url`/`src`/`path`/`thumbnail`, or just an `id`, in which case
`photoUrlTemplate` (`/api/photo/{id}`) is applied.

### Identity provisioning

Both tablets load the same `index.html`, so identity cannot be baked into it.
Each tablet is provisioned once through its kiosk URL (full tablet setup:
`docs/TABLET.md` at the repo root):

```
https://<magicdns>/?device=frame-a&token=<that peer's authToken from roster.json>
```

Both values are persisted to `localStorage`, so the kiosk URL can be shortened
back to `https://<magicdns>/` afterwards. There is deliberately **no** random
fallback device id: the server authenticates every socket against
`roster.json`, so an invented id could only produce an endless `auth-failed`
reconnect loop. With no identity the client simply does not open the socket and
the slideshow still runs.

### WebSocket — `/ws`

This is the server's protocol, verbatim; `../README.md` §4 is the normative
copy. Note the deliberate asymmetry between what is sent and what is received.

**Sent by the frame**

| Type | Shape | When |
|---|---|---|
| `register` | `{ type, id, authToken }` | on every (re)connect |
| `heartbeat` | `{ type }` | every 20 s |
| `call-request` | `{ type, to }` | outgoing call. **No `callId`** — the server allocates it |
| `call-accept` | `{ type, callId }` | user tapped RASPUNDE |
| `call-decline` | `{ type, callId, reason }` | after the 5 s undo expires, on ring timeout, or when busy |
| `call-cancel` | `{ type, callId }` | Opreste, or outgoing timeout (skipped if no id yet) |
| `offer` / `answer` | `{ type, callId, sdp }` | `sdp` is a full `RTCSessionDescription` |
| `ice-candidate` | `{ type, callId, candidate }` | trickle |
| `hangup` | `{ type, callId }` | INCHIDE |

**Handled from the server**

| Type | Effect |
|---|---|
| `registered` | adopt id/display name, replace the contact list, re-render the grid |
| `presence` | mark a contact online/busy |
| `incoming-call` | ring (or adopt the id if a `?from=` URL already showed the ring screen, see below) |
| `call-ringing` | adopt the server's `callId` for our outgoing call |
| `call-accepted` | if `shouldCreateOffer`, build and send the offer |
| `call-declined` / `call-failed` | "nu poate raspunde acum" |
| `call-cancelled` | missed |
| `offer` / `answer` / `ice-candidate` | WebRTC negotiation |
| `hangup` | post-call |
| `call-ended` | authoritative teardown (ring timeout, peer disconnect, admin hangup) |
| `error` / `heartbeat-ack` | logged / ignored — never shown |

The **call id belongs to the server.** The client never invents one; every
frame after `call-request` carries the id the server handed back, which is what
its cross-call-injection check validates against.

Inbound messages accept `from`/`peer`/`caller`/`id` for the sender and
`sdp`/`description`/`offer`/`answer` for the SDP. Candidates arriving before
the remote description are buffered and flushed. Reconnect is exponential
backoff capped at 10 s, and a dead socket is never visible to the user in any
way.

### How a ring reaches the frame

Rings arrive only as `incoming-call` on the frame's own WebSocket. The server
does not call into the tablet or its kiosk browser (no kiosk REST API, no
`loadUrl`). Keeping that socket alive is the job of the reconnect loop above and,
on the tablet, of the Tailscale watchdog (`server/tablet/README-watchdog.md`).

The page also accepts `?from=<contactId>&name=<Nume>&call=<callId>` at load and
comes up already ringing; the WebSocket `incoming-call` then supplies or
confirms the call id. Nothing in this repo uses that entry point today. It is
there for an external trigger that can open a URL on the tablet, and the ring
screen is idempotent, so both paths firing is safe.

---

## 7. Configuration

All knobs live in the `window.FRAME_CONFIG` block at the top of `index.html`
with a comment each: endpoints, `screenDiagonalIn`, every timing in the tables
above, the input-guard thresholds and `photoCacheLimit`. `iceServers` is empty
there on purpose: the real list is fetched from `/api/ice` at runtime, because
the TURN credentials in it expire.

Two worth calling out when deploying to a different tablet:

- **`screenDiagonalIn`** — set this to the panel's real diagonal. Everything
  physical scales from it.
- **`pxPerMm`** — a hard override for when the reported `screen` dimensions
  cannot be trusted. Measure a known-width element on the glass with a ruler
  and set it directly.

### Language

The UI is Romanian or English, decided once at page load:

1. `?lang=ro` or `?lang=en` in the URL wins and is saved to `localStorage`
   (`frame.lang`), like `device` / `token`, so the kiosk URL needs it once:
   `https://<magicdns>/?device=frame-a&token=<authToken>&lang=en`;
2. otherwise the saved `frame.lang`;
3. otherwise the tablet's language: `navigator.language` starting with `ro`
   gives Romanian, anything else gives English.

It sets `<html lang>`, every text in `index.html` marked `data-i18n`
(`data-i18n-aria` / `data-i18n-title` for attributes), the strings set from
`app.js`, and the clock-stamp date (`ro-RO` "17 nov." / `en-GB` "17 Nov";
the time is 24-hour in both). The Romanian text stays in `index.html` so the
page is never blank before the script runs. A key missing from one language
falls back to English, then to the key name. The debug harness is English only.
