# Handoff — start of thread (updated 2026-07-09, after 0055 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0055 (WebGPU compositor, no Canvas2D fallback) landed 2026-07-09** —
dev log `logs/2026-07-09/webgpu-compositor.md`, design status updated in
WM.md ("Compositor" + the components/deviations lists). `os/compositor.js`
is now ONE WebGPU render pass per rAF: shm surfaces seq-gated
`writeTexture` into cached per-surface GPUTextures, gpu surfaces
`copyExternalImageToTexture` once per ImageBitmap (gpubox never touches a
CPU pixel end-to-end), chrome as flat quads over a 1×1 white texture,
title text + the close 'x' as cached label textures, rubber band as
dashed hairline quads, desktop fill = the pass clearValue. One pipeline
(host.js RENDER_WGSL shape), one persistent grown vertex buffer, draws
batched per contiguous texture run. `kernel-worker.js` probes
`navigator.gpu` → adapter → device BEFORE the 0045 boot lock; failure →
`{type:'boot-nogpu'}` → os.html guard screen (names the requirement, NO
retry button, `__osState === 'nogpu'`). Decisions NOT to re-litigate: no
Canvas2D fallback and no tty-only no-GPU maintenance boot (zombie-mode
reasoning, `logs/2026-07-09/webgpu-mvu-direction.md`); the item's
follow-ups (per-pixel alpha, blur/shadows, damage rects, cursor sprite)
ride this pass later.

**Suites this session**: kernel (all pass), blockfs (12/12), and the FULL
10-file browser sweep green UNMODIFIED — os-boots (one vi-leg flake,
clean on re-run — the known typed-chars race), os-wm, os-doom, os-gpubox,
os-quake, os-term, os-vt, os-screen, os-scale, os-shell. os-boots grew a
no-GPU guard leg (`--disable-features=WebGPU` → 'nogpu' + guard visible);
os-boots.mjs and os-term.mjs gained the standard
`--enable-unsafe-webgpu --enable-features=Vulkan` launch flags (they were
the two flagless sweep files; boot now REQUIRES a worker WebGPU device —
flagless headless Chromium gets no adapter). No image bump: only
page/worker scripts changed (still **v32**).

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
BOTH sweep rounds. It is a MUST for WM sweep round 3 — first free moment
with a human at the keys: quake lock on click, ESC unlock, click
re-lock, VT-switch release.

**Concurrent work note**: another session may be landing SS-INTEROP
slices (`todos/SS-INTEROP.md`, host.js .ss-module support). If host.js
shows uncommitted changes you didn't make, that's them — stage only your
own files.

## The queue (todos/README.md is authoritative)

Next up: the WebGPU app port (WEBGPU.md), `0041` __gcstr, `0042` wc
fork bring-up, the kernel-POSIX batch remainder (0044 timers/SIGALRM,
0046 strace), networking (0052/0053, NETWORK.md), the desktop wave
(0047 → 0056 MVU toolkit → 0048, 0049, 0050), tail 0054/0051. (`0006`
threads+atomics stays deferred.)

## Gotchas carried forward

- **0055**: `copyExternalImageToTexture` destinations need
  `RENDER_ATTACHMENT` usage besides COPY_DST/TEXTURE_BINDING (label +
  gpu-surface textures have it). WebGPU needs a secure context —
  probes on `about:blank` see no `navigator.gpu` at all; localhost is
  fine. Pixel tests read the desktop via `drawImage(placeholder)` —
  works identically over a WebGPU OffscreenCanvas.
- **Editing seeded sources or coreutils.json/bin.json requires bumping
  `os/image.json` `version`** (now 32) — a same-version blob is
  reused, and a LIBC change in compiler.js counts (baked binaries) —
  rebake `os/os-system.img` with `node tools/mkimage.js` after.
- **`ls /` goldens include `proc`** (test_os_boot.js, os-boots.mjs):
  `bin dev etc proc root run tmp usr var`.
- 0043: ProcFS must implement the FULL MountFS op surface — a new fs op
  added to MountFS needs a ProcFS twin (EROFS for mutators). procps
  parsers are single-read (1023 bytes) — keep per-file content < 1 KiB.
- 0037: when touching the spawn path, remember exactly ONE of
  `procSpec.image`/`procSpec.module` is non-null; compile options MUST
  MATCH between host.js runModule and kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): micropython emits `\r\n` itself and
  ONLCR doubles the `\r`; sqlite3 on a tty defaults to box-drawn tables;
  don't anchor pty markers on `\r\n` seams across multi-line writes.
- 0034/0035/0043 busybox config decisions are recorded in
  `vendor/busybox/README.md` — don't re-litigate casually. (kill.c's
  killall/killall5 un-guarding is a noted cheap follow-up there.)
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups".
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS names `os-system.v5.img`/`os-root.v5.img` — those
  names are ALSO the Web Lock name (0045): renaming the images renames
  the lock with them (kernel-worker.js consts, single point).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal (still true under WebGPU — the
  clearValue is WM_COLORS.desktop); SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial;
  the taskbar strip row is button CHROME once windows are up; `cmd &;
  echo` is a hush parse error; `__osScreen` only tracks the viewport
  while VT2 is visible.
- Browser tests that want a SECOND page must reckon with the 0045 lock:
  use fresh contexts/browsers for independent boots. The 0055 nogpu leg
  launches its own separate flag-disabled browser for the same reason.
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c and vendor busybox/SDL sources — noise;
  those headers are compiler.js built-ins.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix.
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js ↔ host.js; WMEV ↔
  <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js; SDL audio format
  words ↔ <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js;
  sealed-blob superblock fields host.js ↔ tests/blockfs/fsck_v4.js;
  wasm compile options host.js runModule ↔ kernel.js _moduleFor (0037).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary (a libc/codegen change
  does).
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0055's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0055's no-fallback/no-maintenance-boot calls.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: the WebGPU app port, 0041 __gcstr, or something else."
