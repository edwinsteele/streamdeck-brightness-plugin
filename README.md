# Stream Deck Monitor Brightness

A Stream Deck+ plugin that puts per-monitor brightness control on the 4 rotary dials, backed by
[Lunar](https://lunar.fyi/). Each dial:

- **Rotate** — adjusts that monitor's brightness in 10% steps (values are always rounded to the
  nearest 10%).
- **Press** — blacks the monitor out to 0%; press again to restore the brightness it had
  beforehand.
- **Touch strip** — shows the monitor name, current brightness, and a level bar.

Brightness is also refreshed automatically when the Mac wakes from sleep.

## Requirements

- A Stream Deck+ (the touch strip / dial feedback only works on this device).
- The [Elgato Stream Deck app](https://www.elgato.com/downloads) installed.
- [Lunar](https://lunar.fyi/) installed and running, with its CLI installed (in Lunar: enable the
  CLI, or run `/Applications/Lunar.app/Contents/MacOS/Lunar install-cli`).
- Node.js 20+ and npm, for building the plugin.

## Setup

1. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

2. Link the plugin into Stream Deck's plugin folder and load it:

   ```sh
   npx streamdeck link com.esteele.monitorbrightness.sdPlugin
   npm run reload
   ```

   `streamdeck link` only needs to be run once. `npm run reload` tries the official
   `streamdeck restart` first — which is unreliable in practice, since it just fires a deep link
   at the Stream Deck app without confirming the plugin actually reloaded — and automatically
   falls back to force-killing the stale process (which Stream Deck immediately respawns) if it
   detects the restart didn't take effect. See `scripts/reload-plugin.sh`.

3. In the Stream Deck app, open the "Monitor Brightness" category and drag the "Monitor
   Brightness" action onto up to 4 dials on your Stream Deck+ profile.

4. For each dial, open its property inspector and pick the monitor it should control from the
   **Display** dropdown. The names offered (`P27u-20`, `Studio Display`, `Built-in`) must match
   what Lunar calls that display — check with:

   ```sh
   lunar displays
   ```

   If your monitors have different names, edit the `<option>` values in
   `com.esteele.monitorbrightness.sdPlugin/ui/dial.html` and rebuild.

## Configuration notes

- `LUNAR_BIN` in `src/actions/monitor-brightness-dial.ts` is hardcoded to
  `/Users/esteele/.local/bin/lunar`. If Lunar's CLI is installed elsewhere on your machine, update
  that constant and rebuild.
- The dropdown's monitor list in `com.esteele.monitorbrightness.sdPlugin/ui/dial.html` is a static
  list, since it's expected to change rarely. Update it if your set of monitors changes.

## Development

```sh
npm run watch
```

Rebuilds on save and reloads the plugin via `scripts/reload-plugin.sh`, which verifies (by PID and
process start time) whether `streamdeck restart` actually took effect and force-kills the stale
process if not — watch its `[reload-plugin] ...` output to see whether a given rebuild needed the
fallback.
