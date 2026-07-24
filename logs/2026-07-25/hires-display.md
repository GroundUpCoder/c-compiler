# hires-display — high-density (sub-1×) desktop zoom, settable in Control Panel → Display

The VT2 zoom used to be integer-only (`[1,2,3]`, page-side, localStorage) —
there was no way to go DENSER than native, and the setting had no in-OS
surface. This lands both halves:

## The density engine (page-side)

- `VT2_ZOOMS = [0.5, 0.75, 1, 2, 3]` — ONE ordered factor list. Sub-1 steps
  are fractional on purpose (a downscale is inherently filtered, so the
  "integer-only = zero blur" ruling doesn't apply below 1); ≥1 stays integer
  (crisp NN upscale, byte-for-byte the old behavior). At Z<1 the backing
  store GROWS past the pane — more logical pixels, fixed-pixel icons/windows
  occupy a smaller fraction, more fits on a phone.
- Render mode follows the scale direction: `image-rendering: pixelated` for
  Z≥1 (unchanged), flipped to `auto` for Z<1 (`vt2ApplyRenderMode`) — a
  nearest-neighbor downscale would just drop pixels; smooth filtering of the
  oversampled render is what looks right (it's effectively supersampling).
- Backing-store ceiling `VT2_MAX_DIM = 8192` (WebGPU default
  `maxTextureDimension2D`; the compositor's `requestDevice()` takes the
  defaults): the EFFECTIVE divisor `vt2Eff = max(vt2Zoom, pane/8192)` is
  shared by `syncScreenSize` and the pointer seam (`mapX`/`mapY`, lock
  deltas), so a huge pane at 0.5 clamps to 8192 with the aspect and the
  coord map staying consistent. This also fixes the pre-existing >8192-px
  pane overflow at 1×.
- The persisted value moved `parseInt` → `parseFloat` with MEMBERSHIP
  validation — old `1`/`2`/`3` localStorage values load identically.

## The real-OS surface (the actual ask)

jku: "most OSs let you change the resolution in their control panel". So the
setting is an OS SETTING now:

- **Store**: cfgstore `display`, key `zoom` (`auto | 0.5 | 0.75 | 1 | 2 | 3`),
  three layers `~/.config/display` > `/etc/display` > `/usr/share/display`
  (baked layer is COMMENT-ONLY — see back-compat below). `os/display.h` is
  the saver.h-shaped header (dp_get/dp_set over cfgstore.h).
- **Applet**: Control Panel → Display (`ctlpanel.c`) replaced its 0049 stub
  with a "Screen Density" radio group — Automatic (default) / Largest (3x) /
  Larger (2x) / Native (1x) / Denser (0.75x) / Densest (0.5x) — radios apply
  on click (the Sounds-checkbox rule), delta-writing just the `zoom` key.
  Wallpaper still lands with todos/0049 (note kept in the applet).
- **Bridge (kernel→page, LIVE)**: two small embedder APIs in kernel.js:
  - `Kernel.watchPath(path, cb)` — an embedder-side path watch riding the
    SAME per-mutation FSW choke as FS_WATCH (no fd; queued records collapse
    into one deferred callback per settled batch).
  - `Kernel.notifySettled(path)` — an embedder-side kfs write announcing
    itself to watchers (the choke lives in the RPC dispatch, so direct
    embedder writes are otherwise invisible).
  kernel-worker resolves the three-layer overlay (JS twin of cfg_load3's
  per-key rule) and posts `{type:'display-config', zoom}` — once BEFORE
  'ready' (applied ahead of the VT2 auto-switch, no boot flash) and again on
  every settled write to any layer. An applet radio click therefore reflows
  the desktop immediately — the real-OS Apply feel, no reboot.
- **One source of truth**: the page's −/+ strip (and Desktop-site toggle)
  now ALSO persist through the store (`{type:'display-set'}` → worker
  delta-writes the user layer → notifySettled → the watch echoes the value
  back, idempotently). localStorage remains the page-local explicit-choice
  cache: instant pre-boot value, legacy store, migration source.

## Defaults & back-compat (deliberate)

- **Defaults unchanged**: absent key = `auto` = the old viewport rule
  (phone-shaped boots 2×, else 1×). The baked `/usr/share/display`
  deliberately ships NO `zoom` line: a baked `zoom auto` would make the
  worker always announce 'auto', which CLEARS a pre-bridge user's
  localStorage choice on image upgrade. Absent-key (`null`) instead lets the
  page keep honoring localStorage and MIGRATE it into the store once; an
  explicit user-layer `zoom auto` (the applet's Automatic) still wins
  everywhere, localStorage included.
- Config-sourced values apply WITHOUT write-back (`src === 'config'`) — no
  loops, and a hand-edited store value that snapped to the factor list is
  not "corrected" on disk.

## Tests

- `tests/browser/os-hires.mjs` (new): phone viewport — default-unchanged
  proof (auto-2×, no cfg file), the applet → store → watch → page live
  bridge to 0.5×, density asserts (backing doubles past the pane, more
  116px icon columns fit), smooth-vs-pixelated flip, the sub-1 pointer-seam
  Start-menu click, strip↔store sync (0.75 on disk), reload persistence,
  applet Automatic clearing everything, and the 8192 ceiling on a 4200px
  pane. Writes the before/after shots into this log dir.
- `test_ctlpanel_e2e.js`: Display-applet legs (radios present, `zoom 0.5`
  and `zoom auto` delta-writes).
- `os-harness.mjs` `sample()` now sizes its temp canvas to
  max(CSS rect, logical size) — at sub-1× the backing exceeds the rect and
  logical sample coords would otherwise read [0,0,0]. Superset of the old
  sizing, so existing tests are unaffected.

Image v162 (ctlpanel + the baked /usr/share/display comment file).
