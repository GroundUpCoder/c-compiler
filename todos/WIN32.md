# WIN32.md — Win32 as the primary UI toolkit (user32 + gdi32 + kernel32 subset)

Decision 2026-07-09 (log: `logs/2026-07-09/win32-direction.md`): the primary
GUI toolkit for this OS is **Win32** — user32 windowing + gdi32 drawing + a
kernel32 subset — implemented as an app-side library over the existing
surface protocol (`WM.md`) and the POSIX kernel. This **supersedes** the
microui (0047) and Elm/MVU (0056) direction, which are **dropped**.

## Why Win32

- **Agent-drivability is a HARD requirement, and Win32 satisfies it by
  construction.** Every widget is an HWND in a persistent tree; Windows'
  own accessibility (MSAA / UI Automation) walks that tree and pokes it
  with messages. `wmctl click "OK"` becomes: `EnumChildWindows` → match
  text via `WM_GETTEXT` → `PostMessage(BM_CLICK)`. No pixel injection.
  Immediate-mode (microui/Clay) structurally cannot do this — its tree
  evaporates each frame, nothing to query.
- **C-native and closure-free.** `WndProc(hwnd, msg, wParam, lParam)` +
  a `switch` is `update(state, msg)` — the exact shape we liked in MVU,
  minus the reconciler. No GObject, no closures, no vtables.
- **The native architecture of the Win95 look** we already target.
- **A frozen, 30-year-stable API** with two open reference
  implementations to mine: **ReactOS** (a whole open-source Win32 OS in
  C — the blueprint, and its own user32/gdi32 to read) and **Wine** (the
  fidelity reference).
- **Source-level portability to Windows** and a real corpus of raw-C
  Win32/GDI OSS to port (`0060`) — a testing oracle immediate-mode
  toolkits don't have.

## The three surfaces and how each maps onto what we already have

**user32 → the surface protocol.** Top-level HWND ↔ `SURFACE_CREATE`;
child controls are drawn in-process (Wine-style, not OS surfaces).
Messages ↔ the per-process input ring; `WM_PAINT` damage ↔
`InvalidateRect` → `BeginPaint` over the surface HDC.

**gdi32 → CPU drawing into the shm surface.** `HDC` over the surface SAB;
`TextOut` via freetype (shared with `/bin/term`); shapes/blits are
arithmetic on the pixel buffer. See the drawing/compositing note below.

**kernel32 → POSIX.** `HANDLE`↔fd, `CreateFile/ReadFile`↔`open/read`,
`FindFirstFile`↔`readdir`, `VirtualAlloc`↔`mmap`, `CreateProcess`↔
`posix_spawn`, `QueryPerformanceCounter`↔`clock_gettime`. User-space
translation, no kernel change.

## Windowing vs drawing — the Windows 7 split (resolves "fully GPU?")

user32 (windowing, the HWND tree, the agent tree) is **independent of the
drawing layer**. Windows pairs one user32 with pluggable drawing: **GDI
(CPU) for legacy, Direct2D/DirectWrite (GPU) for modern**, both composited
by one GPU compositor (DWM). We do the same:

- **gdi32 = CPU drawing into an shm surface.** This is not a fallback and
  not a compromise — GDI *is* a CPU rasterizer; `TextOut`/`BitBlt` are CPU
  arithmetic on a bitmap. CPU-draw → shm → GPU-composite (`0055`) is
  *exactly* the DWM redirection model. There is no "GPU GDI", on Windows
  or here.
- **New GPU-native 2D rides a separate track (`0061` Cairo), NOT GDI.**
  "Fully GPU" only ever meant the apps that *can* be GPU: `webgpu.h`
  3D/native apps (already GPU) and new 2D apps on the Cairo track. It
  never applied to GDI.
- **No zombie**: gdi32-CPU and the GPU-2D layer serve *different* app
  corpora (ported Win32 apps vs new native apps), not the same job twice.

## Coexistence with POSIX

Additive veneers — the Wine/Cygwin model. The kernel (fds, processes,
rings, AF_UNIX, the doorbell) is untouched and remains the POSIX surface.
Win32 is a **second user-space library** calling the same primitives. A
program picks a veneer; both compile with `compiler.js`, both run as
ordinary processes. The kernel32 file/mem/time/process/dir parts are pure
user-space translation — no kernel change.

Frictions, in order of pain:
1. **Threads/sync — the one hard ceiling.** `CreateThread`,
   `CRITICAL_SECTION`, `WaitForSingleObject`, `Event`/`Mutex`/`Semaphore`.
   Threads are dropped from the queue (`0006`: processes are the
   parallelism unit), so the win32 layer is **single-threaded-apps-only**,
   consistent with POSIX. Most classic GDI apps are single-threaded (the
   message loop *is* the concurrency model), so this bounds *which* apps
   port, not the plan.
2. **UTF-16.** Win32 is natively `WCHAR`/UTF-16 (`...W` functions); POSIX
   is UTF-8/bytes. Convert at the boundary; the A/W dual-entry convention
   (implement W, shim A). Pervasive but mechanical.
3. **Registry (`advapi32`)** — a small file-backed hive.
4. **`OVERLAPPED`/IOCP and COM** — deferred; stub with clear failures.

## Staging (the queue)

`0057` gdi32 (CPU→shm drawing) → `0058` user32 (windowing + standard
controls + the HWND agent tree) → `0059` kernel32 (file/mem/time/process/
dir over POSIX; grows on demand) → `0060` OSS ports (ReactOS applets + the
corpus; a compile-test harness whose missing-symbol log drives 0057–0059).
Parallel drawing track: `0061` Cairo. Compositor track: `0062` zero-copy
present, `0063` Aero effects.

0059 landed 2026-07-10 (log: `logs/2026-07-10/win32-kernel32.md`):
`kernel32.c` + `advapi32.c` (the `$HOME/.win32reg` hive) + `crt16.c` (the
16-bit wide CRT + strsafe + wsprintfW). kernel32 is W-native — no ANSI
generic entries; the demanding corpus is UNICODE-only (windows.h section
note records it). Threads/LoadLibrary fail loudly per friction #1/#4.
After 0059 the PORTS.md demand is purely user32-W/menus/dialogs/
resources/comdlg32/shell32/winmm (winmine 29, notepad 64, calc 45).

0068 landed 2026-07-10 (log: `logs/2026-07-10/win32-winmine.md`): the
user32/resource tail — **winmine links, is seeded as `/bin/winmine`, and
is playable**. The resource story: a tiny rc compiler (`tools/win32rc.js`,
the STRINGTABLE/MENU/DIALOGEX/ACCELERATORS/BITMAP subset) emits a SIDECAR
pack `<binary>.res` — the PE-resource-section analog, found via argv0 at
the first Load*, zero link coupling (resource-less apps never know). The
WRES format in win32rc.js is the MUST-MATCH spec for user32.c's `res_*`
loader. user32 grew: the W entry points (per-window A/W marking; WM_SET/
GETTEXT translate at the send_msg choke), menus (HMENU tree; the BAR is
user32-drawn in the top 20px of the surface, client offset under it;
popups draw in-surface and clip — a surface can't overflow its kernel
window), accelerators, DialogBoxParamW over RT_DIALOG templates (the
MessageBox modal shape reused; "#32770" hosts both), SetTimer/WM_TIMER
(queue-dry delivery like WM_PAINT), RedrawWindow/AdjustWindowRect/
GetSystemMetrics (synthetic screen numbers)/the synthetic monitor, and
top-level MoveWindow -> the NEW `SDL_SetWindowSize` -> kernel
SURFACE_RESIZE (0x1007; owner-initiated resize, deliberately NOT gated on
the resizable bit — that bit protects apps from the WM, not from
themselves). gdi32 grew the mechanical W text wrappers; `shell32.c`
(ShellAboutW over MessageBox) and `winmm.c` (PlaySoundW success stub —
wave assets deliberately not vendored) are new veneer slices;
`wwinmain.c` is the wWinMain CRT entry shim UNICODE GUI ports list in
their bin.json sources. Menu items are agent targets: the tree dump lists
them and `wmctl click "Beginner"` posts the WM_COMMAND. Icons/cursors are
stub handles by design. After 0068: winmine 0 missing, notepad 64→27,
calc 45→15 — the tail is comdlg32/clipboard/printing (notepad) and
popup-menu-tracking/clipboard/keyboard-layout (calc).

0048 (desktop apps wave 1) is landing the app tail on top: **calc links,
is seeded as `/bin/calc`, and is usable** (log:
`logs/2026-07-10/desktop-apps-wave1.md`). The veneer grew: ONE text
clipboard (originally a file at `$HOME/.clipboard`; since todos/0090 the
KERNEL's clipboard slot via SDL_SetClipboardText/SDL_GetClipboardText —
cross-process, survives the writer exiting, shared with term's
Ctrl+Shift+C/V and `/bin/clip`; CF_TEXT/CF_UNICODETEXT are two views of
the same UTF-8 bytes; GetClipboardData handles are clipboard-owned and
cached),
keyboard translation (GetKeyboardState over the SDL modifier word +
MapVirtualKeyExW/ToAsciiEx against the one synthetic US layout — VKs for
punctuation ARE the modifier-applied keysyms, so only the US shift pairs
need reproducing), TrackPopupMenu (a STANDALONE popup on the 0068 overlay
machinery, barIdx == -1 + its own modal pump; coords are the owner's
SURFACE space, which is also what the new DefWindowProc WM_RBUTTONUP →
WM_CONTEXTMENU synthesis hands out, so the lParam pass-through pattern
round-trips; open popups are agent-visible — `popupmenu` in the tree,
items fire by label), WM_ENTERMENULOOP/WM_INITMENU/WM_INITMENUPOPUP/
WM_EXITMENULOOP notifications from the menu overlay, BS_OWNERDRAW →
WM_DRAWITEM with DrawFrameControl/DrawStateW, WM_CTLCOLORSTATIC (the
DLGPROC brush-through-return quirk honored), and comctl32.c
(InitCommonControls no-ops — one toolkit). **WRES is v2**: RT_DIALOG
records carry a `u16 menuId` (calc's templates attach their menu bars;
the dialog window grows by MENU_BAR_H so the template client area is
preserved). `wmctl click` with one argument is now ALWAYS the label form
— calc's keypad buttons are literally named "7".

**notepad links, is seeded as `/bin/notepad`, and is usable** (0048,
same log). The EDIT grew its around-a-file tail: EM_GETHANDLE/
EM_SETHANDLE (the buffer as an HLOCAL of WCHARs — internal storage
stays UTF-8, the external view materializes on demand with the app
owning replaced handles), EM_REPLACESEL (translated at the send_msg
choke like WM_SETTEXT), EM_LINEFROMCHAR/EM_LINEINDEX/EM_SCROLLCARET,
EM_GETMODIFY/EM_SETMODIFY, WM_CUT/COPY/PASTE/WM_CLEAR over the system
clipboard (0090) (+ the ^C/^X/^V/^A chords in the control), and no-undo
honesty (EM_CANUNDO FALSE keeps the menu item grayed). New veneer
slices: `comdlg32.c` — GetOpen/GetSaveFileNameW as a REAL modal
file-browser dialog (readdir LISTBOX, dirs-first, OK-on-directory
navigates, MUSTEXIST/OVERWRITEPROMPT/DefExt honored; OFN hooks and
custom templates deliberately not run — notepad's encoding combo
degrades to the current value), FindTextW/ReplaceTextW as modeless
dialogs speaking the RegisterWindowMessageW("commdlg_FindReplace")
protocol (FR_FINDNEXT/FR_REPLACE/FR_REPLACEALL/FR_DIALOGTERM; always
FR_DOWN), and ChooseFont/PrintDlg/PageSetupDlg as honest cancels; the
comctl32 STATUS BAR (self-bottom-parking, SB_SETPARTS/SB_SETTEXTW,
parts joined in WM_GETTEXT for the agent). user32 grew
RegisterWindowMessageW (per-process atoms — both protocol ends live in
one process here), Get/SetWindowPlacement, a minimal IsDialogMessageW,
MB_YESNOCANCEL (the save prompt; the type nibble now picks the button
set properly), SetProcessDefaultLayout/WinHelpW no-ops; gdi32 grew
SetMapMode (MM_TEXT only) + loud-failing StartDoc-family stubs;
shell32 grew ShellExecuteW (spawns via CreateProcessW),
SHAddToRecentDocs, and the DragAcceptFiles set as honest no-ops (no
DnD transport into surfaces). kernel32 fix that rode this: a BARE
argv0 (PATH spawn) now PATH-resolves in GetModuleFileNameW instead of
cwd-joining — notepad's New Window respawns GetModuleFileName's
answer, and the res_ensure sidecar probe gets the real path.

## Corpus status (0060 landed 2026-07-10)

`tools/win32ports.js` compile-tests every target in `os/win32/ports.json`
against the veneer and writes `os/win32/PORTS.md` — per-app missing
symbols + the aggregate demand table that IS the 0059+ order of attack
(`--check` runs in the kernel suite as the regression guard). Vendored so
far: **winmine** (Wine/ReactOS, LGPL), **notepad** (ReactOS, GPL),
**calc** (ReactOS IEEE build, GPL) — all UNICODE builds reaching the link
stage; per-dir READMEs pin the upstream commit and list local patches
(only `L"…"`→`u"…"`: WCHAR here is 2-byte UTF-16, libc wchar_t is 4-byte,
so TEXT()/_T() paste the `u` prefix). **sol is out** — ReactOS solitaire
is C++ (CardLib), outside the raw-C scope. Next corpus targets when
demand justifies: metapad (first non-ReactOS), PuTTY (the milestone).
The A/W convention landed with the corpus: implemented entries are ANSI
generic names, veneer sources `#undef UNICODE`, W variants are declared
and generic names map onto them under UNICODE; the 16-bit wide CRT uses
the `_tcs*` names as real symbols (see include/tchar.h for why not
`wcslen`). Resources (.rc — menus/dialogs/bitmaps/strings) are vendored
but not compiled: a resource story is part of the 0059+ demand.

## References

ReactOS `base/applications` + `rosapps` (C Win32 apps *and* an open
user32/gdi32 to read); Wine (API fidelity); Petzold *Programming Windows*
(the graded C sample corpus that sets bring-up order). Corpus is **raw-C
Win32/GDI only** — MFC/Qt/wx/.NET is out of scope.
