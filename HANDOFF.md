# Handoff — start of thread (updated 2026-07-10; 0046 strace closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0046 (strace: per-pid syscall-RPC trace) is CLOSED** — dev log
`logs/2026-07-10/0046-strace.md`, durable design in `todos/KERNEL.md`
"strace" section + `todos/done/0046-strace.md`. Load-bearing facts:

- **The trace sink is a tracer-owned pipe OFD**: `__spawn_spec` grew a
  `trace` field (pipe WRITE-end fd in the parent's table), host-read
  ONLY under spawn flags bit1 (`__SPAWN_TRACE`) so pre-growth binaries
  can't set it by accident; bit2 (`__SPAWN_TRACE_CHILDREN`) = strace
  `-f` (descendants inherit the pipe, `[pid N]` prefixes). The kernel
  holds its OWN write-end ref → the tracer's read end EOFs exactly at
  tracee teardown.
- **Requests format EAGERLY at dispatch** (`pcb.trace.cur`): RAW
  payloads alias the kernel page, which the response reuses. Lines land
  at `_respond`/`_respondRaw`; deferred RPCs trace at completion;
  mid-RPC death prints `= <unfinished>`. `--- SIGxxx ---` at
  `_deliver`, `+++ exited/killed +++` at `_exitProcess`.
- **The kernel never blocks on the trace pipe**: past-cap lines drop and
  a counted marker (force-written past the cap, like the exit markers)
  reports it at exit.
- **The decode table IS kernel.js's OP map** (`OP_NAMES`) — a new opcode
  traces by construction; KERNEL.md's opcode table stays authoritative.
- `/bin/strace [-f] [-o FILE] cmd args...` (`os/strace.c`) is seeded;
  image version is **v47**. Spec builders in-tree (posix_spawn header,
  busybox vfork shim, win32 kernel32 CreateProcess) set `trace = -1`
  for hygiene.

**No residue, no new queue items**: the item's optional `-f` landed too;
nothing descoped.

**Tests after the change**: kernel suite **44/44** (includes the new
`test_strace.js` + `test_strace_e2e.js`), unit 702/702; browser sweep
untouched by this change (no WM/compositor/browser surface — kernel RPC
plane + one new seeded CLI binary only).

**Next in queue**: run `node todos/queue.js list` — 0041 (gcstr) leads.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0046): `wc`-style trace asserts must match the child's fd
  table** — trace lines show KERNEL fd numbers (which are the child's);
  strace's own pipe fds never appear (spawn spec CLOSEs them in the
  child). A parked tracer read is served by `_traceLine`'s
  `_pipeNotify` re-entry — don't "simplify" that away.
- **0063: drop shadows are real desktop pixels** — a chromed window
  darkens ~17px beyond its frame (14 reach + 3 drop). Browser TEAL/pixel
  asserts near a frame must sample ≥ ~25px out (os-wm, os-scale,
  os-aero show the pattern). Borderless surfaces cast none.
- **0063: a translucent client blends over the chrome frame PLATE
  (FACE 192), not the desktop** — 50%-alpha blue reads [96,96,224].
- **0063: `wmctl list` FLAGS is 7 chars** (`A` = has-alpha at [5],
  layer T/B at [6]).
- **0063: wm.c's peek keeps `peek_pending` across dismiss** — an
  in-flight THUMB reply must still be consumed off the socket.
- 0075: SameBoy compiles with `-DGB_INTERNAL` everywhere; MIN/MAX are
  plain ternaries — keep call sites side-effect-free. `GB_random` seeds
  lazily — don't pixel-match frames depending on uninit CGB palette RAM.
- **0072**: `wmctl click LABEL`/`settext` take the FIRST win32 app that
  accepts the label — sequence agent-driven test legs accordingly.
- **0072**: `strncasecmp`/`strcasecmp` live in `<strings.h>` here.
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082 gate): land the
  edit, re-run; or run mkimage first. `.md` files and `tests/` are NOT
  bake inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are.
- **New-runner habits**: after an interrupted/failed suite run, look at
  `build/test-*/summary.json` + per-file `.log` before rerunning;
  `--resume` picks up the checkpoint. Don't crank `-j` past default on a
  loaded box until 0083 lands.
- **Sweep is serial by design** (0045); os-sweep rejects `-j`.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('sameboy' is in all three).
- **Editing seeded sources or coreutils.json/bin.json/lib.json**: the
  headless/test/serve paths detect it by mtime (0082). Bump `image.json`
  `version` (now 47) anyway when an interactive browser tab must pick
  the change up (OPFS re-fetch is version-gated only).
- **Cairo/pixman config is hand-written** (`vendor/cairo/config.h` +
  `src/cairo-features.h`; pixman via two -D flags in lib.json). When
  adding cairo features (0080), extend BOTH headers and lib.json, and
  record patches in the README table. Testsuite diff policy: tol 3,
  hard cap 16.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — the internal
  git-mv can stage a pre-edit blob (re-`git add` the done file; it fired
  at 0063's close).
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording — moves if the message changes.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop" asserts;
  desktop teal == compositor teal; derive geometry from `__osScreen`;
  a SECOND page needs a fresh context/browser.
- Concurrent sessions may be active in this repo: check `git status`
  before staging and stage ONLY your own files.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or project-include-path resolved.
- For the long tail (WRES v2, wmctl click one-arg=label, clipboard file,
  EM_GETHANDLE, argv0, AUDIO_GAIN, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, `ls /`
  goldens incl. proc, 0040 image pairing, MUST-MATCH block list): see
  `todos/done/0048`'s Status, `logs/2026-07-10/0048-closeout.md`, and the
  CLAUDE.md sections — they are the durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0069's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0061's calls; 0081's calls (ONE shared suite engine, kernel `-j4`, sweep
serial, run-unit.js untouched); 0082's calls (input-freshness by mtime
scan, fixture = `os/os-system.img` itself, `version > manifest` blobs
kept, test_os_boot stays the real-bake test); 0070's call (boot STAYS on
VT1 until `ready`; auto-switch only on a healthy ready; user choice
during boot wins); 0072's calls (openwith store FIRST-FILE-WINS, values
are argv prefixes, resolver stays header-only, seeded Desktop ROM
launchers stay scripts); 0075's calls (Peanut-GB stays the default
.gb/.gbc handler; boot ROMs embedded; GB_SECTION kept; GNU-ism fixes are
vendored patches until 0087); 0063's calls (deterministic-or-invisible
split per effect; alpha blends over the frame plate; glass is kernel
STATE but browser-only RENDERING; shadows/corners are SDF in the one
pass; THUMB is kernel mechanism, peek popup is wm.c policy); 0046's
calls (trace sink is a tracer-owned pipe named by spec field, NOT a
spawn-return fd; requests format eagerly at dispatch; whole-line
tracing, no unfinished/resumed splitting; drop-don't-block with a
counted marker; decode table = the OP map).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0041 gcstr, 0079 dep-dedup, 0080 cairo surfaces, or 0064 WM
sweep round 3 (the pointer-lock human check is owed)."
