# Browser tests

Run our compiled wasm binaries in real browsers: **headless Chromium** (via
Playwright) and **genuine system Safari** (via `safaridriver` + Selenium — the
faithful proxy for what ships on iOS). Standalone npm project — not integrated
with `tests/run.py`. Run manually when you want end-to-end browser validation;
CI integration can come later.

See **"Real Safari"** below for the safaridriver setup and the two Safari
gotchas (an asleep display ⇒ black screenshots; canvas content isn't captured by
WebDriver screenshots at all — read it back with `convertToBlob` instead).

## What earns a persistent browser leg (the selectivity rule)

Browser sweep files are the slowest, flakiest tier in the estate — each leg
must pay for the page it drags in. **A new `os-*.mjs` leg is justified only
by something a headless kernel e2e (`tests/kernel/*_e2e.js`) cannot
observe:**

- composited pixels (the WebGPU compositor's actual output);
- the page input path (typing through the real xterm, keyboard/pointer
  through os.html's bridge, pointer lock);
- audio reaching the page (`window.__osAudio`, the output-ring SAB);
- OPFS persistence / reload / boot-lock / VT semantics — page lifecycle.

Everything else — process/fs/tty semantics, WM *policy*, win32 app logic,
file ops — belongs in the kernel suite: deterministic, parallel, no browser.
When a flow needs both (e.g. fileman ops), the kernel e2e carries the full
matrix and the browser leg asserts only the thin visual/input slice on top.

House rules for the legs that do qualify (the 0083/0171 lessons):

- **No fixed sleeps** — wait on markers: `waitOut` tty needles, `wmctl
  list`/`tree`/agent state, `waitPixel`. A `pause(400)` is a latent flake.
- **Shell-typed needles must use the split-string trick** (`echo S""NT-1`,
  wait for `SNT-1`) or the wait matches its own typed echo instantly.
- After any typed command whose *effect* you assert later, wait for its
  completion marker before moving on — a lost line under load is otherwise
  indistinguishable from a product hang (the 0171 class).
- Derive geometry/lists from live state (`__osScreen`, `wmctl list`,
  image.json), never constants (0166 rule; kernel-cascaded dialogs).

## What's here

| Path | What |
|---|---|
| `package.json` | Playwright dep + run scripts |
| `build-quake.mjs` | Compiles `vendor/quake/src/*.c` into `www/quake.wasm`, copies pak0.pak and host.js |
| `server.mjs` | Minimal Node static server with COOP/COEP headers (required for OPFS + SharedArrayBuffer) |
| `www/quake.html` | Page with `<canvas>`; spawns the worker that boots quake.wasm |
| `www/quake-worker.js` | Worker: mounts pak0.pak into a BLOCK_FS image (single OPFS file), boots quake.wasm |
| `quake-renders.mjs` | The actual test: open page → wait for Host_Init → wait 3 s → screenshot canvas → assert it has color |
| `build-doom.mjs` | Compiles `vendor/doom/bin.json` into a **self-contained** emitted page `www/doom.html` (BLOCK_FS backend). doom1.wad is bundled via the project's `dataFiles`. |
| `doom-renders.mjs` | Opens the emitted Doom page, clicks the "Click to Start" overlay, waits for the canvas to render, screenshots `#canvas`, asserts ≥10% non-black. Takes `<page.html> [out.png]`. |
| `safari-renders.mjs` | **Real Safari** (safaridriver+Selenium) driver for the same DOOM/Quake pages. Navigates, clicks start (DOOM) / waits for `Host_Init` (Quake), screenshots, dumps COI/SAB/OPFS + the page's log panels. `node safari-renders.mjs <doom\|quake> [out.png]`. |
| `oc-probe-run.mjs` + `www/oc-probe.html` | Minimal **OffscreenCanvas capability probe**: a main-thread canvas (red) and a worker-transferred OffscreenCanvas drawn via `putImageData` (green) — the exact path host.js's SDL backend uses. Reports pixel **read-back** and **`convertToBlob` extraction** so it works even when screenshots can't. `node oc-probe-run.mjs <chromium\|safari>`. |
| `quake-extract.mjs` | Pulls **actual Quake frames out of Safari** display-independently: the worker `convertToBlob()`s its OffscreenCanvas and the page exposes the latest as `window.__quakeFrame`; this polls + saves `quake-safari-extracted.png`. |
| `os-sweep.mjs` | **The OS sweep as one command** (todos/0081): runs every `os-*.mjs` below serially (0045 boot lock + contention make concurrent boots flaky by design) via `tests/lib/suite-runner.js` — per-file logs + an incrementally checkpointed `summary.json` in `../../build/test-browser/`, per-file timeout with process-group kill, `--filter`/`--resume`/`--fail-fast`. New `os-*.mjs` files join the sweep automatically. Startup runs a leak pre-flight (`tests/lib/harness-leaks.js`) after the heavy lock: abandoned `$TMPDIR/os-*` fixture dirs and orphaned `serve.js`/Chromium from killed runs are listed and reaped, and any surviving stray `serve.js` is named BEFORE the run — a squatted fixed port otherwise hands a test a stale server and reads as a product regression. `node os-sweep.mjs`. |
| `os-harness-unit.mjs` | **Unit coverage for `lib/os-harness.mjs`'s pure helpers** (todos/0146; enrolled by #431): `osUrl`, `near`, `makeCheck`, `wmctlTimeoutHits`, `waitForServer` against an injected fetch. The one sweep member that launches no browser — it is here rather than in `lib/` so the `os-*.mjs` discovery glob picks it up, because as `lib/test-harness.js` it belonged to no suite, went red on main when `osUrl` grew `hostkeys=off`, and nothing reported it. `node os-harness-unit.mjs`. |
| `os-boots.mjs` | **The reference OS page** (`os/os.html`, todos/0004): serves the repo root with serve.js (COOP/COEP), boots the OS in headless Chromium over a fresh OPFS, types into the real xterm path (`ls /`, `cc hello.c && ./a.out`), reloads to prove image persistence, `exit 3` to prove halt propagation. Polls the page's `window.__osOut`/`__osState` agent probe. `node os-boots.mjs`. |
| `os-wm.mjs` | **WM acceptance on the OS page** (todos/0013+0014): `winbox &` from the in-browser shell, then drives its window through the real UI-bridge path — asserting composited desktop pixels for the wm-autostarted taskbar, WM placement, focus chrome, taskbar minimize/restore, client click/key, title drag, close box, and `wmctl` from the shell. `node os-wm.mjs`. |
| `os-doom.mjs` | **Windowed vendor apps on the OS page** (todos/0015): first boot seeds doom/gameboy/snake + game data (image.json `bin` entries), then `doom &` — asserts a real composited frame (color histogram), Escape reaching the app, attract-demo motion, clean quit via `wmctl close` (the literal close-box click is covered by os-wm.mjs), and the gameboy+ROM lifecycle. DOOM presents at native 640x400 (no CPU pre-scale — 0024 compositor scaling). `node os-doom.mjs`. |
| `os-vt.mjs` | **VT switching on the OS page** (todos/0022 + 0070): boot streams on VT1, a healthy boot lands on VT2 (the desktop default tab), the Terminal/Desktop tab bar (primary) + Ctrl+Alt+F1/F2 (alias) flip between tty and desktop (exactly one visible), shell stays usable mid-doom and after `kill`ing the wm service (kernel-chrome fallback — the availability rationale), halt and boot-error force VT1. `node os-vt.mjs`. |
| `doom-debug.mjs` | Diagnoses the emitted DOOM page on Safari: injects a pre-load instrument that wraps `Worker` to capture its `error`/`messageerror` + window errors into `window.__dbg`, then dumps them. (Used to confirm the emitted page boots fine on Safari — the earlier "won't boot" was just an asleep display.) |

`www/quake-worker.js` / `www/quake.html` carry a small **frame-capture
instrument** for the Safari extraction path: the worker `convertToBlob()`s its
OffscreenCanvas every 1.5 s and posts `{type:'frame', png}`; the page exposes the
latest as `window.__quakeFrame`. Harmless to the Chromium test.

Build artifacts under `www/` (`quake.wasm`, `pak0.pak`, `host.js`,
`doom.html`, generated `doom-debug.html`) and the screenshot/extracted PNGs
(`shot-*`, `oc-*`, `*-safari.png`, `*-extracted.png`) are gitignored; regenerated
by the scripts.

## Doom: BLOCK_FS

Both tests use the **BLOCK_FS** backend (a single OPFS file). The Quake worker
mounts pak0.pak into a block image directly; the Doom test drives the
**compiler-emitted `.html` page**, whose filesystem backend is BLOCK_FS — the
only browser filesystem backend (the legacy full-OPFS backend was removed).

```sh
pnpm run doom          # build the page + screenshot it
# or individually:
pnpm run build:doom
pnpm run test:doom
```

The page renders the shareware Doom title screen / attract demo (≥10%
non-black pixels). The screenshot lands at `shot-blockfs.png`.

## Usage

```sh
cd tests/browser
pnpm install --frozen-lockfile     # Playwright, one-time — see "Pinned deps" below
pnpm exec playwright install chromium   # explicit browser install
pnpm run build:quake               # compile and stage
pnpm run test:quake                # boot in headless Chromium and assert
# Or build + test in one shot:
pnpm test
```

`pnpm exec playwright install chromium` fetches the Chromium binary
(~150 MB) into Playwright's shared browser cache. If you'd rather use a
system Chrome, set `PLAYWRIGHT_BROWSERS_PATH=0` before that command
and configure Playwright to look for an existing browser.

### Pinned deps — always `--frozen-lockfile`

`package.json` names **exact** versions (playwright 1.61.0,
selenium-webdriver 4.45.0) and `pnpm-lock.yaml` is **committed**. Both are
deliberate: this tier gates the whole `os-*.mjs` sweep, and it used to be a
caret range over a gitignored lockfile. A plain `pnpm install` in a fresh
worktree therefore re-resolved to whatever was newest — on 2026-07-26 that was
playwright 1.62.0, which wants a Chromium build that was not in the local
cache, and every one of the 39 sweep files failed at launch. Thirty-nine
spurious FAILs that read like an OS regression.

Two guards now:

- `pnpm install --frozen-lockfile` installs exactly the lockfile (a drifted
  `package.json` makes the install fail instead of silently re-resolving).
- `launchBrowser` in `lib/os-harness.mjs` compares the **resolved** playwright
  against the pin and throws a named error before Chromium is touched, so a
  drifted install names itself instead of masquerading as 39 product failures.
  Bypass with `CC_NO_PLAYWRIGHT_PIN=1` when deliberately trying another version.

To move the pin: bump the exact version in `package.json`, run `pnpm install`
(unfrozen, once) to refresh the lockfile, `pnpm exec playwright install
chromium`, and commit both files together.

## What the test asserts

1. **The page loads** and `Host_Init` prints (via the `window.quakeBoot`
   promise the HTML sets up).
2. After 3 seconds of real time, **the 320×200 canvas has color**:
   ≥95% opaque pixels and ≥10% non-black. Quake's console alone fills
   more than that; the attract-mode demos add a lot more.
3. A screenshot is saved to `last-screenshot.png` for eyeballing.

The 10% non-black threshold is intentionally loose — we're trying to
distinguish "the wasm crashed and the canvas is fully black" from "the
game is drawing something." A pixel-accurate golden-image comparison
could come later; it's brittle for a game with running demos.

## Real Safari (safaridriver + Selenium)

Why: Playwright's `webkit` is WebKit **trunk** (carries features no shipping
Safari has, e.g. JSPI) and can't drive Apple's Safari anyway. To see what really
ships — the faithful proxy for iOS Safari of the same major — drive the genuine
system Safari via Apple's WebDriver. Selenium talks W3C WebDriver to
`safaridriver`; Playwright can't.

**One-time setup** (a deliberate Apple gate; needs a real terminal):

```sh
sudo safaridriver --enable        # or Safari → Settings → Developer → Allow Remote Automation
pnpm install                      # selenium-webdriver (no browser download — Safari is the OS)
```

**Run** (build the demos first with `build:quake` / `build:doom`):

```sh
pnpm run test:safari-quake        # Quake in real Safari
pnpm run test:safari-doom         # the emitted Doom page in real Safari
pnpm run probe:oc-safari          # OffscreenCanvas capability probe
pnpm run extract:quake-safari     # save an actual Quake frame → quake-safari-extracted.png
pnpm run probe:oc                 # the same OffscreenCanvas probe on Chromium (baseline)
```

### Gotcha 1 — the display must be awake

`safaridriver` drives a real on-screen Safari window through the macOS window
server. If the mac mini's display is **asleep** (`system_profiler
SPDisplaysDataType` → "Display Asleep: Yes"), every `takeScreenshot()` comes back
**fully black** — page background, text, everything — and the worker's
OffscreenCanvas work stalls (the page looks like it never boots). This is **not**
a render failure. The `pnpm run` scripts above already wrap the run in
`caffeinate` to wake and hold the display:

```sh
caffeinate -u -t 2; caffeinate -du node <script>
```

(`-u -t 2` pulses user-activity to wake the screen; `-du` then keeps it awake for
the run.) Without an attached/awake display there is no way to get pixels via the
screenshot path — use the read-back path below.

### Gotcha 2 — WebDriver can't screenshot `<canvas>` on Safari

Even with the display awake, `safaridriver` screenshots capture the page DOM but
**not the GPU-accelerated canvas layer** — a rendered game canvas shows up blank
in `takeScreenshot()`. So screenshots are useless for verifying canvas rendering
on Safari. Read the **backing store** instead — it's display- and
screenshot-independent and is what the SDL path actually wrote:

- main-thread canvas: `ctx.getImageData(x,y,w,h)` or `canvas.toDataURL()`.
- worker-transferred OffscreenCanvas (what SDL uses): inside the worker,
  `await offscreen.convertToBlob()` → `arrayBuffer` → base64 → `postMessage`; the
  page exposes it and Selenium writes the PNG. This is exactly what
  `quake-extract.mjs` + the `quake-worker.js`/`quake.html` instrument do.

### What this established (2026-06)

Driving Safari 26.5 this way: `coi=true`, `SharedArrayBuffer` present, OPFS works.
The **no-JSPI SDL render path (worker OffscreenCanvas + `putImageData`) renders
correctly on Safari** — verified by pixel read-back on the probe and by
extracting a real Quake gameplay frame. Both DOOM (emitted self-contained page)
and Quake boot and run on Safari. The only Safari-specific limitation is cosmetic
(the two screenshot gotchas above), not a rendering or engine problem.
