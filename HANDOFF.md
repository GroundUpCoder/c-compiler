# Handoff — start of thread (updated 2026-07-09, after 0045 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0045 (two-tab boot guard) landed 2026-07-09** — dev log
`logs/2026-07-09/two-tab-boot-guard.md`. kernel-worker.js takes a Web
Lock named after the OPFS image pair (`wasm-os:os-system.v5.img+
os-root.v5.img`) BEFORE any mount, `ifAvailable` + a forever-pending
callback to hold it for the tab's lifetime; a losing tab gets
`boot-locked` → os.html's guard screen + Retry (`boot-retry` message,
`booting` flag makes over-clicking harmless; `__osState === 'locked'`
is the probe). A HALTED tab still holds the lock (worker alive until
close) — deliberate, and the new os-boots.mjs legs assert it. Headless
`boot.js` stays unguarded by design (flock follow-up noted in the
item). No image bump — no seeded source changed.

**0035 (spawn-capable applets) landed 2026-07-09** — dev log
`logs/2026-07-09/spawn-applets.md`; /bin is 75 multicall names, the
multicall links the vfork shim, tar -z / find -exec / xargs / awk
system() really spawn. **Image v30.**

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
BOTH sweep rounds. It is a MUST for WM sweep round 3 — first free moment
with a human at the keys: quake lock on click, ESC unlock, click
re-lock, VT-switch release.

**Concurrent work note**: another session is landing SS-INTEROP slices
(`todos/SS-INTEROP.md`, host.js .ss-module support). If host.js shows
uncommitted changes you didn't make, that's them — stage only your own
files.

## The queue (todos/README.md is authoritative)

Next up: `0036` seed the REPLs (lua/micropython/sqlite3 — measure
sqlite's seed cost first), then `0037` wasm module cache, the WebGPU
app port (WEBGPU.md), `0041` __gcstr, `0042` wc fork bring-up, the
kernel-POSIX batch (0043/0044/0046), networking (0052/0053,
NETWORK.md), the desktop wave (0047→0048→0049, 0050). (`0006`
threads+atomics stays deferred.)

## Gotchas carried forward

- **Editing seeded sources or coreutils.json/bin.json requires bumping
  `os/image.json` `version`** (now 30) — a same-version blob is reused,
  and a LIBC change in compiler.js counts (baked binaries) — rebake
  `os/os-system.img` with `node tools/mkimage.js` after.
- **busybox.config changes**: regenerate via /tmp/busybox-1.37.0
  kconfig (`conf -o` + `conf -s` — the built `scripts/kconfig/conf` is
  still there), then re-apply the two WASM PORT hand-patches to
  autoconf.h (exec-path "/bin/sh", NOMMU comment).
- 0034/0035 busybox config decisions are recorded in
  `vendor/busybox/README.md` — don't re-litigate casually.
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups": lexical-only BlockFS-env
  realpath, TZ ignored (`date -u` shows local), standalone Node bundle
  OOM when a writer outlives its stdout reader.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
- **0040 layout in tests**: `ls /` is `bin dev etc root run tmp usr var`;
  headless images pair as `foo-system.img` + `foo-root.img`; OPFS names
  `os-system.v5.img`/`os-root.v5.img` — those names are now ALSO the
  Web Lock name (0045): renaming the images renames the lock with them
  (kernel-worker.js consts, single point).
- EROFS guards in host.js run AFTER the path walk — keep that ordering
  (escaping `/usr/local` paths depend on it).
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
  invariants, 0013–0040's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0036 seed the REPLs, or something else."
