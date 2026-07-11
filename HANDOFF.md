# Handoff — start of thread (updated 2026-07-11; 0091 context menus closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0091 (Right-click context menus) is CLOSED**; image bumped **v51 → v52**.
Dev log `logs/2026-07-11/0091-context-menus.md`; item at
`todos/done/0091-context-menus.md`; durable notes in CLAUDE.md (os/
section), WM.md ("Implementation status — context menus"), WIN32.md.
What landed:

- **wm.c two-window popup** (root "ctxmenu" + ONE "ctxmenu2" flyout — the
  v1 depth cap): empty desktop (New ▸ Folder/Text File with the Win95
  uniquifier, Sort by ▸ Name = forget `.icons`, Refresh, Display →
  `ctlpanel Display`), icon (select-alone-unless-in-set + Open via
  activate(); 0092's file ops grow here), taskbar button (Restore/
  Minimize/Maximize/Close over the existing chrome ops; grayed rows never
  fire and leave the menu open). Start-menu furniture rules throughout;
  Start strip + empty bar stay reserved for **0101**, title bars for
  **0102**.
- **user32 EDIT WM_CONTEXTMENU menu** (Undo/Cut/Copy/Paste/Delete/Select
  All, state-gated per popup; Undo always grayed — no undo buffer, 0048
  scope) over the 0068 TrackPopupMenu primitive, which grew **modal
  keyboard nav** (Up/Down/Enter/Esc, rest swallowed) and
  right-down-outside close. Popup items stay agent targets.
- **ctlpanel argv**: `ctlpanel <Applet>` opens that applet by
  (case-insensitive) icon label.
- **Fix that fell out**: the START menu's EV_FOCUS dismissal is now gated
  on its root echo (`mcol[0].sid`) — menu_toggle's new ctx_dismiss makes
  focus fall to an app window, and that event used to kill the menu being
  opened (the 0078 run-dialog gate, applied to 0028's rule).

**Tests**: new `tests/kernel/test_ctxmenu_e2e.js` (42 checks; registered
in run.js — NB the kernel runner is a MANIFEST, not a glob: a new test
file must be added to `tests` in tests/kernel/run.js or it silently never
runs) + `tests/browser/os-ctxmenu.mjs` (sweep-discovered automatically).
Kernel suite 46+1/47 pass; browser legs os-ctxmenu/os-shell/os-wm/
os-user32 pass — check `build/test-kernel/summary.json` /
`build/test-browser/` if in doubt.

**Next in queue**: run `node todos/queue.js list` — 0092 (fileman file
ops; uses the 0091 menus as trigger) leads, then 0093+. **Do NOT pipe
`queue.js list` through `head`** — EPIPE crash (known; harmless but
noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0091 NEW: `wmctl list` is Z-ORDERED** — "the first winbox row" is
  whichever sits lowest in z, not the oldest window; pick rows by sid
  (lowest = oldest).
- **0091 NEW: `wmctl tree` dumps every window's menu BAR before the
  `popupmenu` section** — scope popup-item asserts to the text after the
  `popupmenu\n` line or you match notepad's bar Edit menu.
- **0091 NEW: browser popup tests must quiesce ~1.5s after the VT2
  settle** — the VT switch can queue one more screen-resize whose
  EV_SCREEN (screen_changed) dismisses every popup; the settle predicate
  passes early because `__osScreen` already matches from boot.
- **0090: browser keyboard pacing** — type with `{delay: 60}`; run chords
  as explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0090: window cascade covers click targets** — second window spawns
  +28,+24 over the first; aim refocus clicks at the first window's LEFT
  edge strip.
- **0089: `wmctl gettext CLASS:n` is tree-order-global across processes**
  — open windows in a deliberate order or assert by pixel histogram.
  (0091's e2e keeps notepad the only EDIT-bearing agent process.)
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes(...))`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`) or wrap output in `GOT-…-END` markers. (2) Typing right
  after launching a `&` job races hush's job notice — `waitForTimeout(800)`
  first.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
  Desktop legs leave selection strips/`.icons` — clear with Escape.
- **CONFIRMED AGAIN 0076: `queue.js done` can stage a PRE-EDIT blob** of
  the done file — after `done`, check `git show :todos/done/<file>` and
  re-`git add` if the Status edit is missing. Stage ONLY your own files;
  concurrent sessions exist.
- **0078: x < 18 on the root menu column is the sidebar band** — entry
  clicks/samples need x ≥ ~20.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region, or
  `addGlobalImport` throws.
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px out
  from a chromed frame. `wmctl list` FLAGS is 7 chars.
- **0070: browser tests land on VT2 at ready.** Type on the tty only after
  `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **52**) when an interactive
  browser tab must pick up seeded-source edits.
- **New-runner habits**: check `build/test-*/summary.json` (field is
  `status: 'pass'`, not `ok`) + per-file logs after an interrupted run;
  `--resume` picks up the checkpoint. Sweep is serial by design (0045).
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together (incl. the menu TREE; headless menu
  goldens: root `168x116+0+624`, Demos flyout `150x108+165+632`, run
  dialog `240x70+6+664` on a 1024×768 screen; the 0077 tail also pins the
  DESK_ACT list + label-strip geometry — `lx = cellx + (84 - len*6)/2`).
  0091 context-menu goldens (`120x96`/`120x48`/`120x28`, rows 20px pad 4
  sep 8) live in test_ctxmenu_e2e.js + os-ctxmenu.mjs and derive from
  wm.c's MENU_* + CTX_W constants — same move-together rule.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. **`queue.js add --help` is NOT a help flag** — it ADDS an
  item named "untitled" (the fix is queued as 0099).
- Two unit goldens encode libc internals (`switch_br_table` stderr,
  `printf` pointer line); `setjmp_unsupported_diag`'s golden encodes the
  setjmp diagnostic wording.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Browser pixel tests: tolerate the icon grid in "empty desktop" asserts;
  desktop teal == compositor teal; derive geometry from `__osScreen`; a
  SECOND page needs a fresh context/browser.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or include-path resolved.
- For the long tail (WRES v2, wmctl click one-arg=label, EM_GETHANDLE,
  argv0, AUDIO_GAIN, TrackPopupMenu coords, 0069 unmapped semantics,
  MAKEINTRESOURCE stack caveat, shebang one-optarg, `ls /` goldens incl.
  proc, 0040 image pairing, MUST-MATCH block list): see `todos/done/0048`'s
  Status, `logs/2026-07-10/0048-closeout.md`, and the CLAUDE.md sections —
  they are the durable copies.

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
browser-only RENDERING); 0046's calls (trace sink is a tracer-owned pipe;
drop-don't-block); 0041's calls (GC_STR intrinsic; imports-first enforced
by throw; UTF-8 at parse; `"#"` module; cache unification is 0097);
0078's calls (Ctrl+Esc as the chord; root-column-only focus with flyout
hand-back; timer-free hover; RUN… = sh -c; Shut Down deferred to 0051;
ctlpanel via the fixed row; Win7 pane = 0098); 0076's calls (the
rejection ledger in logs/2026-07-11/0076-desktop-polish-parity.md —
rejected affordances stay rejected until the recorded precondition
changes; re-triggering a parity sweep is a human call, never
self-queued); 0077's calls (selection is wm.c-CLIENT state; desktop click
takes focus via WMP_FOCUS; Enter-on-multi is a no-op; `.icons`
whole-layout-on-drop with auto-flow fallback; modifier tracking by
keysym); 0089's calls (single-click applet activation; per-window close
only when >1 windows live, ONE event per request; hub close quits the
panel; applet labels/titles stay unique per process; Mouse/Keyboard
applets wait for real kernel state); 0090's calls (the clipboard is a
KERNEL slot — one slot, no history, last-write-wins, format-tagged for
0092; the C surface is SDL3's clipboard API; term chords are
Ctrl+Shift+C/V with plain ^C left as SIGINT; navigator.clipboard stays
unwired until someone asks); **0091's calls (fixed item lists, NOT
directory scans — the Start-menu columns stay separate machinery; ONE
flyout depth for v1; right-click on an icon selects it alone unless
already in the set; gray rows never fire and leave the menu open;
taskbar CLOSE is request-close like the 'x' box; Start strip/empty bar =
0101, title bars = 0102, fileman file-list menu + icon file ops = 0092;
EDIT Undo stays grayed until a real undo buffer exists)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order of attack (0092
fileman file ops leads and builds directly on 0091's menus, then 0093–
0096, 0098, and the 0101–0107 polish items; 0064 WM sweep round 3 still
owes the pointer-lock human check)."
