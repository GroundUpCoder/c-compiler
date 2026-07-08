# Handoff — start of thread (updated 2026-07-08, after 0034 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0034 (coreutils batch 2) landed 2026-07-08** — dev log
`logs/2026-07-08/coreutils-batch2.md`. 37 new busybox applets in the
multicall (66 /bin names total): text filters (cut tr uniq tee nl od
paste fold tac comm), file ops (cmp du dd split truncate unlink readlink
realpath mktemp stat sync), misc (yes seq env expr date uname usleep
which cksum base64), hashes (md5sum sha1sum sha256sum), and hand-rolled
whoami/id/hostname stubs. Image is **v28**. Landed test-first for the
conformance bug it surfaced (`fn_compat_param_quals`, commit 69d37f2):
top-level param qualifiers wrongly participated in function type
compatibility (C11 6.7.6.3p15). Also fixed: the standalone Node-fs host
env ignored dup2-over-stdout (split(1) was the first to do it — write/
close/dup2 now route by entry flags like readImpl always did). libc
grew clock_settime (EPERM), sync() (no-op), getpagesize (64KiB),
mktemp/mkdtemp, fseeko/ftello, strftime %z/%s. All suites green at the
landing: unit 698✓, blockfs✓, kernel✓ (test_os_boot grew a batch-2
section), full serial browser sweep 10/10✓.

**Earlier the same day**: 0038 (kernel z layers) and 0040 (read-only
system image) — see `todos/done/` and the 2026-07-08 dev logs.

## The queue (todos/README.md is authoritative)

Next up: `0039` WM sweep round 2 (MUST include the pointer-lock HUMAN
check round 1 skipped + re-verifying 0038 under storm — try
`wmctl layer`/`raise`/`lower` combinations against the layer invariant),
then `0035` spawn-capable applets (find/xargs/awk/tar; drop
`PV_NO_INTERCEPT`, link the vfork shim into coreutils — 0034's
always-fail execvp in wasm_port.h marks the exact seam to replace),
`0036` seed the REPLs, `0037` wasm module cache, the WebGPU app port
(WEBGPU.md). (`0006` threads+atomics stays deferred indefinitely.)

## Gotchas carried forward

- **Editing seeded sources or coreutils.json requires bumping
  `os/image.json` `version`** (now 28) — a same-version blob is reused.
  Rebake `os/os-system.img` with `node tools/mkimage.js` to keep browser
  boots fast (gitignored, version-gated, but stale = slow first boot).
- 0034 config decisions (don't re-litigate casually): od is non-DESKTOP
  od (BSD flags, no `-A/-t`); FEATURE_DATE_ISOFMT off (no strptime —
  date.c carries a WASM PORT #if guard); STAT_FILESYSTEM/SYNC_FANCY/
  DD_SIGNAL_HANDLING off; `env cmd` fails 126 by design until 0035.
- Known limitations noted in the 0034 dev log: libc realpath doesn't
  resolve symlinks (returns normalized path); `date -u` display is
  local-tz (busybox sets TZ via putenv, libc ignores env); the
  STANDALONE Node bundle host OOMs when a writer keeps writing after
  its stdout reader exits (`node cu.js yes | head`) — in-OS kernel
  pipes EPIPE correctly (test leg exists).
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table`'s expected.compiler.stderr (lists stdlib switch
  lowerings) and `printf`'s pointer-address line. Updating them is
  routine — verify the test's OWN asserts are untouched first.
- **0040 layout in tests**: `ls /` is `bin dev etc root run tmp usr var`;
  headless images pair as `foo-system.img` + `foo-root.img`; OPFS names
  `os-system.v5.img`/`os-root.v5.img`.
- EROFS guards in host.js run AFTER the path walk — keep that ordering
  (escaping `/usr/local` paths depend on it).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal; SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial.
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- Headless applet note (obsolete since 0034): `cut` IS seeded now —
  wmctl-field extraction can use it, but existing tests still use `sed`.
- The IDE's clangd flags os/*.c and vendor busybox/SDL sources — noise;
  those headers are compiler.js built-ins.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix compiler bugs test-first: failing conformance test commit, then
  the fix (0034 followed it; see 69d37f2).
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js ↔ host.js; WMEV ↔
  <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js; SDL audio format
  words ↔ <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js;
  sealed-blob superblock fields host.js ↔ tests/blockfs/fsck_v4.js.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0038's decisions, DISK-IMAGE.md's settled layout.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0039 WM sweep round 2 (incl. the pointer-lock human check),
0035 spawn-capable applets, or something else."
