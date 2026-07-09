# Handoff — start of thread (updated 2026-07-10, after 0057 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0057 (win32: gdi32 drawing subset, CPU → shm) landed 2026-07-10** —
dev log `logs/2026-07-10/win32-gdi32.md`, design `todos/WIN32.md`. The
Win32 veneer lives in `os/win32/` as an app-side lib.json library
(deps freetype; NO kernel/host/compiler change): `windows.h` +
`gdi32.c` — DCs (screen over the SDL surface, memory DCs over
HBITMAPs), objects + stock + leak counters (`__gdi_object_count`/
`__gdi_dc_count`), all 16 ROP2s, shapes with real GDI edge semantics
(right/bottom exclusive, LineTo excludes its endpoint), freetype text
(term's font; faceName ignored), BitBlt/StretchBlt/PatBlt (overlap
staged), GetDIBits/SetDIBits (32bpp BI_RGB, B<->R swizzle, bottom-up),
IntersectClipRect. HWND is the `__gdi_bind_hwnd(sdl_window)` scaffold
until 0058's user32 owns the real HWND tree — BeginPaint/GetClientRect
were written against the opaque handle so 0058 swaps innards only.
`/bin/gdidemo` seeded (windowed Petzold scene + `selftest` mode).
Deliberate omissions are listed in gdi32.c's header (no
CreateDIBSection/SaveDC/regions/dashed pens/bold synthesis) — grow them
under 0060's missing-symbol log, not speculatively.

**Image bumped v33 → v34** (new seeded binary + menu entry),
`os/os-system.img` rebaked via `node tools/mkimage.js`.

**Suites this session**: kernel (all files incl. the new
`test_gdi32_e2e.js`), blockfs 12/12, unit 699/0/3, browser: the new
`os-gdi.mjs` + the post-rebake sweep (results in the landing commit).

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: another session may be landing SS-INTEROP
slices (`todos/SS-INTEROP.md`, host.js .ss-module support). If host.js
shows uncommitted changes you didn't make, that's them — stage only your
own files.

## The queue (todos/queue.json is authoritative; README narrative)

Next up: `0058` user32 (windowing + controls + the HWND agent tree —
now unblocked), then `0060` OSS-port harness EARLY (its missing-symbol
log is the backlog for 0057–0059), `0059` kernel32, `0048` apps as
ReactOS ports; parallel tracks `0061` Cairo / `0062` zero-copy present /
`0063` Aero; `0046` strace, `0041` __gcstr → `0042` wc fork, networking
(`0052`/`0053`), `0064` WM sweep 3, tail `0049`/`0050`/`0054`/`0051`.

## Gotchas carried forward

- **0057**: `os/win32/lib.json` include ORDER is load-bearing —
  `vendor/freetype/demo` must precede `vendor/freetype/include` (demo's
  `ft2build.h` shadows the real one to select the minimal myftoption/
  myftmodule build; wrong order = 17 undefined `*_class` link errors).
  Every gdi32 write forces alpha 0xFF (the compositor samples alpha —
  0-alpha pixels show desktop through the window). COLORREF needs no
  swizzle against the surface (both R-low); DIBs do (B,G,R,X).
  `test_gdi32_e2e.js` probe coordinates MIRROR `gdidemo.c draw_scene` —
  change together (`os-gdi.mjs` too). Adding a `/usr/share/menu` entry
  changes the Start-menu geometry AND entry indices (sorted; rows 20px):
  `test_wm_service_e2e.js` + `os-shell.mjs` hardcode both — now 8
  entries, 150x168, winbox at click row y=154.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 34) — a same-version blob is
  reused, and a LIBC change in compiler.js counts (baked binaries) —
  rebake `os/os-system.img` with `node tools/mkimage.js` after.
- Queue changes go through `node todos/queue.js` ONLY (`done`, `add`,
  `reorder`); `check` must pass before committing (pre-commit hook
  enforces it once `git config core.hooksPath todos/githooks` is set).
- **0055**: `copyExternalImageToTexture` destinations need
  `RENDER_ATTACHMENT` usage besides COPY_DST/TEXTURE_BINDING. WebGPU
  needs a secure context; boot REQUIRES worker WebGPU: browser os tests
  launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`.
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
  `vendor/busybox/README.md` — don't re-litigate casually.
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups".
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
  (0057 touched no libc — suite stayed 699/0/3.)
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS names `os-system.v5.img`/`os-root.v5.img` — those
  names are ALSO the Web Lock name (0045): renaming the images renames
  the lock with them (kernel-worker.js consts, single point).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal; SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial;
  `cmd &; echo` is a hush parse error; `__osScreen` only tracks the
  viewport while VT2 is visible. A SECOND page needs a fresh
  context/browser (the 0045 boot lock).
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor busybox/SDL
  sources — noise; those headers are compiler.js built-ins or
  project-include-path resolved.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/` via
  `node todos/queue.js done NNNN`, dev log per landing, README next-up
  current.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix.
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js ↔ host.js; WMEV ↔
  <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js; SDL audio format
  words ↔ <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js;
  sealed-blob superblock fields host.js ↔ tests/blockfs/fsck_v4.js;
  wasm compile options host.js runModule ↔ kernel.js _moduleFor (0037);
  <sys/time.h> ITIMER_* ↔ kernel.js ITIMER_REAL (0044);
  test_gdi32_e2e.js/os-gdi.mjs probes ↔ os/win32/gdidemo.c draw_scene
  (0057).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary (a libc/codegen change
  does). The sweep now includes `os-gdi.mjs`.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0057's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0044's no-VIRTUAL/PROF and cooperative-SIGALRM calls, 0055's
  no-fallback calls, WIN32.md's Win32-as-primary-toolkit decision
  (microui/MVU are DROPPED) and 0057's recorded simplifications (grow
  via 0060's missing-symbol log, don't gold-plate).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0058 user32, standing up 0060's port harness early, 0046
strace, or something else."
