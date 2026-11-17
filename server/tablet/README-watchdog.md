# Tablet watchdog — keeping the frame reachable after a reboot

**Read section 0 first.** It contains the recommendation, and it is probably not the
recommendation you expect: *do not depend on Tailscale running on the tablets at all.*

---

## 0. The recommendation, up front

There are two ways to fix "the frame is unreachable after a reboot".

| | **A. Funnel-primary** (recommended) | **B. Watchdog-primary** |
|---|---|---|
| What the tablet talks to | `https://your-machine.your-tailnet.ts.net/` resolved by **public DNS**, served by `tailscale funnel --https=443` | the same URL resolved by **MagicDNS** to the server's tailnet IP (`100.x.y.z`) |
| Needs Tailscale running on the tablet | **No** | Yes, always |
| Survives the tailscale-android autostart bug | **Yes, by not caring** | Only as fast as the watchdog notices |
| Extra moving parts on the tablet | none | Termux + Termux:Boot + a shell loop |
| Latency / bandwidth | one hop through Tailscale's ingress; a few hundred KB/day of signalling and thumbnails | direct LAN-ish path |
| Failure mode | Tailscale's funnel ingress or the ACL breaking | anything on the Android side |

**Take A, and install the watchdog anyway.** They are not alternatives; A removes the
blocker from the critical path and the watchdog then only protects the *admin* channel.

Why this works at all: `tailscale funnel --bg --https=443 http://127.0.0.1:8080` (already the
plan of record — see `ARCHITECTURE-PUBLIC.md` D1/D2) publishes **public** `A`/`AAAA` records for
`your-machine.your-tailnet.ts.net` and terminates TLS with the same Let's Encrypt
certificate the tailnet path uses. The kiosk URL therefore does not change by one character,
the origin stays HTTPS (so `getUserMedia` keeps working), and the web client already builds
every request from `location.*` — `signalling/public/app.js` derives its WebSocket URL from
`location.protocol`/`location.host`, so nothing in the client needs touching.

The consequences of choosing A, stated plainly:

* **Turn Tailscale OFF on the tablets, or leave it on — either works.** With it on, MagicDNS
  resolves the name to the server's `100.x.y.z` address and traffic takes the direct tailnet
  path (faster, and it does not consume Funnel bandwidth). With it off or broken, public DNS answers instead and the
  frame keeps working. That is exactly the property we want.
* **One genuinely bad state remains**, and it is the reason to still run the watchdog: Tailscale
  *running but half-up* — the app is alive, so MagicDNS is the system resolver and answers
  the `100.x.y.z` address, but the tunnel is not carrying traffic. Then the frame follows a dead
  route and the public path is never tried. This is rarer than the boot bug, and the watchdog's
  `force-stop` step is precisely the cure for it.
* **Tailscale on the tablet stays useful** for remote administration: `adb connect` over the
  tailnet, FreeKiosk's remote admin page, pulling `~/.frameo/watchdog.log` without a USB cable.
  Losing it for an hour is an inconvenience, not an outage.
* **Before relying on A, verify the public DNS record exists** (it appears only once Funnel is
  actually enabled):

  ```bash
  dig +short your-machine.your-tailnet.ts.net @1.1.1.1
  # must print public IPv4 addresses, NOT a 100.x.y.z tailnet address and NOT nothing
  curl -sS https://your-machine.your-tailnet.ts.net/api/health | head -c 200
  # run this from a machine that is NOT on the tailnet - a phone on mobile data is the honest test
  ```

  If that returns nothing, Funnel is not on yet: `sudo tailscale funnel status`, and see
  `ARCHITECTURE-PUBLIC.md` §1.

**Practical upshot:** point the tablets at `https://your-machine.your-tailnet.ts.net/…`
(they already are), install the watchdog below, and stop treating Tailscale-on-Android as
load-bearing.

---

## 1. What the watchdog does

`tailscale-watchdog.sh` runs on the tablet under Termux:Boot. Every 60 seconds it answers one
question — *can I reach the server over the tailnet?* — and escalates only when the answer is no
**and** the tablet does have internet:

| Consecutive failures | Action | Why this one |
|---|---|---|
| 1 | `am broadcast -a com.tailscale.ipn.CONNECT_VPN -n com.tailscale.ipn/.IPNReceiver`, twice, 2s apart | Tailscale's own documented automation hook. `IPNReceiver` is `exported="true"` with no permission guard. A broadcast is not an activity start, so it is immune to Android's background-launch restrictions *and* to FreeKiosk's lock-task allowlist. Sent twice because one is documented as insufficient on Android 16 / targetSdk 35 (tailscale/tailscale#18847). |
| 2 | `am start -n com.tailscale.ipn/.IPNActivity`, then bring FreeKiosk back | This is the thing that is known to work when done by hand. It briefly covers the photo frame, hence the refocus. |
| 3+ | `am force-stop com.tailscale.ipn`, restart it, broadcast with `-f 32` | Clears the `Ipn.State.Stopping` deadlock from #18847. `-f 32` is `FLAG_INCLUDE_STOPPED_PACKAGES`: a force-stopped package receives **no** ordinary broadcast, so without that flag the follow-up nudge would be silently dropped. Capped at 4/hour. |

And what it refuses to do:

* **No internet → no action.** Wi-Fi flaps and post-reboot association gaps are the common case;
  restarting a VPN because the Wi-Fi is down is superstition, and it costs battery.
* **No spinning.** After 5 consecutive failures the interval widens from 60s to 300s.
* **Quiet when healthy.** One log line per 30 healthy cycles, plus one on every state change.
  The log rotates at 256 KiB, 3 files kept.
* **One instance only**, via an atomic `mkdir` lock with stale-PID reclamation (Android kills
  background processes without warning; a leftover lock must not wedge the watchdog forever).

It also POSTs a heartbeat once a minute to `POST /api/frame-heartbeat` **over the public Funnel
URL**, authenticated with the frame's own roster `authToken` (never `CONTROL_TOKEN`). Going over
the public path is the entire point: the heartbeat has to keep arriving while the tailnet is
broken, because that is what distinguishes the two failures:

* heartbeat arriving, `tailnetOk:false` → the tablet is fine, Tailscale is dead → **DEGRADED**
* no heartbeat at all → the tablet is off, unplugged or off the network → **DOWN**

`server/frame-heartbeat-alert.sh` on the server turns that into a notification (section 6).

---

## 2. Install it — the automated way

This assumes the tablet is already provisioned as a frame (FreeKiosk, device owner, kiosk URL):
see `docs/TABLET.md` at the repo root.

From any computer with `adb` (macOS or Linux), tablet connected by USB with USB debugging on:

```bash
cd <repo>/server/tablet
./install-watchdog.sh --frame-id frame-a --token '<authToken from roster.json>'
```

It is idempotent, it never reinstalls an app that is already there, and it never touches
FreeKiosk's configuration. Add `--reboot` to have it reboot the tablet at the end so you can
watch the boot path work. If two tablets are attached, pass `--serial`.

Then verify on the **server**:

```bash
# The authoritative, always-readable source. GET /api/health only reveals the
# detail to an authenticated caller now that the login gate is in place; this
# file is written by the server itself and needs no credential.
jq . ~/frameo/logs/frame-heartbeats.json

# or, in the shape a human wants:
~/frameo/server/frame-heartbeat-alert.sh
```

If anything in the script fails, do it by hand — section 3 is the same sequence, expanded.

---

## 3. Install it — the manual ADB sequence

Every command below runs **on the computer the tablet is plugged into**; lines starting with
`adb shell` run on the tablet.

### 3.1 Prerequisites

```bash
brew install --cask android-platform-tools      # macOS; on Debian/Ubuntu: apt install adb
adb devices                                     # accept the RSA prompt ON THE TABLET
adb shell getprop ro.product.model              # tested on SM-X210 (Galaxy Tab A9+)
adb shell getprop ro.build.version.release      # tested on Android 16 / One UI 8
```

If `adb devices` shows `unauthorized`, unlock the tablet and tick "Always allow from this
computer". FreeKiosk in Device Owner mode hides the notification shade, but the RSA dialog is a
system dialog and still appears.

### 3.2 Sideload Termux and Termux:Boot from F-Droid

Both APKs **must** come from the same source. Termux:Boot only talks to a Termux signed with the
same key, so an F-Droid Termux:Boot beside a Play Store Termux silently does nothing.

```bash
mkdir -p ~/Downloads/frameo-apks && cd ~/Downloads/frameo-apks

# Termux 0.119.0-beta.3 (versionCode 1022) - current F-Droid build, min Android 7
curl -fLO https://f-droid.org/repo/com.termux_1022.apk

# Termux:Boot 0.8.1 (versionCode 1000) - current F-Droid build, min Android 5
curl -fLO https://f-droid.org/repo/com.termux.boot_1000.apk

shasum -a 256 com.termux_1022.apk com.termux.boot_1000.apk   # note them down

adb install -r -g com.termux_1022.apk
adb install -r -g com.termux.boot_1000.apk
```

`-g` grants the manifest permissions immediately; `-r` permits a same-signature upgrade.
(The canonical index pages, if you want to check for a newer build first:
`https://f-droid.org/en/packages/com.termux/` and `https://f-droid.org/en/packages/com.termux.boot/`.)

**Termux:Boot does nothing until it has been opened once** — that first launch is what registers
its `BOOT_COMPLETED` receiver. This step is not optional:

```bash
adb shell monkey -p com.termux      -c android.intent.category.LAUNCHER 1
sleep 6
adb shell monkey -p com.termux.boot -c android.intent.category.LAUNCHER 1
```

### 3.3 Permissions the watchdog actually needs

```bash
# 1. Doze exemption. Without it Android freezes the loop and the 60s check
#    silently becomes a 20-minute one.
adb shell dumpsys deviceidle whitelist +com.termux

# 2. "Display over other apps". This is what lets Termux start the Tailscale
#    ACTIVITY from the background on Android 10+. Without it, only the
#    CONNECT_VPN broadcast path works (which is still most of the value).
adb shell appops set com.termux SYSTEM_ALERT_WINDOW allow

# 3. Samsung One UI is more aggressive than stock about background processes.
adb shell appops set com.termux RUN_IN_BACKGROUND allow
adb shell appops set com.termux RUN_ANY_IN_BACKGROUND allow

# verify
adb shell dumpsys deviceidle whitelist | grep -i termux
adb shell appops get com.termux SYSTEM_ALERT_WINDOW
```

Also, on Samsung tablets: **Settings → Battery → Background usage limits** → make sure Termux is
not in "Sleeping apps" / "Deep sleeping apps". One UI puts apps there on its own after a few days
of the screen being off, and it is the single most common cause of a watchdog that "worked for a
week and then stopped".

**FreeKiosk lock task:** if FreeKiosk is locking the device to itself only (see
`docs/TABLET.md` for how FreeKiosk is set up and how to exit kiosk mode), `am start` of
Tailscale will be denied by the system. In FreeKiosk's settings, allow `com.tailscale.ipn` and
`com.termux` (Device Owner → allowed/lock-task packages). The broadcast path does not need this;
the activity path does.

### 3.4 Push the files

`adb push` cannot write into `/data/data/com.termux/…` on a non-rooted device, so stage on shared
storage and let Termux copy them in.

```bash
cd <repo>/server/tablet

adb shell mkdir -p /sdcard/Download/frameo
adb push tailscale-watchdog.sh   /sdcard/Download/frameo/tailscale-watchdog.sh
adb push termux-boot-launcher.sh /sdcard/Download/frameo/10-frameo-watchdog.sh

# The config carries this frame's token, so build it locally and push it, do not
# type the token into a shared shell history on the tablet.
cp watchdog.env.example /tmp/watchdog.env
$EDITOR /tmp/watchdog.env          # set FRAME_ID and FRAME_TOKEN
adb push /tmp/watchdog.env /sdcard/Download/frameo/watchdog.env
rm -f /tmp/watchdog.env
```

Now, **in a Termux session on the tablet** (open Termux on the device, or drive it with the
`RUN_COMMAND` service as `install-watchdog.sh` does):

```sh
pkg update -y
pkg install -y curl termux-am-socket termux-tools

mkdir -p ~/.frameo ~/.termux/boot
cp /sdcard/Download/frameo/tailscale-watchdog.sh ~/.frameo/tailscale-watchdog.sh
cp /sdcard/Download/frameo/10-frameo-watchdog.sh ~/.termux/boot/10-frameo-watchdog.sh
cp /sdcard/Download/frameo/watchdog.env          ~/.frameo/watchdog.env
chmod 700 ~/.frameo/tailscale-watchdog.sh ~/.termux/boot/10-frameo-watchdog.sh
chmod 600 ~/.frameo/watchdog.env
rm -rf /sdcard/Download/frameo          # the token must not linger on shared storage
```

`termux-am-socket` is the important one: it is what gives Termux a working `am`. `/system/bin/am`
exists but only functions for the shell user, not for an app — so without this package the
watchdog can detect the problem and never fix it.

If Termux cannot reach `/sdcard`, run `termux-setup-storage` once and accept the prompt.

### 3.5 Self-test, then start

```sh
~/.frameo/tailscale-watchdog.sh --test
```

Expect `RESULT: ready`, `curl` present, `am` resolving to a Termux path (**not** `/system/bin/am`),
`internet: OK`, and `heartbeat: accepted`. Fix anything it complains about before continuing.

```sh
~/.termux/boot/10-frameo-watchdog.sh          # starts it now, exactly as boot will
~/.frameo/tailscale-watchdog.sh --status
```

---

## 4. Verify it survives a reboot

This is the only test that counts. Budget five minutes.

```bash
adb reboot
# wait for the tablet to come back, then:
adb wait-for-device

# 1. is the watchdog running at all?
adb shell "ps -A | grep -c com.termux"          # non-zero

# 2. what does its own log say? (works even without the tailnet)
adb shell "run-as com.termux cat files/home/.frameo/watchdog.log" 2>/dev/null | tail -20
#    On a release build run-as is blocked; read it in Termux instead:
#      tail -20 ~/.frameo/watchdog.log
```

Expect, in order: `watchdog X starting`, `fresh boot (uptime …s) - waiting 45s`, then either
silence (Tailscale came back on its own) or the escalation ladder followed by
`recovered after broadcast` / `recovered after activity-start`.

From the **server**, the authoritative check:

```bash
jq '.frames[] | {id, lastSeenIso, tailnetOk, lastAction, restarts}' \
   ~/frameo/logs/frame-heartbeats.json
watch -n 30 ~/frameo/server/frame-heartbeat-alert.sh
```

(`GET /api/health` carries the same numbers under `.frames`, but only for an
authenticated caller — anonymous requests get a bare `{"ok":true}`.)

Within ~2 minutes of boot each frame should show a `lastSeen` under 90s old. `tailnetOk: true`
means the whole chain is up. `tailnetOk: false` with a fresh `lastSeen` means the tablet is alive
and on the internet but Tailscale is still dead — and the frame is still working, over the Funnel.

And the honest end-to-end test, from a phone on **mobile data, Tailscale off**:

```
https://your-machine.your-tailnet.ts.net/
```

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `--test` says `no am command` | `termux-am-socket` missing | `pkg install termux-am-socket` |
| `am` resolves to `/system/bin/am` | same | as above; `/system/bin/am` only works from `adb shell` |
| Log shows `am start failed` | background activity start blocked, or FreeKiosk lock task | `adb shell appops set com.termux SYSTEM_ALERT_WINDOW allow`; allow `com.tailscale.ipn` in FreeKiosk |
| Broadcasts sent, nothing happens | Tailscale has never been granted the VPN permission, or is logged out | open Tailscale once by hand and accept the VPN dialog; `CONNECT_VPN` cannot answer a consent dialog for you |
| Watchdog dies after a few hours | Samsung One UI put Termux to sleep | Settings → Battery → Background usage limits → remove Termux from Sleeping apps; re-run the `deviceidle` whitelist command |
| Nothing runs after reboot | Termux:Boot never opened once, or signature mismatch with Termux | open Termux:Boot once; reinstall both from `f-droid.org` |
| `heartbeat rejected (HTTP 403)` | `FRAME_ID`/`FRAME_TOKEN` do not match `roster.json`, or that id is not `kind: "frame"` | fix `~/.frameo/watchdog.env` |
| `heartbeat endpoint missing (404)` | server predates `POST /api/frame-heartbeat` | deploy the current `signalling/server.js` |
| Log full of `no internet` | Wi-Fi | that is the watchdog behaving correctly — it does not restart the VPN over a Wi-Fi outage |

Useful one-liners:

```bash
# Is Tailscale even running?
adb shell "ps -A | grep tailscale"
# Force the whole recovery by hand, exactly as the watchdog would:
adb shell am broadcast -a com.tailscale.ipn.CONNECT_VPN -n com.tailscale.ipn/.IPNReceiver
adb shell monkey -p com.tailscale.ipn -c android.intent.category.LAUNCHER 1
# Watch the watchdog live:
adb shell "run-as com.termux tail -f files/home/.frameo/watchdog.log"
```

---

## 6. The server side

`server/frame-heartbeat-alert.sh` reads `${FRAMEO_ROOT}/logs/frame-heartbeats.json` — written by
the signalling server, so no token is needed — and falls back to `GET /api/health` if that file is
missing. Wire it to cron next to the existing health check:

```cron
*/5 * * * * ~/frameo/server/frame-heartbeat-alert.sh >/tmp/frameo-frames.txt 2>&1
```

Set `ALERT_URL` to an ntfy-style endpoint and it POSTs the alert text there only when something
is wrong; with `ALERT_URL` unset it only prints. It de-duplicates identical alerts for 60
minutes, and supports `QUIET_HOURS=23-7` so a flat battery at 3am does not wake anyone. Exit codes: `0` healthy,
`1` a frame is DOWN or DEGRADED, `2` it could not check at all.

---

## 7. Upstream references

The bug and the mechanisms this script relies on:

* [tailscale/tailscale#10013](https://github.com/tailscale/tailscale/issues/10013) — Tailscale does not autostart when selected as Always-On VPN (Oct 2023, closed without a fix that helps here)
* [tailscale/tailscale#16935](https://github.com/tailscale/tailscale/issues/16935) — no autostart after an Android TV reboot; `settings put secure always_on_vpn_app` explicitly tried and ineffective (Aug 2025)
* [tailscale/tailscale#18847](https://github.com/tailscale/tailscale/issues/18847) — Android 16 / targetSdk 35: `"Background start not allowed: service Intent"`, the `Ipn.State.Stopping` deadlock, and the need to send `CONNECT_VPN` **twice** (open, Mar 2026). This is the issue that shapes the escalation ladder above.
* [tailscale/tailscale#14148](https://github.com/tailscale/tailscale/issues/14148) — Android intent not reliable
* [tailscale-android `AndroidManifest.xml`](https://github.com/tailscale/tailscale-android/blob/main/android/src/main/AndroidManifest.xml) — `IPNReceiver` is `exported="true"` and handles `CONNECT_VPN`, `DISCONNECT_VPN`, `USE_EXIT_NODE`; there is **no** `BOOT_COMPLETED` receiver, which is the root of the whole problem
* [Android: restrictions on starting activities from the background](https://developer.android.com/guide/components/activities/background-starts)
* [termux/termux-am-socket](https://github.com/termux/termux-am-socket) — how Termux gets a working `am`
* [Termux `RUN_COMMAND` intent](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) — how `install-watchdog.sh` drives Termux from adb
