# Handoff — start of thread (updated 2026-07-09, after 0035 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0035 (spawn-capable applets) landed 2026-07-09** — dev log
`logs/2026-07-09/spawn-applets.md`. find/xargs/awk/tar/gzip/gunzip/zcat/
less/diff are in the multicall, which now LINKS THE VFORK SHIM:
`port/spawn_helpers.c` hand-rolls libbb's spawn()/spawn_and_wait() over
pv_* (upstream vfork_daemon_rexec.c needs kbuild applet tables), and
`pv_execve` grew a bare-exec emulation (empty journal + wait + exit) so
`env cmd` execs for real — the 0034 "env-exec=126" test leg flipped to
0. tar -z works both directions (create spawns gzip; extract re-execs
`gunzip -cf -` NOMMU-style). /bin is 75 multicall names. **Image v30.**

The round's compiler bug (every busybox batch finds one): a declaration
between `switch (...) {` and the first `case` lost its wasm local —
awk.c does this. Fixed test-first (e590dbd test, e501702 fix,
`tests/unit/conformance/switch_decl_before_case`). libc grew `sched.h`
(no-op sched_yield, for less). Deliberate config decisions recorded in
`vendor/busybox/README.md`: FEATURE_ALLOW_EXEC=y (awk system() is
silently a no-op without it!), USE_PORTABLE_CODE=y (find's VLA →
alloca), TAR_TO_COMMAND off (+#if guard — address-taken refs survive
if(0) DCE), UNAME_GNAME off (root/root stubs).

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
BOTH sweep rounds. It is a MUST for WM sweep round 3 — first free moment
with a human at the keys: quake lock on click, ESC unlock, click
re-lock, VT-switch release.

**Concurrent work note**: another session is landing SS-INTEROP slices
(`todos/SS-INTEROP.md`, host.js .ss-module support). If host.js shows
uncommitted changes you didn't make, that's them — stage only your own
files.

## The queue (todos/README.md is authoritative)

Next up: `0045` two-tab boot guard (Web Locks on the OPFS images), then
`0036` seed the REPLs, `0037` wasm module cache, the WebGPU app port
(WEBGPU.md), `0041` __gcstr, `0042` wc fork bring-up, the kernel-POSIX
batch (0043/0044/0046), networking (0052/0053, NETWORK.md), the desktop
wave (0047→0048→0049, 0050). (`0006` threads+atomics stays deferred.)

## Gotchas carried forward

- **Editing seeded sources or coreutils.json/bin.json requires bumping
  `os/image.json` `version`** (now 30) — a same-version blob is reused,
  and a LIBC change in compiler.js counts (baked binaries) — rebake
  `os/os-system.img` with `node tools/mkimage.js` after.
- **busybox.config changes**: regenerate via /tmp/busybox-1.37.0
  kconfig (`conf -o` + `conf -s` — the built `scripts/kconfig/conf` is
  still there), then re-apply the two WASM PORT hand-patches to
  autoconf.h (exec-path "/bin/sh", NOMMU comment).
- 0034 config decisions (don't re-litigate casually): od is non-DESKTOP
  od; FEATURE_DATE_ISOFMT off; STAT_FILESYSTEM/SYNC_FANCY/
  DD_SIGNAL_HANDLING off. 0035's are listed above.
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups": lexical-only BlockFS-env
  realpath, TZ ignored (`date -u` shows local), standalone Node bundle
  OOM when a writer outlives its stdout reader.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
- **0040 layout in tests**: `ls /` is `bin dev etc root run tmp usr var`;
  headless images pair as `foo-system.img` + `foo-root.img`; OPFS names
  `os-system.v5.img`/`os-root.v5.img`.
- EROFS guards in host.js run AFTER the path walk — keep that ordering
  (escaping `/usr/local` paths depend on it).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal; SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial;
  the taskbar strip row is button CHROME once windows are up; a taskbar
  click on an UNFOCUSED window focuses; `cmd &; echo` is a hush parse
  error; `__osScreen` only tracks the viewport while VT2 is visible.
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c and vendor busybox/SDL sources — noise;
  those headers are compiler.js built-ins.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix (0034, 0039,
  0035 all followed it; see e590dbd → e501702).
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js ↔ host.js; WMEV ↔
  <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js; SDL audio format
  words ↔ <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js;
  sealed-blob superblock fields host.js ↔ tests/blockfs/fsck_v4.js.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary (a libc/codegen change
  does).
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0040's decisions, DISK-IMAGE.md's settled layout.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0045 two-tab boot guard, or something else."
