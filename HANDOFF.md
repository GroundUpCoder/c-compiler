# Handoff — start of thread (updated 2026-07-09, after 0044 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0044 (interval timers: alarm/setitimer(ITIMER_REAL) → SIGALRM) landed
2026-07-09** — dev log `logs/2026-07-09/interval-timers.md`, design
recorded in KERNEL.md ("Interval timers" section + the opcode map). ONE
kernel-side real-time timer per process (`pcb.itimer`, a setTimeout);
expiry posts SIGALRM through `_deliver`, so disposition/blocking/EINTR/
DFL-terminate/pending-while-STOPPED all came for free. Wire ABI is
milliseconds over OP.SETITIMER/GETITIMER (0x000B/0x000C); the libc owns
timeval↔ms (nonzero sub-ms rounds UP — 0 means disarm, so an armed timer
must never convert to it). `it_interval` reloads from "now" (no SIGALRM
backlog — one SIGPEND bit anyway). VIRTUAL/PROF → EINVAL by design (no
CPU accounting); no kernel → ENOSYS stubs (alarm returns 0 — POSIX gives
it no error return). Timers are not inherited and die at exit. Delivery
stays cooperative (safe points — the settled 0001 compute-loop caveat
applies to SIGALRM too).

**Image bumped v32 → v33** (a libc change rebakes every baked binary),
`os/os-system.img` rebaked via `node tools/mkimage.js`.

**Suites this session**: kernel (all files, incl. the new
`test_itimer_e2e.js` and the test_kernel.js itimer section), blockfs
12/12, unit 699/0/3, and the full 10-file browser sweep after the v33
rebake (os-boots, os-wm, os-doom, os-gpubox, os-quake, os-term, os-vt,
os-screen, os-scale, os-shell).

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
fork bring-up, `0046` strace (kernel-POSIX batch remainder), networking
(0052/0053, NETWORK.md), the desktop wave (0047 → 0056 MVU toolkit →
0048, 0049, 0050), tail 0054/0051. (`0006` threads+atomics stays
deferred.)

## Gotchas carried forward

- **0044**: the itimer e2e's blocking-read leg NEEDS the brokered fs
  (`Kernel({fs})`) — in-process pipes can't park as a deferred FS_READ
  for SIGALRM to interrupt. And in test_kernel.js, real setTimeout
  drives expiry: keep generous margins (arm 50ms, assert at 150ms),
  booleans only, no exact deadlines.
- **Editing seeded sources or coreutils.json/bin.json requires bumping
  `os/image.json` `version`** (now 33) — a same-version blob is
  reused, and a LIBC change in compiler.js counts (baked binaries) —
  rebake `os/os-system.img` with `node tools/mkimage.js` after.
- **0055**: `copyExternalImageToTexture` destinations need
  `RENDER_ATTACHMENT` usage besides COPY_DST/TEXTURE_BINDING. WebGPU
  needs a secure context — probes on `about:blank` see no
  `navigator.gpu`; localhost is fine. Boot REQUIRES worker WebGPU:
  browser os tests launch Chromium with
  `--enable-unsafe-webgpu --enable-features=Vulkan`.
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
  (The 0044 libc additions did NOT move them — suite stayed 699/0/3.)
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS names `os-system.v5.img`/`os-root.v5.img` — those
  names are ALSO the Web Lock name (0045): renaming the images renames
  the lock with them (kernel-worker.js consts, single point).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal (the clearValue is
  WM_COLORS.desktop); SETTLE after VT switch; derive geometry from
  `__osScreen`/live canvas rect; keep the sweep serial; the taskbar
  strip row is button CHROME once windows are up; `cmd &; echo` is a
  hush parse error; `__osScreen` only tracks the viewport while VT2 is
  visible.
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
  wasm compile options host.js runModule ↔ kernel.js _moduleFor (0037);
  <sys/time.h> ITIMER_* ↔ kernel.js ITIMER_REAL (0044).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary (a libc/codegen change
  does).
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0055's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0044's no-VIRTUAL/PROF and cooperative-SIGALRM calls, 0055's
  no-fallback/no-maintenance-boot calls.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: the WebGPU app port, 0041 __gcstr, 0046 strace, or something
else."
