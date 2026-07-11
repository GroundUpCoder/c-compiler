# Handoff — start of thread (updated 2026-07-11; 0107 Paint accessory closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0107 (Paint accessory) is CLOSED and COMMITTED.** `/bin/paint` is seeded in
the Accessories menu and `.bmp` opens with it. It's the first *creative* app on
the Win32 veneer (gdi32/user32/comdlg32) — a small native mspaint-class app, NOT
a port (ReactOS mspaint is C++). Dev log
`logs/2026-07-11/0107-paint-accessory.md`; item at
`todos/done/0107-paint.md`.

One breath: `os/win32/paint.c` is ONE owner-drawn window (no child controls) —
a memory-DC canvas blitted 1:1, a left toolbox + bottom 16-colour palette, and a
File/Edit/Image/Tools/Help menu. 8 tools (pencil/eraser/fill/line/rect/
filled-rect/ellipse/filled-ellipse); shape tools rubber-band via a `BitBlt`-from-
undo preview per mouse-move; Fill is an own scanline flood over GetPixel/SetPixel;
FG=left / BG=right. Single-level Undo (one stashed canvas copy). 24-bit BMP
save/open via comdlg32, **byte-identical round-trip**. Cut/Copy/Paste stay
GRAYED — a selection region is the recorded v2 non-goal (wants a bitmap
clipboard the 0090 kernel slot doesn't carry).

- `os/win32/paint.c` + `paint.json` — the app + its bin.json.
- `os/win32/ports.json` + `PORTS.md` — paint added as a control target
  (`expect: links`), like gdidemo/ctldemo.
- `os/image.json` — `/usr/bin/paint`, the Accessories link, a `bmp` openwith
  line; `version` → **67**.
- `tests/kernel/run.js` — registered `test_paint_e2e.js`.

**Verified** (all PASS): new `tests/kernel/test_paint_e2e.js` (35 checks —
lifecycle, menu tree incl. grayed Cut/Copy/Paste + Undo, filled-rect draw via
`wmctl drag`, flood fill, single-level Undo, New clear, comdlg32 Save→New→Open
round-trip with a byte-identical re-save); `node tools/win32ports.js --check`
(paint links, report fresh); `node tests/kernel/run.js --filter=os_boot` (full
image bakes + boots, 194s). `node todos/queue.js check` passes.

**No follow-up todos filed** — the item's intent is fully met; the only residue
is the browser leg (below), which folds into the existing 0064 debt.

## Operator-owed (browser)

`tests/browser/os-paint.mjs` is written (launch from the shell, real-mouse pick
Filled Rectangle + a red swatch, drag a rect, assert the red interior composites
through the WebGPU compositor, close-box exit) but **UNRUN** here — Playwright
isn't installed in-repo. Run it in the browser sweep
(`node tests/browser/os-sweep.mjs --filter=paint`). This joins the standing 0064
browser-leg debt (0094 sound listen, 0095 snap feel, 0096 saver eyeball,
0101–0106 legs, the pointer-lock human check).

## Gotchas carried forward (trimmed to the live ones)

- **Win32 apps are ANSI (`#undef UNICODE`)**: macros gated on `#ifdef UNICODE`
  (e.g. `TranslateAccelerator`) are UNDEFINED — call the explicit W entry
  (`TranslateAcceleratorW`). comdlg32's file dialogs are W-only, so an ANSI app
  bridges with `MultiByteToWideChar`/`WideCharToMultiByte` (paint.c `a2w`/`w2a`).
- **Injected pointer coords are SURFACE coords**: `route_mouse` subtracts the
  20px menu bar, so a headless test adds `BAR` to client Y (winmine/paint
  convention). Canvas bitmap (bx,by) → surface (CANVAS_X+bx, CANVAS_Y+by+BAR).
- **comdlg32 dialog EDIT addressing**: an app with no main EDIT sees the
  dialog's dir EDIT as `EDIT:0` (readonly) and the name box as `EDIT:1` — set the
  name via `wmctl settext EDIT:1 <path>`, then `wmctl click Save`/`Open` (the
  dialog button is found ENABLED before the disabled owner's same-named menu).
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (hit + fixed this session).
  **Concurrent sessions exist: stage ONLY your own files.**
- **Don't edit bake inputs while a suite runs** (0082): `.md`/`tests/` are
  NOT inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`, `vendor/` are.
  Bump `image.json` `version` (now **67**) when seeded-source edits must reach a
  persistent browser OPFS image.
- **New kernel test files must be added to `tests` in run.js** (did so for
  test_paint_e2e.js). Check `build/test-*/summary.json` + per-file logs after an
  interrupted run; `--resume` picks up.
- **`GetDIBits`/`SetDIBits` are 32bpp-only** — 24-bit BMP save/load must repack
  rows (paint.c bmp_save/bmp_load). Colour asserts in tests sample a palette
  swatch pixel from the same shot to stay byte-order agnostic.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.

## Next in queue

`node todos/queue.js list` — after 0107: **0112** (mGBA GBA core → `/bin/mgba`),
then **0088**, **0079/0080**, **0052/0053**, the 0083/0084 pair, **0064** (WM
browser sweep round 3 — still owes the operator the pointer-lock check + the
0094/0095/0096/0101–0107 browser legs). Heavier P1→P3 tail after.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0106's recorded decisions (see todos/done/); **0107's
calls (one owner-drawn client + no child controls; tools in BOTH the menu and
an owner-drawn toolbox; 24-bit BMP not 32; single-level Undo; Cut/Copy/Paste
grayed until a v2 selection region + bitmap clipboard)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0107 Paint just landed;
next is 0112 mGBA). 0064 WM sweep round 3 still owes the operator the
pointer-lock check and the 0094–0107 browser legs (incl. the new
os-paint.mjs)."
