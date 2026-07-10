# Handoff — start of thread (updated 2026-07-11; 0077 icon selection closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0077 (desktop icon selection & manipulation) is CLOSED** — landed
wm.c-only, zero kernel/protocol change; image bumped **v48 → v49**
(wm.c + wmctl.c are baked sources). Dev log
`logs/2026-07-11/0077-desktop-icon-selection.md`; item at
`todos/done/0077-desktop-icon-selection.md`. What landed:

- Selection = a 64-bit mask over the icon entries: click / ctrl-click /
  shift-range (entry order) / empty-desktop marquee (white outline,
  intersects TILES, ctrl adds, plain replaces); highlight = the 0029
  navy label strip per selected icon — unselected rendering is
  byte-identical to pre-0077, which kept every coordinate-pinned test
  green.
- Free placement: icons live in explicit cells; `/root/Desktop/.icons`
  (`col row name` lines) persists the WHOLE layout on each drag-drop;
  absent entries auto-flow column-major, so a virgin Desktop reproduces
  the 0029 grid exactly. Drag moves the whole selected set by the
  snapped cell delta, all-or-nothing (out-of-bounds/occupied target
  reverts the move). Out-of-bounds saved cells (small screen) fall back
  to auto-flow WITHOUT rewriting the file.
- Keyboard: arrows (nearest icon in direction), Enter (SINGLE selection
  only — **decided: multi-selection Enter is a no-op**, the multi-launch
  guard), Esc clears, Ctrl+A selects all.
- Two load-bearing policy decisions: **a desktop left-click sends
  WMP_FOCUS on the desktop sid** (kernel borderless exemption stands;
  the wm asks explicitly — that's how keys reach the grid), and
  **modifiers are tracked by KEYSYM from key events** (pointer records
  carry no mod word), reset when the desktop loses focus. The
  modifier-held-before-first-focus nuance is a WM.md "Known issues"
  entry (self-healing; fix = mod word in the pointer ring record, only
  if it ever bites).
- wmctl grew `keydown`/`keyup` (one key edge — hold a modifier across an
  injected click), `down`/`up` (one pointer edge), `drag X1 Y1 X2 Y2`
  (press-move-move-release on one connection). Pure INJECT_* wrappers.
- Right-button routing deliberately untouched (`button != 1` now
  short-circuits before selection) — **0101 owns right-click**; rename-
  in-place is **0103** (queued after 0077, now unblocked).

**Tests**: `test_wm_service_e2e.js` grew a 0077 tail (selection matrix,
marquee, drag-move + `.icons` persistence across the re-read tick, the
Enter no-op, arrow+Enter launch) — full PASS headless. `os-shell.mjs`
grew the browser twins (DOM ctrl+click, mouse marquee, drag-reposition
quake (0,5)→(2,5), Esc). Check the latest suite results in
`build/test-kernel/summary.json` / `build/test-browser/` if in doubt.

**Next in queue**: run `node todos/queue.js list` — 0089 (control panel
v2) leads now, then 0090–0096, 0098, 0101–0107 (0103 icon rename is
unblocked by this close). **Do NOT pipe `queue.js list` through
`head`** — EPIPE crash (known; harmless but noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0077 NEW: the icon tile's white ring is 6px; the center block is
  navy.** A "tile present" pixel probe must sample `(ix+2, iy+2)`, not
  the tile center — the first e2e run failed exactly there.
- **0077 NEW: successive `wmctl click`s on the SAME icon can pair into
  a double-click** (500ms window, timestamps are drain-time). Distinct
  icons never pair; a held modifier suppresses the pair; when in doubt
  `sleep 0.6` between same-icon gestures.
- **0077 NEW: browser desktop tests that click icons leave selection
  strips + possibly an `.icons` layout behind** for later legs in the
  SAME session — clear with Escape / pick target cells clear of later
  pixel asserts (os-shell moves quake to (2,5) deliberately).
- **CONFIRMED AGAIN 0076: `queue.js done` can stage a PRE-EDIT blob** of
  the done file — after `done`, check `git show :todos/done/<file>` and
  re-`git add` if the Status edit is missing. Stage ONLY your own files;
  concurrent sessions exist.
- **0078: x < 18 on the root menu column is the sidebar band** — entry
  clicks/samples in tests must use x ≥ ~20 (the e2e uses 60).
- **0078: don't dismiss the menu from EV_FOCUS on column sids** — exempt
  new wm furniture that can be open WITH the menu, or it tears down.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region, or
  `addGlobalImport` throws. `__gcstr` literals must be valid UTF-8.
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px
  out from a chromed frame. `wmctl list` FLAGS is 7 chars.
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and
  `tests/` are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`,
  `vendor/` are. Bump `image.json` `version` (now **49**) when an
  interactive browser tab must pick up seeded-source edits.
- **New-runner habits**: check `build/test-*/summary.json` (field is
  `status: 'pass'`, not `ok`) + per-file logs after an interrupted run;
  `--resume` picks up the checkpoint. Sweep is serial by design (0045).
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together (incl. the menu TREE; headless menu
  goldens: root `168x116+0+624`, Demos flyout `150x108+165+632`, run
  dialog `240x70+6+664` on a 1024×768 screen; the 0077 tail also pins
  the DESK_ACT list + label-strip geometry — label x derives from
  name length, `lx = cellx + (84 - len*6)/2`).
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
0051; ctlpanel via the fixed row; Win7 pane = 0098); 0076's calls (the
rejection ledger in logs/2026-07-11/0076-desktop-polish-parity.md —
rejected affordances stay rejected until the recorded precondition
changes; re-triggering a parity sweep is a human call, never
self-queued); **0077's calls (selection is wm.c-CLIENT state, no
protocol addition; desktop click takes focus via WMP_FOCUS — policy
asks, the kernel exemption stands; Enter-on-multi is a no-op; `.icons`
is whole-layout-on-drop with auto-flow fallback; modifier tracking by
keysym, no mod word in pointer records unless the Known-issues entry
ever bites)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I
want to tackle — `node todos/queue.js list` for the order of attack
(0089 control-panel v2 leads, then the 0090–0096 QoL cluster, 0098,
and the 0101–0107 polish items; 0103 icon rename is now unblocked;
0064 WM sweep round 3 still owes the pointer-lock human check)."
