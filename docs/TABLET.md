# Tablet setup

How to turn an Android tablet into the frame: one web page, full screen, forever, with no way for
anyone to wander out of it by accident. Do the server first ([INSTALL.md](../INSTALL.md)).

Tested on a second-hand **Samsung Galaxy Tab A9+** (SM-X210) with FreeKiosk. Other tablets should
work if `dpm set-device-owner` succeeds on them; some heavily skinned or "Go" builds refuse it.

You need a computer with `adb` ([Android platform tools](https://developer.android.com/tools/releases/platform-tools))
and a USB cable. Everything below is run on that computer.

## 1. Factory reset, and add no account

Factory-reset the tablet and go through the setup wizard **without adding a Google or Samsung
account**. Skip every sign-in. Connect to Wi-Fi.

This matters: Android only lets an app become Device Owner when no account exists on the device.
If an account gets added at any point, the only fix is another factory reset.

Then enable USB debugging: **Settings → About tablet → Software information → tap Build number
7 times**, then **Settings → Developer options → USB debugging**. Plug the tablet in and accept the
"Allow USB debugging" prompt (tick "Always allow from this computer").

```bash
adb devices   # the tablet must show as "device", not "unauthorized"
```

## 2. Install FreeKiosk and Tailscale

[FreeKiosk](https://github.com/RushB-fr/freekiosk) is a free, open-source kiosk browser that can
run as Device Owner. Tailscale gives the tablet its private path to the server.

```bash
# FreeKiosk: download the latest APK from https://github.com/RushB-fr/freekiosk/releases
adb install -r freekiosk-vX.Y.Z.apk

# Tailscale: download the universal APK from https://pkgs.tailscale.com/stable/
adb install -r tailscale-android-universal-X.Y.Z.apk
```

Open Tailscale on the tablet and log in to your tailnet. (Logging in to the Tailscale app does not
add an Android account, so it doesn't block the next step.)

Make Tailscale the always-on VPN, so it comes back after a reboot:

```bash
adb shell settings put global always_on_vpn_app com.tailscale.ipn
adb shell settings put global always_on_vpn_lockdown 0
```

## 3. Make FreeKiosk the Device Owner

```bash
adb shell dpm set-device-owner com.freekiosk/.DeviceAdminReceiver
```

Expect `Success: Device owner set to package com.freekiosk`. If it says an account already exists,
go back to step 1.

As Device Owner, FreeKiosk can use Android's Lock Task mode: no status bar, no navigation bar, no
notification shade, no system dialogs. Without it, a quick-settings pull-down or a "rate this app"
dialog will eventually end up on the grandparents' screen.

Grant camera and microphone up front, so no permission prompt ever appears during a call, and turn
off location, which the frame doesn't need:

```bash
adb shell pm grant com.freekiosk android.permission.CAMERA
adb shell pm grant com.freekiosk android.permission.RECORD_AUDIO
adb shell appops set com.freekiosk android:fine_location ignore
adb shell appops set com.freekiosk android:coarse_location ignore
```

Keep the screen on while it's charging:

```bash
adb shell settings put global stay_on_while_plugged_in 7
```

## 4. Point FreeKiosk at the frame

Each frame loads one URL, with its id and token from `~/frameo/config/roster.json` on the server:

```
https://your-machine.your-tailnet.ts.net/?device=frame-a&token=<frame-a's authToken>&lang=en
```

`lang` is `en` or `ro`. Without it the frame follows the tablet's language setting.

Use the MagicDNS name, never a `100.x` IP: an IP is not a secure origin, and the browser would
silently refuse the camera.

You can type it in FreeKiosk's settings, or push it over ADB (FreeKiosk's
[ADB configuration](https://github.com/RushB-fr/freekiosk/blob/main/docs/adb-configuration.md)),
which avoids typing a long token on the tablet:

```bash
adb shell am start -n com.freekiosk/.MainActivity \
  --es pin '<your PIN>' \
  --es url 'https://your-machine.your-tailnet.ts.net/?device=frame-a&token=<token>'
```

In FreeKiosk's settings, set:

| Setting | Value | Why |
|---|---|---|
| Lock mode | On | Lock Task mode: nothing else can be opened. |
| Launch on boot | On | After a power cut the frame comes back by itself. |
| Reload on error | On | A failed load retries instead of showing an error. |
| Settings PIN | your own PIN | Protects the way back into the settings. |
| Settings gesture | **12 taps within 1.5 s** | See below. |
| Allowed apps (lock task) | add Tailscale (`com.tailscale.ipn`) | So the watchdog can bring Tailscale up from the kiosk. |
| REST API | Off | The server doesn't use it. |

**Why 12 taps.** The idle frame says "tap to call", so the grandparents tap the screen on purpose.
A default of a few taps would open the settings sooner or later. Twelve taps in 1.5 seconds is
about eight taps a second, which doesn't happen by accident.

## 5. Getting back out of kiosk mode

* **On the tablet:** tap the screen 12 times within 1.5 seconds, enter the PIN, and you're in
  FreeKiosk's settings, where you can turn lock mode off.
* **Over ADB** (USB, or over the tailnet if you enabled `adb tcpip`):

  ```bash
  adb shell am start -n com.freekiosk/.MainActivity --es pin '<your PIN>' --ez kiosk_enabled false
  # and to lock it again:
  adb shell am start -n com.freekiosk/.MainActivity --es pin '<your PIN>' --ez kiosk_enabled true
  ```

* To reload the frame after a server update, push the URL again with a changed `&v=` parameter
  (for example `&v=2`). That restarts the page and skips the cached copy. `am force-stop` does not
  work on a Device Owner app.

## 6. The watchdog (recommended)

There is a known problem where Tailscale on Android doesn't reconnect after a reboot, even as the
always-on VPN. The frame keeps showing its cached photos, but calls and new photos stop. The
watchdog in [server/tablet/](../server/tablet/) runs under Termux, checks the tailnet once a
minute, brings Tailscale back when it drops, and sends the server a heartbeat.
[server/tablet/README-watchdog.md](../server/tablet/README-watchdog.md) has the install steps.

## 7. Check it

1. Reboot the tablet (`adb reboot`). It should come back to the photos with no taps, five times
   in a row.
2. Call the frame from the phone app. It should ring, and the green **ANSWER** button
   should connect the call.
3. Unplug the server's network cable for a minute. The frame should keep showing photos from its
   cache, with no error on screen.

## 8. On the shelf

* Leave it plugged in permanently. Being on charge keeps Android out of Doze, which is part of why
  ringing works reliably.
* Turn on the battery charge limit if the tablet has one (Samsung: **Settings → Battery → Battery
  protection**), and check the battery for swelling now and then. A battery kept full for years can
  swell.
* The frame app has no night schedule: the screen stays on. If a lit screen bothers anyone at
  night, lower the brightness or use the tablet's own screen settings.
