# Handoff — start of thread (updated 2026-07-11; 0089 control panel v2 closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0089 (Control Panel v2 — applet hub) is CLOSED**; image bumped
**v49 → v50**. Dev log `logs/2026-07-11/0089-control-panel-v2.md`; item
at `todos/done/0089-control-panel-v2.md`. What landed:

- `/bin/ctlpanel` is now the Win95 Control Panel FOLDER: a hub window of
  CplIcon applet icons; each applet opens as its own sibling top-level
  window. Sound = the 0048 volume controls verbatim (groupbox renamed
  "Master Volume" — icon labels are the agent namespace, keep them
  unique); System = os-release + /proc/uptime STATICs; Display = a stub
  naming todos/0049 (that item owns filling it — the wallpaper picker's
  Control Panel home); Date/Time = live SetTimer/WM_TIMER clock.
  **Single-click activation** (decided: one `wmctl click "Sound"` = one
  open; down selects — navy strip — up opens); hub keyboard =
  Left/Right/Home/End + Enter. Hub close quits the whole panel; one
  instance per applet (reopen of an open applet = no-op).
- **Veneer growth — per-window close**: the kernel close request
  ('x' / `wmctl close`) now delivers `SDL_EVENT_WINDOW_CLOSE_REQUESTED`
  (0x210) with the windowID when MORE THAN ONE window is live in the
  process (compiler.js SDL builtin decides; host.js now passes the
  handle it always had; user32's pump routes WM_CLOSE to exactly that
  top-level). The only/last window keeps the process-wide
  `SDL_EVENT_QUIT` — single-window apps byte-identical. Deliberate
  divergence from upstream SDL3: ONE event per request (never
  CLOSE_REQUESTED + QUIT), so a queued pair can't double-close.
  Zero kernel.js change in the whole item.
- Mouse/Keyboard applets deliberately not built: no live kernel state to
  control yet — the item that introduces such state owns its applet.

**Tests**: `test_ctlpanel_e2e.js` extended (hub tree, single-click open,
0048 volume legs inside the Sound applet, per-window close, keyboard
Right+Enter, WM_TIMER tick, hub-close-quits-all, cross-process gain) —
ALL OK. `os-shell.mjs` grew the 0089 leg (icon-folder composite, pixel
click opens Sound in its own window, agent volume/system drive, close
box kills only the applet). Full kernel suite + browser runs: check
`build/test-kernel/summary.json` / `build/test-browser/` if in doubt.

**Next in queue**: run `node todos/queue.js list` — 0090 (clipboard)
leads, then 0091–0096, 0098, 0101–0107. **Do NOT pipe `queue.js list`
through `head`** — EPIPE crash (known; harmless but noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0089 NEW: `wmctl gettext STATIC:0` reaches the ctlpanel volume label
  only while Sound is the first-opened applet** — CLASS:n is
  tree-order-global across every top-level of the process; the e2e opens
  Sound first deliberately.
- **0089 NEW: agent labels must stay unique per process** — `wmctl
  click` resolves BUTTONs first, then any shown window; a groupbox named
  like an icon steals the click (that's why the Sound groupbox became
  "Master Volume").
- **0089 NEW: hub keyboard headless = `wmctl key SID 79 1073741903`
  (Right) / `wmctl key SID 40 13` (Enter)** — user32 vk_of maps by SDL
  keysym.
- **0077: the icon tile's white ring is 6px; probe `(ix+2, iy+2)`**, not
  the tile center. Successive `wmctl click`s on the SAME desktop icon can
  pair into a double-click (500ms); `sleep 0.6` between same-icon
  gestures. Browser desktop legs leave selection strips/`.icons` behind —
  clear with Escape.
- **CONFIRMED AGAIN 0076: `queue.js done` can stage a PRE-EDIT blob** of
  the done file — after `done`, check `git show :todos/done/<file>` and
  re-`git add` if the Status edit is missing. Stage ONLY your own files;
  concurrent sessions exist.
- **0078: x < 18 on the root menu column is the sidebar band** — entry
  clicks/samples in tests must use x ≥ ~20 (the e2e uses 60). Don't
  dismiss the menu from EV_FOCUS on column sids.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region, or
  `addGlobalImport` throws. `__gcstr` literals must be valid UTF-8.
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px
  out from a chromed frame. `wmctl list` FLAGS is 7 chars.
- **0070: browser tests land on VT2 at ready.** Type on the tty only
  after `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and
  `tests/` are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`,
  `vendor/` are. Bump `image.json` `version` (now **50**) when an
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
self-queued); 0077's calls (selection is wm.c-CLIENT state; desktop
click takes focus via WMP_FOCUS; Enter-on-multi is a no-op; `.icons`
whole-layout-on-drop with auto-flow fallback; modifier tracking by
keysym); **0089's calls (single-click applet activation — the agent
path is one down/up pair, double-click would be timing-dependent;
per-window close only when >1 windows live, ONE event per request —
never the upstream CLOSE_REQUESTED+QUIT pair; hub close quits the
panel; applet labels/titles stay unique per process; Mouse/Keyboard
applets wait for real kernel state to control)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I
want to tackle — `node todos/queue.js list` for the order of attack
(0090 clipboard leads, then 0091–0096, 0098, and the 0101–0107 polish
items; 0064 WM sweep round 3 still owes the pointer-lock human check)."
