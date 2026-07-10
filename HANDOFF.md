# Handoff — start of thread (updated 2026-07-11; 0090 system clipboard closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0090 (System clipboard — cross-app copy/cut/paste) is CLOSED**; image
bumped **v50 → v51**. Dev log `logs/2026-07-11/0090-clipboard.md`; item at
`todos/done/0090-clipboard.md`; durable design notes in CLAUDE.md (os/
section), KERNEL.md (0x03xx ops), WIN32.md, SDL3.md. What landed:

- **ONE kernel-held clipboard slot** `{fmt, bytes}` (fmt 1 = UTF-8 text,
  tagged for 0092's file lists) behind CLIP_SET 0x0302 (RAW, chunked,
  per-pcb staged, committed-on-last) / CLIP_GET 0x0303 (JSON→RAW chunks).
  Survives the writer exiting; strace decodes both.
- **The C surface is the real SDL3 clipboard API** (SDL_SetClipboardText &
  co in __SDL.c, usable without SDL_Init) over host.js `createClipboard`'s
  `__clip_set`/`__clip_get` imports — kernel-backed via new spawnHooks
  members, process-local fallback for standalone/ENOSYS embedders.
- user32's clipboard + EDIT ^C/^X/^V/^A now ride the slot (the 0048
  `$HOME/.clipboard` FILE IS GONE — tests read the slot via `clip -o`);
  term grew drag-selection + Ctrl+Shift+C/V (plain ^C stays SIGINT);
  **`/bin/clip`** (os/clip.c, seeded) is the shell bridge and test probe:
  `cmd | clip` sets, `clip -o` prints (exit 1 empty).
- Host-browser (navigator.clipboard) integration deliberately NOT wired —
  recorded in SDL3.md's clipboard section.

**Tests**: new `tests/kernel/test_clipboard_e2e.js` (15 checks: clip
round-trip/overwrite/clear, ~170KB chunking, notepad copy→exit→paste
cross-process, Cut, shell→GUI paste, term drag-copy/paste, plain-^C
regression). `test_notepad_e2e.js`/`test_calc_e2e.js` migrated from the
clipboard file to `clip`. `os-shell.mjs` grew the 0090 notepad→notepad
leg. Full unit suite 707/707; kernel suite + browser sweep: check
`build/test-kernel/summary.json` / `build/test-browser/` if in doubt.

**Next in queue**: run `node todos/queue.js list` — 0091 (context menus)
leads, then 0092+. **Do NOT pipe `queue.js list` through `head`** — EPIPE
crash (known; harmless but noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds so far, a MUST for WM sweep round 3 (`0064`), which also
carries the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0090 NEW: browser keyboard pacing** — Playwright zero-delay typing +
  `press('Control+a')` floods the win32 per-frame pump: chars drop and the
  Control keydown separates from its letter. Type with `{delay: 60}` and
  run chords as explicit down/gap/press/gap/up (os-shell.mjs `chord()`).
  Headless `wmctl key SID 0 SYM MOD` (one record) is immune.
- **0090 NEW: window cascade covers click targets** — a second notepad
  spawns +28,+24 over the first; refocus clicks must aim at the first
  window's LEFT edge strip or they land in the second one's client area.
- **0089: `wmctl gettext CLASS:n` is tree-order-global across processes**
  — with two notepads, EDIT:0 is the FIRST process; assert the second's
  content by pixel histogram (os-shell.mjs 0090 leg) or open windows in a
  deliberate order (clipboard e2e opens Sound first).
- **0089: agent labels must stay unique per process**; hub keyboard
  headless = `wmctl key SID 79 1073741903` (Right) / `wmctl key SID 40 13`
  (Enter).
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes(...))`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Typing right after launching a `&` job races hush's
  async job notice — `waitForTimeout(800)` first.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
  Desktop legs leave selection strips/`.icons` — clear with Escape.
- **CONFIRMED AGAIN 0076: `queue.js done` can stage a PRE-EDIT blob** of
  the done file — after `done`, check `git show :todos/done/<file>` and
  re-`git add` if the Status edit is missing. Stage ONLY your own files;
  concurrent sessions exist.
- **0078: x < 18 on the root menu column is the sidebar band** — entry
  clicks/samples need x ≥ ~20. Don't dismiss the menu from EV_FOCUS on
  column sids.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region, or
  `addGlobalImport` throws. (Function `__import`s: declare them in
  __SDL.c's top import block, not mid-file — 0090 kept that discipline.)
- **0063: drop shadows are real desktop pixels** — sample TEAL ≥ ~25px out
  from a chromed frame. `wmctl list` FLAGS is 7 chars.
- **0070: browser tests land on VT2 at ready.** Type on the tty only after
  `setVt(1)`; assert boot-time VT1 facts only BEFORE `ready`.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **51**) when an interactive
  browser tab must pick up seeded-source edits.
- **New-runner habits**: check `build/test-*/summary.json` (field is
  `status: 'pass'`, not `ok`) + per-file logs after an interrupted run;
  `--resume` picks up the checkpoint. Sweep is serial by design (0045).
- **Menu/desktop entry lists** image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs must move together (incl. the menu TREE; headless menu
  goldens: root `168x116+0+624`, Demos flyout `150x108+165+632`, run
  dialog `240x70+6+664` on a 1024×768 screen; the 0077 tail also pins the
  DESK_ACT list + label-strip geometry — `lx = cellx + (84 - len*6)/2`).
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
applets wait for real kernel state); **0090's calls (the clipboard is a
KERNEL slot — one slot, no history, last-write-wins, format-tagged for
0092; the C surface is SDL3's clipboard API, not a bespoke one; term
chords are Ctrl+Shift+C/V with plain ^C left as SIGINT; cross-chunk
reads are not snapshot-atomic by design; navigator.clipboard stays
unwired until someone asks)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order of attack (0091
context menus leads, then 0092–0096, 0098, and the 0101–0107 polish
items; 0064 WM sweep round 3 still owes the pointer-lock human check)."
