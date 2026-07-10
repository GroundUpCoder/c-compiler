# Handoff — start of thread (updated 2026-07-11; 0076 parity sweep closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0076 (desktop polish parity sweep) is CLOSED** — a curation-only turn,
NO code changed. Dev log `logs/2026-07-11/0076-desktop-polish-parity.md`
holds the room-by-room have/partial/missing table + the rejection
ledger; item at `todos/done/0076-desktop-polish-parity-sweep.md`.

The sweep filed **seven new items, 0101–0107**, slotted right behind
0098 at the tail of the desktop-polish cluster:

- **0101** taskbar polish — empty-bar right-click menu (Cascade/Tile/
  Min-All/Properties), Show Desktop strip, clock date popup (after 0091).
  NB wm.c currently ignores `e.button.button` — right-click routing is
  part of this item.
- **0102** window system menu — Alt+Space via the EV_CYCLE chord pattern
  (new WMP EV_SYSMENU → MUST-MATCH trio grows), wm.c popup, arrow-key
  Move/Size modes (after 0091).
- **0103** desktop icon rename-in-place — F2/click-pause inline label
  editor over /root/Desktop (after 0077, which non-goaled it).
- **0104** user32 dialog keyboard — the 0058 descope coming due: real
  IsDialogMessage (Tab order), Alt+mnemonics + underline, default-button
  Enter, Esc in the modal loop, LISTBOX PageUp/Down.
- **0105** pointer cursor shapes — chrome resize cursors from the
  kernel hit test + per-surface CSS-cursor state for SDL/user32
  (promotes the SDL3.md Mouse backlog line; the "native browser cursor"
  deviation stands).
- **0106** fileman navigator v2 — details columns, multi-select LISTBOX,
  Enter-opens, F5/external refresh, status bar, sort/hidden toggles,
  Back history (after 0092).
- **0107** Paint accessory — native gdi32 `paint.c` (ReactOS mspaint is
  C++ → excluded), shapes/fill/palette, BMP via comdlg32, .bmp openwith.

Notable rejections (full ledger in the dev log): quick-launch strip,
notification tray (no producers), taskbar grouping, shake-to-minimize,
tooltips control (PORTS.md demand is ZERO), WordPad/CharMap/Clock-app,
GUI task manager, Solitaire/FreeCell (C++), Win-key-as-Start (browsers
eat Meta — Ctrl+Esc stands). Fileman drag-and-drop deliberately waits
for 0092 to land and shape it.

**Load-bearing survey facts** (verified in code this turn, reusable):
comdlg32.c EXISTS (file dialogs work — the gap is only dialog keyboard);
EDIT already has selection + WM_COPY/CUT/PASTE over the file clipboard
(0090's job is the cross-process store, not the control); 0067's
drag-drop is host→desktop INGEST only (wm.c has no drop code — the ~1s
readdir watch makes icons appear); kernel owns window drag entirely,
wm.c only consumes EV_MOVED; the taskbar clock has no hit test at all.

**No tests were run this turn** — nothing executable changed (todos/,
logs/, HANDOFF only). Image version stays **v48**; no bake inputs
touched.

**Next in queue**: run `node todos/queue.js list` — 0077 (icon
selection) now leads, then 0089–0096, 0098, then the new 0101–0107.

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **CONFIRMED this turn: `queue.js done` staged a PRE-EDIT blob** of the
  done file (the memory/HANDOFF warning is real) — after `done`, check
  `git show :todos/done/<file>` and re-`git add` if the Status edit is
  missing. Also stage ONLY your own files; concurrent sessions exist.
- **0078: x < 18 on the root menu column is the sidebar band** — entry
  clicks/samples in tests must use x ≥ ~20 (the e2e uses 60).
- **0078: flyout settle pixels must DISCRIMINATE** — wait for the OLD
  column's exclusive top strip to go teal before the next click
  (dev log 2026-07-10/0078 has the story).
- **0078: don't dismiss the menu from EV_FOCUS on column sids** — exempt
  new wm furniture that can be open WITH the menu, or it tears down.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region, or
  `addGlobalImport` throws. `__gcstr` literals must be valid UTF-8.
- **0046: trace asserts must match the child's KERNEL fd numbers.**
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px
  out from a chromed frame. `wmctl list` FLAGS is 7 chars.
- 0075: SameBoy compiles with `-DGB_INTERNAL`; don't pixel-match uninit
  CGB palette RAM.
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and
  `tests/` are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`,
  `vendor/` are. Bump `image.json` `version` (now **48**) when an
  interactive browser tab must pick up seeded-source edits.
- **New-runner habits**: check `build/test-*/summary.json` (field is
  `status: 'pass'`, not `ok`) + per-file logs after an interrupted run;
  `--resume` picks up the checkpoint. Sweep is serial by design (0045).
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together (incl. the menu TREE; headless menu
  goldens: root `168x116+0+624`, Demos flyout `150x108+165+632`, run
  dialog `240x70+6+664` on a 1024×768 screen).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. **`queue.js add --help` is NOT a help flag** — it ADDS an
  item named "untitled" (the fix is queued as 0099).
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch
  Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop"
  asserts; desktop teal == compositor teal; derive geometry from
  `__osScreen`; a SECOND page needs a fresh context/browser.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources —
  noise; headers are compiler.js built-ins or include-path resolved.
- For the long tail (WRES v2, wmctl click one-arg=label, clipboard file,
  EM_GETHANDLE, argv0, AUDIO_GAIN, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, `ls /`
  goldens incl. proc, 0040 image pairing, MUST-MATCH block list): see
  `todos/done/0048`'s Status, `logs/2026-07-10/0048-closeout.md`, and
  the CLAUDE.md sections — they are the durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0069's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0061's calls; 0081's calls (ONE shared suite engine, kernel `-j4`, sweep
serial, run-unit.js untouched); 0082's calls (input-freshness by mtime
scan, fixture = `os/os-system.img` itself, `version > manifest` blobs
kept); 0070's call (boot STAYS on VT1 until `ready`); 0072's calls
(openwith store FIRST-FILE-WINS, resolver stays header-only); 0075's
calls (SameBoy is the default .gb/.gbc handler); 0063's calls
(deterministic-or-invisible split per effect; glass is kernel STATE but
browser-only RENDERING); 0046's calls (trace sink is a tracer-owned
pipe; drop-don't-block); 0041's calls (GC_STR intrinsic; imports-first
enforced by throw; UTF-8 at parse; `"#"` module; cache unification is
0097); 0078's calls (Ctrl+Esc as the chord; root-column-only focus with
flyout hand-back; timer-free hover; RUN… = sh -c; Shut Down deferred to
0051; ctlpanel via the fixed row; Win7 pane = 0098); **0076's calls
(the rejection ledger in logs/2026-07-11/0076-desktop-polish-parity.md
— rejected affordances stay rejected until the recorded precondition
changes, e.g. tray needs a producer app, tooltips need port demand;
re-triggering a parity sweep is a human call, never self-queued)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I
want to tackle — `node todos/queue.js list` for the order of attack
(0077 icon selection leads, then the 0089–0096 QoL cluster, 0098, and
the new 0101–0107 polish items from the 0076 sweep; 0064 WM sweep
round 3 still owes the pointer-lock human check)."
