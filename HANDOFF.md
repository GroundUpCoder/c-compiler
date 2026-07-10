# Handoff — start of thread (updated 2026-07-10; 0075 sameboy + 0085 closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0075 (SameBoy — second, cycle-accurate GB/GBC core) is CLOSED** — dev log
`logs/2026-07-10/0075-sameboy.md`, details in
`todos/done/0075-sameboy-gbc-emulator.md`. Load-bearing facts:

- `vendor/sameboy/` = SameBoy **v1.0.3** Core subset (no debugger/cheats/
  rewind/save-state TUs), every local edit marked `PATCH(c-compiler)` and
  tabled in its README. `/bin/sameboy` + Start-menu entry; **`/bin/gameboy`
  stays the .gb/.gbc association default** (e2e-asserted).
- Boot ROMs (SameBoy's own, MIT) are **embedded C arrays** from the
  official v1.0.3 `sameboy_winsdl` release zip — no rgbds in this repo.
  The boot-ROM callback must map `GB_BOOT_ROM_CGB_E` (what a CGB-E model
  actually requests) to the CGB image — missing it = frozen random-color
  CGB frame while DMG works (the launch bug; e2e guards it).
- `GB_SECTION`'s `[0]` markers ride the **pre-existing**
  `--allow-zero-length-arrays` flag (quickjs precedent) — now also wired
  through `os-common.js` buildProject's own compilerArgs whitelist (new
  compiler flags used by seeded projects must be added THERE too).
- Image version is **v45**; menu entry added ⇒ the MENU_ENTRIES lists in
  `test_wm_service_e2e.js` + `os-shell.mjs` moved together (triple-sync).

**0085 (multi-char char constants, GCC packing) is CLOSED** — spun out of
0075's compile probe, landed test-first (`multichar_char_const`
conformance golden). `'SAME'` == 0x53414D45 now; one shared
`narrowCharConstValue` feeds the lexer CHAR→INT resolution and the PP
`#if` evaluator.

**Follow-ups filed**: `0086` (sameboy save states + core pickability),
`0087` (GNU-extension gap triage: offsetof-as-ICE, statement exprs, elvis,
embedded directives in macro args, `__attribute__((constructor))`,
vasprintf, bswap builtins — promote lines when a second port hits them).

**Tests after the change**: kernel suite **41/41** (includes the new
`test_sameboy_e2e.js`, 15 checks), unit suite 702/702, browser os-shell
leg green (menu geometry with 16 entries).

**Next in queue**: run `node todos/queue.js list` — 0063 aero leads.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`): quake lock on
click, ESC unlock, click re-lock, VT-switch release.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0075)**: SameBoy's core sources compile with `-DGB_INTERNAL` for
  every TU (frontend included); MIN/MAX are plain ternaries in the
  vendored defs.h — keep new call sites side-effect-free.
- **NEW (0075)**: `GB_random` seeds lazily (no constructor attr) — frames
  that depend on uninitialized CGB palette RAM change colors per run;
  don't pixel-match those, assert palette structure instead.
- **0072**: `wmctl click LABEL`/`settext` take the FIRST win32 app that
  accepts the label — sequence agent-driven test legs so ambiguous labels
  can't land in another app.
- **0072**: `strncasecmp`/`strcasecmp` are in `<strings.h>`, not
  `<string.h>`, in this libc.
- **0072**: need a Peanut-GB window to stay up in a test? Don't feed it
  garbage; synthesize the minimal valid cartridge — recipe `minimalRom()`
  in test_openwith_e2e.js (sameboy's e2e uses its built-in test ROM
  instead — real boot ROMs check the header).
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082 gate): land the
  edit, re-run; or run mkimage first. `.md` files and `tests/` are NOT
  bake inputs; `os/*.c/.h/.json` and `vendor/` are.
- **New-runner habits**: after an interrupted/failed suite run, look at
  `build/test-*/summary.json` + per-file `.log` before rerunning;
  `--resume` picks up the checkpoint (works for os-sweep too). Don't
  crank `-j` past default on a loaded box until 0083 lands.
- **Sweep is serial by design** (0045 boot lock + contention); os-sweep
  rejects `-j`. Keep it that way.
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together ('sameboy' is in all three now).
- **Editing seeded sources or coreutils.json/bin.json/lib.json**: the
  headless/test/serve paths detect it by mtime (0082). Bump `image.json`
  `version` (now 45) anyway when an interactive browser tab must pick
  the change up (OPFS re-fetch is version-gated only).
- **Cairo/pixman config is hand-written** (`vendor/cairo/config.h` +
  `src/cairo-features.h`; pixman via two -D flags in lib.json). When
  adding cairo features (0080), extend BOTH headers and lib.json, and
  record patches in the README table. Testsuite diff policy: tol 3,
  hard cap 16.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — the internal
  git-mv can stage a pre-edit blob (re-`git add` the done file).
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
.gb/.gbc handler — SameBoy is the accuracy option; boot ROMs embedded,
not fs-seeded; GB_SECTION kept intact rather than flattened; GNU-ism
fixes are vendored patches until 0087 promotes them).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0063 aero, 0046 strace, 0041 gcstr, 0079 dep-dedup, or 0064
WM sweep round 3 (the pointer-lock human check is owed)."
