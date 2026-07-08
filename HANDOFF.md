# Handoff — start of thread (updated 2026-07-09, after 0039 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0039 (WM bug sweep round 2) landed 2026-07-09** — dev log
`logs/2026-07-09/wm-bug-sweep-2.md`. The sweep was clean except ONE real
find, fixed test-first (9a040a1 tests, 5798a0c fix): **the focus fall
skipped pinned furniture** — after 0038 the taskbar is always top of raw
z, so killing/minimizing the focused window parked keyboard focus on the
bar. `_wmFocusFall` (kernel.js, one helper for the destroy + minimize
sites) now prefers the topmost normal-layer window; furniture only takes
the fall when nothing else remains. No image bump (kernel.js is
host-side; image stays **v28**). 0038's layer invariant held under a
29-snapshot mechanical storm checker; Dawn+SIGKILL survived round 2
(both trials); gpubox adapter flake quiet two rounds. WM.md "Known
issues" re-dated; storm-authoring gotchas for round 3 are in the dev
log's findings ledger.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
BOTH sweep rounds (operator away at round-2 close). It is a MUST for
sweep round 3 — first free moment with a human at the keys: quake lock
on click, ESC unlock, click re-lock, VT-switch release.

**The day before (2026-07-08)**: 0034 coreutils batch 2 (66 /bin names),
0038 kernel z layers, 0040 read-only sealed /usr — see `todos/done/` and
the 2026-07-08 dev logs.

## The queue (todos/README.md is authoritative)

Next up: `0035` spawn-capable applets (find/xargs/awk/tar; drop
`PV_NO_INTERCEPT`, link the vfork shim into coreutils — 0034's
always-fail execvp in wasm_port.h marks the exact seam), then `0036`
seed the REPLs, `0037` wasm module cache, the WebGPU app port
(WEBGPU.md), `0041` __gcstr, `0042` wc fork bring-up. (`0006`
threads+atomics stays deferred indefinitely.)

## Gotchas carried forward

- **Editing seeded sources or coreutils.json requires bumping
  `os/image.json` `version`** (still 28) — a same-version blob is
  reused. Rebake `os/os-system.img` with `node tools/mkimage.js` after.
- 0034 config decisions (don't re-litigate casually): od is non-DESKTOP
  od; FEATURE_DATE_ISOFMT off; STAT_FILESYSTEM/SYNC_FANCY/
  DD_SIGNAL_HANDLING off; `env cmd` fails 126 by design until 0035.
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
  geometry from `__osScreen`/live canvas rect; keep the sweep serial.
  NEW from 0039: the taskbar strip row is button CHROME once windows
  are up (white bevels/black glyphs) — don't demand pure FACE; a
  taskbar button click on an UNFOCUSED window focuses (not minimizes);
  `cmd &; echo` is a hush parse error; `__osScreen` only tracks the
  viewport while VT2 is visible.
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c and vendor busybox/SDL sources — noise;
  those headers are compiler.js built-ins.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix (0034 and 0039
  both followed it; see 69d37f2, 9a040a1).
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js ↔ host.js; WMEV ↔
  <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js; SDL audio format
  words ↔ <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js;
  sealed-blob superblock fields host.js ↔ tests/blockfs/fsck_v4.js.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0039's decisions, DISK-IMAGE.md's settled layout.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0035 spawn-capable applets, or something else."
