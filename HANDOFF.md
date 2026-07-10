# Handoff — start of thread (updated 2026-07-10; 0063 aero closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0063 (Aero effects on the WebGPU compositor) is CLOSED** — dev log
`logs/2026-07-10/0063-aero-effects.md`, durable status in `todos/WM.md`
"Implementation status — Aero effects" + `todos/done/0063-aero-effects.md`.
Load-bearing facts:

- **All five waves landed**: per-pixel alpha (`SDL_WINDOW_TRANSPARENT` →
  kernel flag bit3 → WMP_F_ALPHA 32; `winbox alpha` = "alphabox"
  acceptance app), drop shadows + radius-7 rounded corners (per-quad
  rounded-rect SDF, still ONE render pass), Aero Peek (kernel
  `wmThumbnail`/WMP THUMB 0x32 deterministic box filter; wm.c hover
  popup; `wmctl thumb`/`wmctl hover`), 200ms minimize/restore fly
  animations (transient `_wmAnims` records, pruned in `wmScene()`), and
  glass (WMP GLASS 0x1B/`wmctl glass` — segmented backdrop-blur chain,
  browser pass only).
- **The 0063 constraint held**: headless goldens bit-exact. Alpha is the
  one effect implemented in the headless composite too (exact integer
  src-over behind surface bit3); shadows/corners/anims/glass are
  invisible to it. Glass OFF is literally the pre-0063 single-pass code
  path (`segments.length === 1`), not an equivalent one.
- Image version is **v46**.

**Residue got owners, no new queue items**: notepad's ERROR dialog when
opening an existing file (pre-existing — verified against the unmodified
tree) is a seeded finding in `todos/0073`; the aero aesthetics + glass
perf human eyeball rides `todos/0064` next to the standing pointer-lock
check.

**Tests after the change**: kernel suite **42/42** (includes the new
`test_wm_aero.js`), unit 702/702, browser sweep 16/16 including the new
`os-aero.mjs` (exact GPU blend, shadow falloff + decay, corner clip,
live peek popup, anim settle, glass round-trip).

**Next in queue**: run `node todos/queue.js list` — 0046 (strace) leads.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which now
also carries the aero eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0063): drop shadows are real desktop pixels** — a chromed
  window darkens ~17px beyond its frame (14 reach + 3 drop). Browser
  TEAL/pixel asserts near a frame must sample ≥ ~25px out (os-wm,
  os-scale, os-aero show the pattern). Borderless surfaces cast none.
- **NEW (0063): a translucent client blends over the chrome frame PLATE
  (FACE 192), not the desktop** — the frame quad spans the whole window.
  50%-alpha blue reads [96,96,224]; e2e golden + os-aero agree.
- **NEW (0063): `wmctl list` FLAGS is 7 chars now** (`A` = has-alpha at
  [5], layer T/B moved to [6]) — literal FLAGS strings and regexes must
  carry the extra column.
- **NEW (0063): wm.c's peek keeps `peek_pending` across dismiss** — an
  in-flight THUMB reply must still be consumed off the socket (replies
  are in request order); don't "simplify" that away.
- 0075: SameBoy core compiles with `-DGB_INTERNAL` everywhere; MIN/MAX
  are plain ternaries in the vendored defs.h — keep call sites
  side-effect-free. `GB_random` seeds lazily — don't pixel-match frames
  that depend on uninitialized CGB palette RAM.
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
  `version` (now 46) anyway when an interactive browser tab must pick
  the change up (OPFS re-fetch is version-gated only).
- **Cairo/pixman config is hand-written** (`vendor/cairo/config.h` +
  `src/cairo-features.h`; pixman via two -D flags in lib.json). When
  adding cairo features (0080), extend BOTH headers and lib.json, and
  record patches in the README table. Testsuite diff policy: tol 3,
  hard cap 16.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. After `queue.js done`, check `git status` — the internal
  git-mv can stage a pre-edit blob (re-`git add` the done file; it fired
  again at 0063's close).
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
fixes are vendored patches until 0087 promotes them); 0063's calls
(deterministic-or-invisible split per effect; alpha blends over the
frame plate; glass is kernel STATE but browser-only RENDERING; shadows/
corners are SDF in the one pass, no extra passes; THUMB is kernel
mechanism, the peek popup is wm.c policy).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0046 strace, 0041 gcstr, 0079 dep-dedup, 0080 cairo surfaces,
or 0064 WM sweep round 3 (the pointer-lock human check is owed)."
