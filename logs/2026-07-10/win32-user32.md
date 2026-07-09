# win32 user32: windowing + controls + the agent tree (todos/0058)

Second slice of the Win32 veneer (design `todos/WIN32.md`; gdi32 was
`todos/done/0057`): `os/win32/user32.c` — window classes, the HWND tree,
the classic blocking message loop, WM_PAINT damage, input routing, the
standard controls, MessageBox, and the accessibility/agent tree that
makes discrete widgets `wmctl`-drivable by LABEL, recording OS.md's
agent-target pillar. `/bin/ctldemo` (Petzold-style controls + dialog
sample) is the acceptance app; gdidemo converted from the 0057 scaffold
to a real message-loop app.

## The hard problem: a blocking GetMessage in this runtime

Every SDL app here uses the frame-callback model — main() returns,
`__setAnimationFrameFunc` drives frames, and host.js drains the kernel
input ring into the wasm event queue *before each frame tick*. A Petzold
app's `while (GetMessage(&msg, ...))` never returns from main, so no
frame ticks ever run and no input would ever arrive. Porting real Win32
sources (the whole point — 0060's corpus) demands the classic loop work
unmodified.

Resolution, two small runtime seams (the first host/kernel change the
veneer has needed):

- **host.js `__sdl_pump_wait(timeoutMs)`** (surface backend, both
  flavors): an env import that drains the input ring into the SDL event
  queue *from inside a wasm import call* — re-entrancy into the wasm
  exports mid-main is fine — and, when the ring is dry, `Atomics.wait`s
  on `IR_WPOS` up to the timeout. Returns whether a ring exists so the
  caller can pace itself pre-window (kernel-timed `select()` sleep).
- **kernel.js `_wmPushEvent`**: one `Atomics.notify(ring.i32, IR_WPOS)`
  after the write — the kernel already rang the process doorbell; now
  the ring itself is a wakeable address. Input wakes a parked GetMessage
  INSTANTLY; the ring layout is unchanged (comment updated).

GetMessage's idle shape: pump SDL events → poll the agent socket →
posted messages → WM_PAINT scan (only when the queue is dry — Windows
priority) → WM_QUIT → park 25ms in `__sdl_pump_wait`. The 25ms ceiling
exists only for the agent socket (a connect doesn't notify the ring);
keyboard/mouse latency is ~0. Signals stay claimable: the agent poll's
`select()` is a kernel RPC, i.e. an env-import safe point, so a
cooperative SIGTERM lands within one idle cycle.

## user32 ↔ gdi32: the seam moved

0057 promised "BeginPaint/GetClientRect were written against the opaque
handle so 0058 swaps innards only" — delivered, and then some: the
`__gdi_bind_hwnd` scaffold is DELETED (no zombie). gdi32 now exposes one
internal constructor (`win32_internal.h`): `__gdi_dc_wrap(bits, w, h,
stridePx)` wraps a raw RGBA span as a screen-kind DC. user32 owns
GetDC/ReleaseDC/BeginPaint/EndPaint/GetClientRect: a child control's DC
is the top-level surface pointer offset to the child's client origin
with w/h clamped — child drawing needs no origin support in the
rasterizer at all (negative-origin/degenerate cases draw into a 1x1
scratch). Present stays `SDL_UpdateWindowSurface` per ReleaseDC/EndPaint
(shm mailbox flip). Top-level HWND ↔ SDL window ↔ kernel surface; child
controls are in-process, Wine-style — the kernel never learns about the
tree.

## Windows semantics kept honest

- Lifecycle order WM_CREATE → WM_SIZE → WM_MOVE at create; WM_PAINT via
  invalidation only (BeginPaint validates; DefWindowProc(WM_PAINT)
  validates for apps that don't paint). The e2e asserts CREATE < SIZE <
  PAINT on stdout.
- TranslateMessage → WM_CHAR is table-free because SDL3 keysyms are
  MODIFIER-APPLIED (Shift+a ⇒ 'A' — pinned by todos/SDL3.md; do not
  "fix"). Ctrl+letter → control chars. VK codes map from sym for
  letters/named keys, from the scancode for the shifted digit row. The
  keysym rides a side slot in the queue entry (MSG has no room);
  GetMessage stashes it for the following TranslateMessage — safe
  because the loop is sequential by construction.
- SCROLLBAR is notify-only (first cut self-updated on arrow clicks —
  wrong: Windows scrollbars move only when the app calls SetScrollPos in
  WM_V/HSCROLL; a ported app would double-step). Thumb drag tracks
  visually via a separate dragPos and snaps back unless the app commits
  — the Petzold COLORS1 shape.
- MessageBox is a REAL modal: own top-level (class `#32770`), nested
  GetMessage loop, owner top-level disabled for the duration (input
  routing drops events into disabled subtrees), WM_QUIT re-posted if it
  races the modal. Returns IDOK/IDCANCEL/IDYES/IDNO; close-box maps per
  type.
- The kernel's close (title-bar 'x'/wmctl close) arrives as a
  process-wide SDL_EVENT_QUIT (the ring record's sid is dropped by the
  push export's ABI) — routed as WM_CLOSE to the first live top-level.
  Per-window close needs a push-export ABI change (libc → full rebake);
  0060 growth item.

## The agent tree (wm_agent.h)

First CreateWindowEx binds `/run/win32/agent.<pid>.sock` (unlinked at
exit via atexit); the GetMessage/PeekMessage idle loop accepts and
serves one request per connection — process-side AF_UNIX
bind/listen/accept/select all existed since 0008, unused until now.
Protocol frames mirror wm_proto.h. `wmctl` grew `tree` (scan
/run/win32, dump every process's HWND tree — class/id/rect/LIVE
WM_GETTEXT text, newline-escaped), `click LABEL` ('&'-stripped exact
match, buttons first; BM_CLICK for buttons, synthetic client-center
click otherwise), `gettext`/`settext`. "CLASS:n" (EDIT:0) addresses
controls whose text is their content. `wmctl click` stays
backward-compatible: `click SID X Y` (3 numeric args) is still the
pixel injection; one non-numeric arg is the label form. The acceptance
bar — `wmctl click "OK"` presses a named button headlessly, observed
via the app's WM_COMMAND handler, **no pixel coordinates** — is the
test's literal shape.

## Gotchas found

- A test splitting sections on `'\n=='` truncated `wmctl tree` output at
  its own `== pid N` lines — two phantom failures that looked like a
  missing second app. Sections now cut at explicit `==cut` echoes.
- The Start-menu geometry gotcha struck as predicted: seeding
  `/usr/share/menu/ctldemo` (sorted FIRST) shifted every entry index and
  the menu box to 150x188+0+552 — `test_wm_service_e2e.js` (winbox click
  row y=154 → 174) and `os-shell.mjs` (MENU_Y) updated together.
- gdidemo no longer repaints every frame (real WM_PAINT semantics); the
  bit-exactness leg of test_gdi32_e2e still passes because the shm
  buffer persists between shots.

## Deferred (grow under 0060's missing-symbol log, don't gold-plate)

DialogBox from resource templates, menus/accelerators, SetTimer/WM_TIMER
(hence a solid, non-blinking caret), clipboard, Tab-order navigation
(IsDialogMessage), WinMain→main shim, per-window kernel close routing,
GetSystemMetrics, top-level SW_HIDE.

## Tests

- `tests/kernel/test_user32_e2e.js` (in the kernel suite): lifecycle
  order, tree dump contents, label click → WM_COMMAND, EDIT focus +
  kernel-key typing + gettext round-trip, settext, checkbox, LISTBOX
  select/dblclick via local-coord click, scrollbar notify → app
  SetScrollPos, MessageBox modal (owner en=0 in the tree; Cancel → 2,
  OK → 1), two-process tree scan, clean quit + socket unlink.
- `tests/browser/os-user32.mjs`: same layout through the real
  compositor + page input — Win95 chrome pixels, typed text + real
  mouse click → WM_COMMAND, wmctl-by-label from the in-OS shell,
  MessageBox composited, Quit restores the desktop.
- Suites this session: unit 699/0/3 (no libc change), blockfs 12/12,
  kernel suite ALL PASS (incl. the new file), full browser sweep serial
  — os-boots/wm/vt/screen/scale/shell/gdi/term/doom/gpubox/quake all
  PASS; os-user32 flaked once on its first post-VT-switch gesture
  (SETTLE pauses added per the sweep rule), then 3/3 PASS.

Image v34 → v35 (new seeded binary + menu entry + rebuilt win32 lib);
`os/os-system.img` rebaked via `node tools/mkimage.js`.
