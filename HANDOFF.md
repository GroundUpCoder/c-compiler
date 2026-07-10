# Handoff — start of thread (updated 2026-07-10; 0041 gcstr closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0041 (`__gcstr` — string literals as imported externref constants) is
CLOSED** — dev log `logs/2026-07-10/0041-gcstr.md`, item at
`todos/done/0041-gcstr-string-constants.md`. Load-bearing facts:

- `__gcstr("...")` parses as an `EIntrinsic` GC_STR carrying the `EString`
  (NO new node class — three dispatch sites: parser, C-printer, codegen).
  One immutable `(ref extern)` global import per distinct literal, module
  `"#"`, name = the literal bytes; deduped by decoded content. `GCSTR()`
  macro in guc.h.
- **Index-shift is enforced structurally, not relocated**: a generateCode
  pre-scan registers every literal BEFORE the first defined global;
  `addGlobalImport` throws once one exists; codegen throws on an
  unregistered literal. `patchGlobalI32` subtracts the import count.
- File-scope `__externref` AND `__refextern` globals can init from
  `__gcstr` (global.get of an immutable import is a constant expr) —
  `__refextern`'s only valid global initializer.
- `importedStringConstants: '#'` joined the MUST-MATCH compile-options
  pair (host.js runModule ↔ kernel.js `_moduleFor`). C and ss options are
  now IDENTICAL → **follow-up 0097**: drop `_moduleFor`'s ss exclusion so
  ss binaries join the 0037 spawn module cache (SS-INTEROP.md §4).
- Loaders without compile options use
  `imports['#'] = new Proxy({}, {get: (_, name) => name})`.

**Adjacent fix**: `newestBakeInput` no longer counts `*.img.tmp-<pid>`
(mkimage atomic-rename temps) as bake inputs — a killed bake used to make
the image PERPETUALLY stale (each serve.js re-bake killed by a test
timeout left another temp). Pattern gitignored too.

**Tests after the change**: unit **707/707** (5 new gcstr tests), kernel
**44/44**, blockfs 15/15, host suite all-pass (new
`test_gcstr_imports.js` — binary shape + polyfill), ast 125/125, headless
boot + browser os-boots.mjs green, in-OS `cc` compile+run of a gcstr
program verified. Image version stays **v47** (no seeded-source change;
compiler.js/host.js edits re-bake by mtime).

**Concurrent session note**: another session was active during this work
(sameboy save-states + a desktop-polish queue batch 0089–0096, uncommitted
at the time). The 0041 commit staged a SURGICAL queue.json (HEAD − 0041 +
0097) so the pushed manifest has no dangling ids; the working tree keeps
their full version. If their items look missing from `git log`, that's why.

**Next in queue**: run `node todos/queue.js list`.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0041): all global imports before any defined global** — if you add
  another imported-global feature, register it in generateCode's pre-scan
  region (before the stack-pointer global), or `addGlobalImport` throws.
- **NEW (0041): `__gcstr` literals must be valid UTF-8** — parse-time
  fatal-decode; `\xNN` escapes that break UTF-8 are compile errors.
- **0046: `wc`-style trace asserts must match the child's fd table** —
  trace lines show KERNEL fd numbers; strace's own pipe fds never appear.
  A parked tracer read is served by `_traceLine`'s `_pipeNotify` re-entry.
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px out
  from a chromed frame. Translucent clients blend over the frame PLATE
  (FACE 192). `wmctl list` FLAGS is 7 chars. wm.c's peek keeps
  `peek_pending` across dismiss.
- 0075: SameBoy compiles with `-DGB_INTERNAL`; MIN/MAX are plain ternaries;
  `GB_random` seeds lazily — don't pixel-match uninit CGB palette RAM.
- **0072**: `wmctl click LABEL`/`settext` take the FIRST win32 app that
  accepts the label; `strncasecmp`/`strcasecmp` live in `<strings.h>`.
- **0070: browser tests land on VT2 at ready.** Type on the tty only after
  `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are.
- **New-runner habits**: check `build/test-*/summary.json` + per-file logs
  after an interrupted run; `--resume` picks up the checkpoint. Sweep is
  serial by design (0045).
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('sameboy' is in all three).
- Bump `image.json` `version` (47) when an interactive browser tab must
  pick up seeded-source edits (OPFS re-fetch is version-gated only).
- **Cairo/pixman config is hand-written** — extend BOTH headers and
  lib.json when adding features (0080); testsuite diff tol 3, cap 16.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — it can stage a
  pre-edit blob AND (seen at 0041's close) it stages OTHER sessions'
  untracked todos/ files: `git reset` and stage your own set explicitly.
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording.
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
VT1 until `ready`); 0072's calls (openwith store FIRST-FILE-WINS, resolver
stays header-only); 0075's calls (Peanut-GB stays the default .gb/.gbc
handler); 0063's calls (deterministic-or-invisible split per effect; glass
is kernel STATE but browser-only RENDERING); 0046's calls (trace sink is a
tracer-owned pipe named by spec field; drop-don't-block with a counted
marker); 0041's calls (GC_STR intrinsic not a node class; imports-first
enforced by throw, no relocation; UTF-8 validated at parse; import name =
raw literal bytes; `"#"` module; C/ss compile options unified — the cache
unification itself is 0097).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order of attack (0079
dep-dedup and 0080 cairo surfaces lead unless the concurrent session's
reorder landed; 0064 WM sweep round 3 still owes the pointer-lock human
check)."
