# Handoff — start of thread (updated 2026-07-11; 0105 cursor shapes closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0105 (pointer cursor shapes) is CLOSED**; image bumped **v64 → v65**
(seeded `winbox.c` + `user32.c` changed). Dev log
`logs/2026-07-11/0105-cursor-shapes.md`; item at
`todos/done/0105-cursor-shapes.md`; design updates in `todos/SDL3.md`
"Mouse" + `todos/WM.md` deviations. Two commits: `78023c1` (impl) +
`b369b89` (queue close). Pushed to main.

One breath: **the desktop pointer is no longer the browser's default arrow
everywhere.** Three drivers, ONE wire enum (`SDL_SystemCursor` values run
end to end): (1) **chrome resize cursors** — `kernel.js` `_wmCursorAt(x,y)`
mirrors `wmPointer`'s frame hit test (side-effect-free) → a **resizable**
frame's E/S edges read `ew-`/`ns-resize`, the SE corner `nwse-resize`;
fixed frames + title + desktop the arrow; (2) **app cursors** — real SDL3
`SDL_CreateSystemCursor`/`SetCursor`/show/hide in the compiler.js SDL veneer
→ `__sdl_set_cursor` → `SURFACE_SET_CURSOR` (0x1008) per-surface kernel
state, overlaid under the chrome hit test; (3) **user32 EDIT** —
`LoadCursorW(IDC_IBEAM)`+`SetCursor` over the same SDL path, `route_mouse`
sets the I-beam on EDIT hover. The kernel posts the EFFECTIVE cursor to the
UI bridge on every pointer-move CHANGE (`onCursor` → `{type:'cursor',
shape}`, debounced); os.html maps it to `canvas.style.cursor` via
`CURSOR_CSS`. The WM.md deviation (native cursor, no kernel sprite) STANDS
— only *which* native cursor. Headless it's assertable but never drawn (the
0063 glass rule): `WMP_CURSOR_AT` (0x34)/`R_CURSOR` (0x45) is a pure query,
`wmctl cursor X Y` prints the shape.

**Verified**: kernel suite **54/0** (`node tests/kernel/run.js`), unit
**708/0** (`node tests/run-unit.js`), win32 ports link check green, new
`tests/unit/sdl_cursor` (C contract) + `tests/kernel/test_cursor_e2e.js`
(winbox cursor client TEXT readback + EW/NS/NWSE frame + title/desktop/
fixed-frame arrow) + a leg in `test_user32_e2e.js` (smove over ctldemo's
Name EDIT → TEXT, STATIC → arrow).

**Manual browser tier NOT run this session** (no Playwright in this env):
`tests/browser/os-wm.mjs` grew a cursor leg (ew-/nwse-resize over a
resizable winbox frame, default over client/desktop) and
`tests/browser/os-user32.mjs` grew one (text over ctldemo's EDIT, default
over the button). **The operator should run `node tests/browser/os-sweep.mjs
--filter=os-wm` and `--filter=os-user32` to eyeball them.**

**Concurrent sessions:** while I worked, other agents added **0117**
(micropython upgrade) and **0118** (image overlays opt-in) to
`todos/queue.json` + their `.md` files — those are UNSTAGED in the working
tree and NOT mine. I staged only my own hunk of `queue.json` (the 0105
removal). Leave 0117/0118 to their owners.

**Next in queue**: `node todos/queue.js list` — **0118 (P0)** leads, then
0106–0107 (desktop-icon details/multi-select tail), 0112, … The 0064 WM
sweep round 3 still owes the operator the pointer-lock human check, the
0094 sound listen, the 0095 snap feel, the 0096 saver eyeball, and the
0101/0102/0103/0104/0105 browser legs.

## Gotchas carried forward (trimmed to the live ones)

- **0105: the compiler.js SDL veneer is ONE big template literal** — C
  comments there must NOT contain backticks or `${` (they close the JS
  string; bit me twice). The win32 veneer builds ANSI (`#undef UNICODE`),
  so `IDC_*` are LPSTR — don't pass them to `LoadCursorW(…, LPCWSTR)` or
  `==`-compare; LoadCursorW compares the ORDINAL (`ULONG_PTR`), and
  `update_cursor` calls the internal `cursor_token(shape)` directly.
- **0105: SetCursor debounces** (`cur == g_curCursor`) so per-move hover
  calls only reach the kernel RPC on a real change; SDL cursor objects are
  cached per shape. Only RESIZABLE surfaces get resize cursors (fixed
  frames read arrow — the 0024 scale-drag isn't advertised). The kernel
  emits a move's cursor from the CURRENT surface state then routes the
  motion, so an app's `SetCursor` lands for the NEXT move — headless tests
  sleep ~0.8s after an `smove` before `wmctl cursor`.
- **0105: `CURSOR_CSS` is duplicated** in host.js (module const) AND os.html
  (standalone HTML bridge, not a host.js importer) — keep them in sync.
- **0104: ctldemo carries a `.res` sidecar** (`ctldemo.res`, committed;
  seeded `/usr/bin/ctldemo.res`). Regenerate with `node tools/win32rc.js
  os/win32/ctldemo.rc -o os/win32/ctldemo.res` after editing the `.rc`.
- **0104: the disabled owner's stale ` focus` mark** — modal tests pick
  focus by id inside the `#32770` subtree, not by grepping ` focus`.
- **0104: `wmctl key` carries a 5th MOD arg** (SDL keymod; 256 = LALT) —
  the only way to drive Alt+mnemonic headless.
- **0103: the icon menu is 6 rows (120x116)** — OPEN / --- / CUT / COPY /
  DELETE / RENAME. The inline editor is a `desk_edit >= 0` branch in
  `desk_key`; `desk_edit_armed` is load-bearing for the menu-path focus race.
- **0101: the clock moved 14px LEFT** (Show Desktop sliver). Sample against
  `clock_left() = bar_w - SHOWDESK_W - CLOCK_W`.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — content is
  version-gated, so persistent browser images re-fetch on a version bump.
  The 5×7 wm.c font is A–Z uppercase-only.
- **0096: the saver default timeout is 900s ON PURPOSE** (above the 600s
  kernel-runner cap). Per-window INJECT_KEY/INJECT_POINTER do NOT stamp the
  idle clock.
- **0095: EV_SNAP_DROP fires at every title-drag end THAT MOVED** (past the
  4px slop). Headless chrome gestures = `wmctl sdown/smove/sup` (screen
  coords). `SDL_Delay` THROWS (no JSPI) — use `usleep`.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again. **Concurrent sessions exist:
  stage ONLY your own files** — this session had to `git apply --cached`
  just its 0105-removal hunk of `queue.json` to avoid committing 0117/0118.
- **`--filter` is single-valued** — passing it twice keeps only the LAST.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`,
  `vendor/` are. Bump `image.json` `version` (now **65**) when an
  interactive browser tab must pick up seeded-source edits.
- **New-runner habits**: check `build/test-*/summary.json` + per-file logs
  after an interrupted run; `--resume` picks up (used it this session — the
  suite got killed at teardown mid-run, `--resume` finished it). The kernel
  runner is a MANIFEST — new test files must be added to `tests` in run.js.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0104's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot); 0091 (fixed item lists, ONE flyout);
0092 (ops core header-only + shared; DnD non-goal); 0093 (trash store
layout; bin icon pinned to grid TAIL); 0098 (Start-menu two-pane panel);
0101/0102/0103/0104's calls; **0105's calls (native cursor deviation
STANDS — only which shape; SDL_SystemCursor is the wire enum end to end;
chrome resize cursors are resizable-only + fixed/title/desktop=arrow;
per-surface cursor via SURFACE_SET_CURSOR; user32 EDIT I-beam over the SDL
path; WMP_CURSOR_AT is a pure query; custom pixel cursors are OUT — system
shapes only; CURSOR_CSS duplicated host.js + os.html on purpose)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0105 cursor shapes
just landed; 0118 (P0 image overlays) leads now, then 0106–0107 desktop-icon
details/multi-select; 0064 WM sweep round 3 owes the operator the
pointer-lock check and the 0094/0095/0096/0101–0105 browser legs). Note
0117/0118 are concurrent sessions' in-flight work in the queue."
