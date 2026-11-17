#!/data/data/com.termux/files/usr/bin/sh
#
# Installed on the tablet as:
#   /data/data/com.termux/files/home/.termux/boot/10-frameo-watchdog.sh
#
# Termux:Boot runs every executable script in ~/.termux/boot/ in lexical order,
# a few seconds after BOOT_COMPLETED, inside a short-lived foreground service.
# That grace period is over long before Wi-Fi has associated, so the only job
# here is: take a wake lock, hand off to the watchdog, and get out of the way.
#
# Keep this file tiny. Anything that can fail belongs in tailscale-watchdog.sh,
# which logs; a failure here is invisible.

# Stops Android from suspending the CPU out from under the watchdog loop. Without
# it the tablet dozes and the 60s check silently becomes a 20-minute one.
termux-wake-lock 2>/dev/null

WATCHDOG="$HOME/.frameo/tailscale-watchdog.sh"

[ -x "$WATCHDOG" ] || exit 0

# Detach: Termux:Boot's own service must be free to exit. setsid is the cleaner
# way (new session, no controlling terminal) but it lives in util-linux, which is
# not installed by default - so nohup is the fallback, not the other way round.
if command -v setsid >/dev/null 2>&1; then
  setsid "$WATCHDOG" --loop >/dev/null 2>&1 < /dev/null &
else
  nohup "$WATCHDOG" --loop >/dev/null 2>&1 < /dev/null &
fi

exit 0
