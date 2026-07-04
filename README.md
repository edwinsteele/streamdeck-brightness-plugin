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

2. Link the plugin into Stream Deck's plugin folder and restart it:

   ```sh
   npx streamdeck link com.esteele.monitorbrightness.sdPlugin
   npx streamdeck restart com.esteele.monitorbrightness
   ```

   `streamdeck link` only needs to be run once. If the plugin doesn't seem to pick up a rebuild
   after `restart`, the Node process can be left running stale code — find and kill it directly
   and Stream Deck will respawn it with the current build:

   ```sh
   pkill -f "monitorbrightness.sdPlugin/bin/plugin.js"
   ```

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

Rebuilds on save and asks Stream Deck to restart the plugin. As noted above, if changes don't seem
to take effect, confirm with `ps aux | grep monitorbrightness.sdPlugin` that the running process's
start time actually changed, and `pkill` it if not.
