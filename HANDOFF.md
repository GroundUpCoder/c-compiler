# Handoff — start of thread (updated 2026-07-10; 0078 start menu v2 closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0078 (start menu shell v2 — Win95 restyle) is CLOSED** — dev log
`logs/2026-07-10/0078-start-menu-v2.md`, item at
`todos/done/0078-start-menu-shell-v2.md`, design block "Start menu v2"
in `todos/WM.md`. Load-bearing facts:

- The menu is now CASCADING COLUMNS in os/wm.c (`mcol[MENU_DEPTH 4]`,
  one borderless window per column, titles "startmenu"/"startmenu2"/…
  parsed for depth at the EV_CREATED park). Menu-dir SUBDIRECTORIES are
  groups; baked tree (image **v48**): Games/ Accessories/ Demos/ — the
  top-level ctlpanel link is GONE (the fixed SETTINGS row replaces it).
- **Only the root column ever holds kernel focus** — a flyout's
  create-focus is handed back at its echo (peek precedent). This is
  load-bearing: flyouts die on hover re-target, and a focused-surface
  destroy would focus-fall to an app → the EV_FOCUS rule would dismiss
  the whole menu. Keys route by menu-open state, NOT windowID.
- Fixed section below a separator: SETTINGS → activate("/bin/ctlpanel"),
  RUN… → "startrun" dialog (Enter spawns `/bin/sh -c <input>`). The
  run dialog's focus-dismiss is gated on its echo having landed
  (`run_win && run_sid && p[0] != run_sid`) — the menu-teardown focus
  fall arrives before the echo and must not kill it.
- **Start chord = Ctrl+Esc** at the kernel wmKey seam, EV_CYCLE rules
  exactly (subscriber-gated, keyup swallowed, no-WM pass-through):
  WMP **EV_MENU 0x8C / MENU 0x1C / `wmctl menu`**. MUST-MATCH trio
  updated (kernel.js, wm_proto.h, test_wm_policy.js); VT2 tab tooltip
  documents the chord.
- Hover policy is timer-free: group hover opens/re-targets its flyout;
  non-group hover leaves it open (forgiving diagonals, deterministic
  tests). Keyboard: arrows on the deepest column, Right/Enter cascade,
  Left backs out, Esc closes all, printable = type-ahead.
- Residues with owners: **Win7 two-pane stage → todos/0098** (new item,
  slotted after the desktop-polish cluster); **Shut Down fixed row →
  todos/0051** (its body carries the hook). Non-goals recorded in the
  done item stand (no jump lists/tiles/fs search).

**Tests after the change**: kernel suite **44/44** (test_wm_service_e2e
grew to 78 checks — flyout geometry goldens, menu-shot pixel asserts,
`wmctl menu`, type-ahead, Esc, RUN… typed launch, keyboard-only nested
launch; test_wm_policy grew the chord/MENU legs), blockfs 15/15,
browser `os-sweep.mjs` green (os-shell.mjs restyled: band histogram,
hover-cascade, nested launch, Ctrl+Esc chord, RUN… end-to-end).
compiler.js/host.js untouched — unit suite not re-run.

**Menu geometry moves in THREE places** (the standing entry-lists rule,
now over trees): os/image.json's menu tree ↔ test_wm_service_e2e.js
(MENU_GROUPS/DEMOS/GAMES + derived geometry) ↔ os-shell.mjs (copies).
Root = 168×(8 + rows·20 + 8) at x 0; flyout = 150 wide at parent-right
− 3, first row aligned to the group row, bottom-clamped to the work
area. Headless goldens: root `168x116+0+624`, Demos flyout
`150x108+165+632`, run dialog `240x70+6+664` (1024×768 screen).

**Next in queue**: run `node todos/queue.js list` (0076 desktop polish
sweep and 0077 icon selection lead; the 0089–0096 QoL cluster follows;
0098 sits after it).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **NEW (0078): x < 18 on the root menu column is the sidebar band** —
  entry clicks/samples in tests must use x ≥ ~20 (the e2e uses 60).
  Old `wmctl click $MSID 20 y` habits die: content starts at x 18.
- **NEW (0078): flyout settle pixels must DISCRIMINATE** — both baked
  flyouts bottom-clamp to the bar and share footprint; a shared-pixel
  waitPixel passes mid-re-target and the next click races the swap
  (lands on the desktop → dismisses everything). Wait for the OLD
  column's exclusive top strip to go teal first (dev log has the story).
- **NEW (0078): don't dismiss the menu from EV_FOCUS on column sids** —
  if you add more wm furniture that can be open WITH the menu, exempt
  it in the EV_FOCUS rule or it'll tear the menu down.
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
  os-shell.mjs must move together (now the menu TREE too — see above).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. **`queue.js add --help` is NOT a help flag** — it ADDS an
  item named "untitled" (that's how 0098 got its number this thread;
  repurposed deliberately; the fix is queued as 0099). After
  `queue.js done`, check `git status` —
  it can stage a pre-edit blob and other sessions' untracked todos/
  files: `git reset` and stage your own set explicitly.
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch
  Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop"
  asserts; desktop teal == compositor teal; derive geometry from
  `__osScreen`; a SECOND page needs a fresh context/browser.
- Concurrent sessions may be active in this repo: check `git status`
  before staging and stage ONLY your own files.
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
calls (Peanut-GB… superseded by 0072's flip: SameBoy is the default
.gb/.gbc handler); 0063's calls (deterministic-or-invisible split per
effect; glass is kernel STATE but browser-only RENDERING); 0046's calls
(trace sink is a tracer-owned pipe; drop-don't-block); 0041's calls
(GC_STR intrinsic; imports-first enforced by throw; UTF-8 at parse;
`"#"` module; the cache unification is 0097); **0078's calls (Ctrl+Esc
as the chord; root-column-only focus with flyout hand-back; timer-free
hover; RUN… = sh -c; Shut Down deferred to 0051; ctlpanel via the fixed
row, not a menu entry; Win7 pane = 0098)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I
want to tackle — `node todos/queue.js list` for the order of attack
(0076 desktop-polish sweep and 0077 icon selection lead, then the
0089–0096 QoL cluster; 0064 WM sweep round 3 still owes the
pointer-lock human check)."
