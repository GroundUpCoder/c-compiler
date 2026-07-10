# 0068 — win32 user32/resource tail: winmine playable

Closes `todos/0068`. The third and last slice of the winmine demand log
(0057 gdi32 → 0058 user32 core → 0059 kernel32 → this): the UI half of
the missing-symbol list — W entry points, resources, menus, accelerators,
dialog templates, timers, monitors/metrics, and the one genuinely new
kernel capability, owner-initiated surface resize. Winmine went from 29
missing symbols to seeded-and-playable; notepad fell 64→27, calc 45→15
for free (shared symbols).

## The resource story: a sidecar pack, not linked-in tables

The 0068 item left the resource design open (tiny rc compiler vs
hand-baked blobs vs compiled-in tables). Decision: **a tiny rc compiler
(`tools/win32rc.js`) emitting a sidecar pack `<binary>.res`** that
user32 finds via argv0 at the first `Load*` call.

Why sidecar won:
- **Zero link coupling.** A linked-in table needs either weak symbols
  (untested in this toolchain) or every resource-less app (gdidemo,
  ctldemo, k32demo) carrying an empty stub. The sidecar leaves them
  untouched — they simply never open the file.
- **It IS the PE model, translated.** Windows resources live in a section
  of the .exe next to the code; here they live in a file next to the wasm
  binary. Same lifecycle (ship with the binary, upgrade with the binary),
  same lookup key (type, id).
- The pack format (WRES) is deliberately not Microsoft's .res — a minimal
  versioned TOC + per-type layouts documented in win32rc.js, which is the
  MUST-MATCH spec for user32.c's `res_*` loader.

The compiler handles the corpus subset: a line preprocessor (#define /
#ifdef trees / quoted includes — that's how `lang/en-US.rc` rides in),
STRINGTABLE, MENU, DIALOG(EX) with the standard control keywords and
default styles, ACCELERATORS, and file-backed BITMAP/ICON/WAVE. Missing
binary assets are skipped LOUDLY (stderr) — winmine's .ico and .wavs are
deliberately not vendored (icons/cursors are stub handles; PlaySoundW is
a success stub per the item's v1 acceptance). `vendor/winmine/winmine.res`
is a committed artifact; the README pins the regeneration command.

## The MAKEINTRESOURCE trap (the day's real bug)

Windows detects `MAKEINTRESOURCE(id)` with `value < 0x10000` — sound
there because the first 64KB of address space is never mapped. Here it
cost an hour: **this compiler's wasm layout puts the C STACK in the low
pages** (static data starts at `stackPages * 64K`), so winmine's
stack-resident class-name string (`WCHAR appname[20]` in wWinMain) has an
address ~0xEE00 and was silently eaten as an "integer resource id" —
RegisterClassExW registered a NULL name and CreateWindowW found no class;
winmine exited 1 with no output.

Fix (`user32.c is_intres`): a low value must ALSO sit at-or-below a fresh
local's address to be treated as an id. The stack grows down, so a caller
pointer into the stack is always ABOVE the callee frame; real ids (1..~32K,
IDC_ARROW = 32512) sit below any live frame in practice. Documented at
the function — this will bite anyone porting Windows heuristics that rely
on the "low memory is unmapped" invariant.

## Menus: the bar is user32's, drawn in the surface

Windows menus are separate HWNDs that overflow the window; a kernel
surface can't do that, so popups draw INSIDE the surface and clip to it
(they fit on a beginner board — barely: 11 rows ≈ 178px inside a 202px
surface). The bar occupies the top `MENU_BAR_H` (20) pixels; everything
client-side offsets under it — `GetDC`/`GetClientRect`/input routing/
`WM_SIZE` all subtract the bar, and `AdjustWindowRect(menu=TRUE)` adds it
back, so winmine's `MoveWindow(board + AdjustWindowRect)` arithmetic
round-trips exactly (beginner = 154x182 client = 154x202 surface —
`wmctl list` shows the number the test pins).

The overlay (bar + open popup) redraws at EVERY present, from `ReleaseDC`
before `SDL_UpdateWindowSurface` — a CPU rasterizer redrawing ~20 rows of
text is nothing, and it makes the ordering unconditional: whatever the
app painted, the bar is on top. Closing a popup just invalidates the
whole window (0058's whole-window damage model) and the app repaints
under it.

Menu items are AGENT TARGETS: the tree dump lists
`menu popup text='Options'` / `menuitem id=1005 text='Beginner' checked`
lines, and `wmctl click "Beginner"` posts the WM_COMMAND directly — no
popup needs to open, no pixels (OS.md's agent pillar extends to menus for
free). Labels strip '&' and cut at the accelerator tab, same rules as
button labels.

Deliberate v1 bounds (documented in user32.c's header): mouse + ESC only
(no Alt-mnemonics, no arrow-key nav), popups taller than the surface
clip.

## Owner-initiated resize: SURFACE_RESIZE (the one kernel change)

Winmine resizes its window per difficulty (`MoveWindow` on a top-level).
The kernel deliberately had "no client-initiated resize" (0019) — resize
was WM/drag-initiated, gated on the resizable bit (0021) so the WM can't
shear fixed-size apps. Sizing YOURSELF is a different thing: the owner
knows its content. New RPC `SURFACE_RESIZE` (0x1007) — owner-checked, NOT
gated on the resizable bit, reusing the whole 0019 machinery verbatim
(pendingConfigure → WINDOW_RESIZED ring event → host allocates the new
SAB → first new-size present acks via SURFACE_CONFIGURE, tear-free). The
SDL surface layer: new `SDL_SetWindowSize` (compiler.js decl + __SDL.c
forward + host import in all four env flavors; kernel-surface flavors do
the RPC, standalone/null fail loud per SDL3's bool contract). Apps see
ONE resize path — the new size always arrives as SDL_EVENT_WINDOW_RESIZED.

This was the only kernel.js/host.js/compiler.js change in the slice;
everything else is app-side veneer, keeping the 0059 discipline.

## Dialogs, W entries, the rest

- **A/W**: windows/classes carry an `isW` mark (set by the W registration
  APIs); WM_SETTEXT/WM_GETTEXT translate at ONE choke point (`send_msg`)
  when caller charset ≠ window charset — the Windows model. Everything
  else converts at the API boundary. DefWindowProcW speaks UTF-16 over
  the same UTF-8 internal storage. Kernel32's converters return 0 on
  short buffers (correct for its callers), so user32 grew truncating
  variants (`a2w_trunc`/`w2a_trunc`) — window text APIs must truncate.
- **Dialog templates**: DialogBoxParamW instantiates the WRES RT_DIALOG
  record — "#32770" top-level + child controls, dialog units scaled by
  the stock font (du*avgW/4, du*charH/8). The class now hosts BOTH
  MessageBox (no DlgState, 0058 behavior verbatim) and template dialogs
  (DLGPROC gets first crack; WM_CLOSE → IDCANCEL). EndDialog marks; the
  modal loop (MessageBox's shape) exits and destroys.
- **wWinMain**: `os/win32/wwinmain.c` is the CRT entry shim — UNICODE GUI
  ports list it in bin.json `sources` (Windows picks the CRT entry at
  link time; here the manifest does). Deliberately not in lib.json: apps
  with their own main() must not collide.
- **Timers**: SetTimer/WM_TIMER delivered queue-dry like WM_PAINT from
  the GetMessage scan; TIMERPROC fails loud (corpus passes NULL). The
  25ms park ceiling bounds jitter — winmine's 1s clock is fine.
- **GetSystemMetrics/monitors are synthetic** (800x500 etc.): a process
  cannot see the real screen (only the WM can, EV_SCREEN); the numbers
  exist so ports' clamping math runs. Positions are the WM's anyway —
  top-level MoveWindow applies SIZE only and echoes x,y back through
  WM_MOVE so winmine's saved-position round-trips through the registry.

## Tests

`tests/kernel/test_winmine_e2e.js` (in the kernel suite): geometry
(154x202 → 266x314 → back, the SURFACE_RESIZE proof), menu tree +
check states, popup open/ESC-close pixel diffs, cell-reveal pixel diff,
WM_TIMER LED movement, F2 accelerator reset (pixels restore), Fastest
Times + Custom Game dialogs (agent settext into template EDITs, OK
applies via GetDlgItemInt → 186x250), exit → registry hive, and a second
boot restoring the custom board (LoadBoard over advapi32). Browser leg:
`tests/browser/os-winmine.mjs` (real mouse on the bar/board, agent
resize, exit). `tools/win32ports.js --check` pins winmine at
`expect: links`.

Image v37→v38 (all binaries rebuilt — the compiler.js SDL addition is a
libc-level change; winmine + winmine.res seeded; deliberately NO Start
menu entry and NO Desktop icon — both have geometry-pinned tests
(`test_wm_service_e2e`, `os-shell.mjs`, `os-drop.mjs`) and the k32demo
precedent says new apps join the menu only when a slice wants to own
updating those goldens).
