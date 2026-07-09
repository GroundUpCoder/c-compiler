# Handoff — start of thread (updated 2026-07-09, after 0043 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0043 (procfs + the process tools) landed 2026-07-09** — dev log
`logs/2026-07-09/procfs.md`, design note in KERNEL.md ("/proc — the
synthetic procfs"). `ProcFS` (kernel.js) renders the live process table
as a read-only MountFS volume in Linux formats; both embedders mount it
at `/proc` and the Kernel constructor auto-binds via the mount table.
Coreutils batch 4 — **ps top pgrep pkill uptime free** — parses it
unmodified (procps sources newly vendored from /tmp/busybox-1.37.0 +
three WASM PORT patches; `sysinfo()` lives in port/libbb_stubs.c and
reads /proc itself). libc grew `getsid()` over a new `OP.GETSID`
(0x000A). Image is **v32** (new symlinks + libc change → full rebake;
`os/os-system.img` re-baked via mkimage). Design points NOT to
re-litigate: utime/stime are 0 by design (workers run on their own OS
threads — top's %CPU is boring on purpose); VmSize/RSS/meminfo are
nominal constants; no `/proc/self` (fs ops carry no caller pid).

**Suites this session**: kernel (incl. new
`tests/kernel/test_procfs.js`, 47 checks), blockfs, unit (699), and the
FULL 10-file browser sweep — see the session's final report for the
sweep result. `test_os_boot.js` grew a procps section; its `ls /`
golden and os-boots.mjs's `ls -1 /` needle both gained `proc`.

**Cheap follow-up noted, not queued**: kill.c's killall/killall5 guards
predate working /proc scanning — un-guarding them is now easy
(`vendor/busybox/README.md` patch table notes it).

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
(0047→0048→0049, 0050), tail 0054/0051. (`0006` threads+atomics stays
deferred.)

## Gotchas carried forward

- **Editing seeded sources or coreutils.json/bin.json requires bumping
  `os/image.json` `version`** (now 32) — a same-version blob is
  reused, and a LIBC change in compiler.js counts (baked binaries) —
  rebake `os/os-system.img` with `node tools/mkimage.js` after.
- **`ls /` goldens now include `proc`** (test_os_boot.js, os-boots.mjs):
  `bin dev etc proc root run tmp usr var`. MountFS materializes the
  /proc mount-point dir on the root volume at construction, so existing
  root images grow it with no reseed.
- 0043: ProcFS must implement the FULL MountFS op surface — a new fs op
  added to MountFS needs a ProcFS twin (EROFS for mutators). `_render`
  dispatches pid files BEFORE root files (both trees have a `stat`).
  procps parsers are single-read (`read_to_buf`, 1023 bytes) — keep
  per-file content under 1 KiB.
- **busybox.config changes**: regenerate via /tmp/busybox-1.37.0
  kconfig (`conf -o` + `conf -s`), then re-apply the two WASM PORT
  hand-patches to autoconf.h (exec-path "/bin/sh", NOMMU comment) and
  the "1.37.0" version header lines (kconfig outside kbuild loses them).
- 0037: when touching the spawn path, remember exactly ONE of
  `procSpec.image`/`procSpec.module` is non-null; compile options MUST
  MATCH between host.js runModule and kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): micropython emits `\r\n` itself and
  ONLCR doubles the `\r` (`42\r\r\n`); sqlite3 on a tty defaults to
  box-drawn tables (`.mode list` for bare values); don't anchor pty
  markers on `\r\n` seams across multi-line writes.
- 0034/0035/0043 busybox config decisions are recorded in
  `vendor/busybox/README.md` — don't re-litigate casually.
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups": lexical-only BlockFS-env
  realpath, TZ ignored (`date -u` shows local), standalone Node bundle
  OOM when a writer outlives its stdout reader.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS names `os-system.v5.img`/`os-root.v5.img` — those
  names are ALSO the Web Lock name (0045): renaming the images renames
  the lock with them (kernel-worker.js consts, single point).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal; SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial;
  the taskbar strip row is button CHROME once windows are up; a taskbar
  click on an UNFOCUSED window focuses; `cmd &; echo` is a hush parse
  error; `__osScreen` only tracks the viewport while VT2 is visible.
- Browser tests that want a SECOND page must reckon with the 0045 lock:
  a same-context page2 hits the guard while page1 lives (that's the
  point); use fresh contexts/browsers for independent boots.
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
  invariants, 0013–0043's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: the WebGPU app port, 0041 __gcstr, or something else."
