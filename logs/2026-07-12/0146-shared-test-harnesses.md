# 0146 — extract shared test harnesses (kernel boot-driver + browser harness)

**Date:** 2026-07-12
**Item:** todos/0146 (→ done). Follow-up: todos/0153.

## Why

The suite *runner* (`tests/lib/suite-runner.js`, `image-fixture.js`) was
already good. The debt was one layer down: every headless kernel `*_e2e.js`
re-implemented the same boot spawn inline, and every browser `os-*.mjs`
re-implemented the same serve+Chromium+page setup and pixel/tty helpers. That
copy-paste is why 0083 (event-wait — `wmctl wait` + a browser `waitFor`) had
nowhere single to land. 0146 extracts both seams so 0083 changes one place.

## What landed

### Kernel: `tests/kernel/lib/drive.js`

`driveBoot(script, opts)` is the one boot driver: mints a throwaway
`mkdtemp`+`os.img` (or reuses `opts.image` for multi-session A/B "cat the PPMs
back" tests), runs `node os/boot.js --image=<img> --quiet [...args]`, pipes the
script (string or array-of-lines, trailing newline guaranteed) on stdin, and
returns the raw `spawnSync` result — throwing on spawn error, so the ubiquitous
`if (r.error) throw r.error;` folds in. `freshImage(prefix)` exposes the
`{ dir, image }` pair for tests that keep their own image across sessions.
`section(out, name)` is the `==marker\n … ==` grep helper several e2es carried.

**27 files converted** (every one using the canonical single-shot
`spawnSync('node', [BOOT, '--image='+image, '--quiet'], …)`). Async paced-tty
sessions (`cp.spawn(..., '--tty-out')` in os_apps) were left byte-for-byte —
`driveBoot` is deliberately the single-shot seam only. Opts map faithfully:
`timeout` (default 300000, omitted when default), `maxBuffer` verbatim,
`encoding: null` for the raw-Buffer PPM cat-backs.

**Full kernel suite: 58 passed, 0 failed** (384.6s) — the verifiable half is
proven end-to-end, not just syntax-checked.

### Browser: `tests/browser/lib/os-harness.mjs`

Exports the setup building blocks — `osUrl`, `startServer` (pipes serve output
only when handed `onLog`, matching the sweep majority; os-boots taps it for its
`[serve]` prefix), `waitForServer` (poll, injectable `fetchFn` for tests),
`launchBrowser` (the `--enable-unsafe-webgpu --enable-features=Vulkan`
incantation), `makeCheck` (the `check`/`state.failures` scoreboard;
`stringify:false` for os-boots' raw extras) — plus per-page helpers
`osHelpers(page)` → `{ setVt, sample, near, waitPixel, waitOut, waitScreen }`
(byte-identical to the inline defs), the generic `waitFor(page, pred, …)` seam
0083 asked for, and an all-in-one `openOsSession`.

**Playwright is imported lazily** (inside `launchBrowser`), so the module and
its pure helpers load in plain Node without the operator's separate install —
which is what makes `tests/browser/lib/test-harness.js` (unit coverage for
`osUrl`/`near`/`makeCheck`/`waitForServer`) runnable here. It's green.

**All 23 `os-*.mjs` converted.** Byte-faithfulness was the rule, and the
divergences matter: files whose `near` uses tolerance **12** (os-gpubox,
os-paint), whose `sample`/`waitPixel` use the old `c.width` form instead of the
live-rect form (os-term, os-gpubox), whose `__osScreen` wait is width-only
(os-sounds) or lacks the `w>800` guard (os-doom, os-quake, os-term), or whose
`waitPixel` polls at 250 ms (os-saver) or takes an extra `tol` arg
(os-winmine) were **left inline** — extracting them would have changed pixel
tolerances or timing. Only the exact-match shapes were pulled into `osHelpers`.
Retry-count quirks preserved (os-fileman/ctxmenu/recycle 240×500ms;
os-sounds 600×200ms).

## Verification & the one gap

- Kernel: full suite green (the real proof).
- Browser: every file `node --check`-clean; no leftover `playwright`/`spawn`/
  `chromium.launch`/bare `failures`; harness pure helpers unit-tested.
- **Not run: the browser sweep** — Playwright isn't installed in this clone (the
  browsers are cached but the package isn't; it's not even a repo dep — the
  browser tier has always been operator-owed). The conversion is static-verified
  and byte-faithful, but a real `os-sweep.mjs` pass is the last mile. Filed as
  **todos/0153** (P1) so the runtime confirmation is explicitly owned rather than
  silently riding 0064's WM-scoped sweep. This is the standing browser-tier gap,
  not new un-runnability introduced by 0146.

## Notes / decisions

- Convention: unused `require`s (`cp`/`os`) were left in the converted kernel
  files rather than pruned — minimizes churn/risk across 27 files; harmless.
- `ROOT` kept where still used (host.js/vendor/os-common paths), removed where
  it only fed `BOOT`. No dangling `ROOT`/`BOOT` refs (grep-verified).
- The mechanical fan-out ran as 5 kernel + 4 browser subagents over disjoint
  file sets; each returned its per-file report and I ran the integrity sweep +
  the kernel suite centrally.
