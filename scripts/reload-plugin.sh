#!/usr/bin/env bash
#
# `streamdeck restart` is fire-and-forget: it spawns `open <deep-link> -g` in the
# background and reports success as soon as that's dispatched, with no confirmation
# that Stream Deck actually reloaded the plugin process. This script tries the
# official command first, verifies via the process's PID/start-time whether it
# actually took effect, and only then force-kills the stale process directly
# (Stream Deck's app supervises the plugin and immediately respawns it).

UUID="com.esteele.monitorbrightness"
PATTERN="monitorbrightness.sdPlugin/bin/plugin.js"
POLL_INTERVAL=0.5
POLL_ATTEMPTS=8

get_pid() {
	pgrep -f "$PATTERN" | head -n1
}

get_start() {
	ps -o lstart= -p "$1" 2>/dev/null
}

old_pid=$(get_pid)
old_start=""
if [ -n "$old_pid" ]; then
	old_start=$(get_start "$old_pid")
fi

echo "[reload-plugin] old pid: ${old_pid:-none}"

npx streamdeck restart "$UUID" >/dev/null 2>&1

reloaded=0
new_pid=""
for _ in $(seq 1 "$POLL_ATTEMPTS"); do
	sleep "$POLL_INTERVAL"
	new_pid=$(get_pid)
	[ -z "$new_pid" ] && continue

	if [ "$new_pid" != "$old_pid" ]; then
		reloaded=1
		break
	fi

	new_start=$(get_start "$new_pid")
	if [ -n "$old_start" ] && [ "$new_start" != "$old_start" ]; then
		reloaded=1
		break
	fi
done

if [ "$reloaded" = 1 ]; then
	echo "[reload-plugin] streamdeck restart took effect (pid $new_pid)."
	exit 0
fi

if [ -z "$old_pid" ]; then
	echo "[reload-plugin] no plugin process found; is Stream Deck running and the plugin linked?" >&2
	exit 0
fi

echo "[reload-plugin] restart didn't take effect; killing stale pid $old_pid..."
kill "$old_pid" 2>/dev/null

for _ in $(seq 1 6); do
	sleep "$POLL_INTERVAL"
	respawned=$(get_pid)
	if [ -n "$respawned" ] && [ "$respawned" != "$old_pid" ]; then
		echo "[reload-plugin] respawned as pid $respawned."
		exit 0
	fi
done

echo "[reload-plugin] warning: killed $old_pid but didn't see a respawn." >&2
exit 0
