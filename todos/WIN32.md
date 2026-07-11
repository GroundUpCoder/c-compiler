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

## Scope boundary — we take the GUI toolkit, not the rest of Windows

The reason to take Win32 at all is the GUI toolkit (§"Why Win32"): a
persistent, agent-queryable HWND tree, a 30-year battle-tested widget
set, and a real OSS corpus. That is the *only* part of Windows we want.
The console/shell/batch world is explicitly **not** on the roadmap, and
this section records why so it isn't re-litigated.

### The CLI-convention decision (0111, POSIX-first stands)

POSIX is the first-class CLI convention everywhere in the system — hush
is `/bin/sh`, `compiler.js` and all `tools/*.js` parse only `-`/`--`,
and absolute paths are `/`-rooted. The only place Windows' `/`-as-flag
convention exists is *inside* the veneer, and it stays contained there.

The `/`-flag vs `/`-path ambiguity is **self-inflicted**: real Windows
never has it, because `/` means "flag" precisely *because* `\` is the
path separator (`dir /s` and `C:\foo` never collide). We manufactured
the collision by presenting POSIX `/`-paths to Win32 apps. Two clean
resolutions existed:

- **(A) POSIX paths + quote every arg** — the synthesized
  `GetCommandLineW` (`kernel32.c` `proc_info_init`) quotes every arg
  after argv0, so a bare `/root/x` arrives as `"/root/x"` and each
  port's option loop falls through to its standard quote-strip branch
  instead of eating `/r` as a switch. Minimal, contained. **This is
  what we do** (fixed 0111; notepad's `HandleCommandLine` was the
  trigger). It bets each app's arg parser has a quote-strip fallback —
  the MSVCRT `argv` splitter does; the GUI corpus holds.
- **(B) Present authentic Windows paths** (`C:\...`, backslashes) to
  Win32 apps at the boundary, killing the ambiguity with zero hacks —
  but only worth its pervasive cost if you commit to Windows *console*
  apps (below). Not chosen.

Rule: Windows CLI conventions never leak past the veneer boundary into
the POSIX layer. `/`-flag needs are handled **per-app, on demand**, the
way the corpus already grows via `PORTS.md` — so far only notepad
needed it.

### The real fork: the Console API is the expensive subsystem; cmd is downstream

"Port a batch shell (ReactOS `cmd`)" sounds like the way to get more
Windows CLI, but cmd is not the cost — the subsystem *under* it is, and
nothing in the corpus consumes it. As of 2026-07-11 the veneer has:

- **No Console API at all.** All of `AllocConsole`, `WriteConsoleW`,
  `ReadConsoleInputW`, `GetConsoleScreenBufferInfo`, `Get/SetConsoleMode`,
  `SetConsoleCursorPosition`, `WriteConsoleOutput`,
  `SetConsoleTextAttribute` are **absent**. `GetStdHandle`
  (`kernel32.c`) exists but returns plain file handles over fds 0/1/2 —
  not a console. Veneer apps do stdio via libc `printf` /
  `WriteFile`/`ReadFile` (thin `write()`/`read()` wrappers).
- **No console-input event channel.** stdin is a pure line-discipline
  byte tty; there is no `INPUT_RECORD` anywhere. `term` synthesizes
  bytes/escape sequences from SDL key events (`term.c` `handle_key`).
  cmd's raw-mode editor (arrow-key history, F7, doskey) reads keyed
  `INPUT_RECORD`s that would have to be synthesized back out of the
  tty byte stream — the nasty gap.
- **No environment-variable API.** `Get/SetEnvironmentVariableW`,
  `GetEnvironmentStringsW` absent; `CreateProcessW` ignores its env
  block (`(void)env`). Cheap to add, but net-new. (The process/file/
  find surface cmd needs — `CreateProcessW`, `WaitForSingleObject`,
  `GetExitCodeProcess`, `Get/SetCurrentDirectoryW`,
  `FindFirstFileW`/`FindNextFileW` — is present and real.)

Rough effort to get cmd actually running: env-var API ~½ day; **cooked**
Console API (console-backed `GetStdHandle`, `Get/SetConsoleMode`,
`WriteConsoleW`/`ReadConsoleW` over the tty) a few days; **full** Console
API (screen buffer, cursor, `WriteConsoleOutput`, attributes→ANSI,
`INPUT_RECORD` synthesis) 1–2 weeks; then cmd itself (ReactOS
`base/shell/cmd`, ~15–20k LOC — batch parser + dozens of built-ins,
most of which **re-implement busybox coreutils we already ship**) another
1–2 weeks plus a long tail. Call it **3–5 focused weeks, ~80 % in a
conhost-equivalent subsystem**, for **zero current consumers** and a
shell strictly worse than the hush already running as pid 1. Against the
almost-POSIX north star — where the Windows story is running *GUI*
apps — that is a bad trade.

### Decision

- **cmd / batch is a non-goal.** Not on the queue. Don't vendor
  `base/shell/cmd`.
- The GUI corpus stays first-class and grows on demand (`PORTS.md`).
- **Win32 console apps are a separate, demand-gated decision.** The
  question is never "port cmd" — it's "do we want to run Win32 *console*
  apps at all?" If yes, the deliberate investment is the **Console API
  subsystem** (that's the reusable unlock for the whole console-port
  class, and it's what would finally make option (B) authentic-paths
  worth it). Even then, port a small self-contained console app as the
  acceptance target first; cmd becomes an *optional* demo on top, never
  the reason to build the subsystem. ~90 % of the "we support Windows
  CLI" story comes from the Console API alone, without the 15k-LOC shell
  that re-implements `ls` and `cp`.

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
one process here), Get/SetWindowPlacement, IsDialogMessageW (Tab-order navigation
landed with todos/0104 — see below),
MB_YESNOCANCEL (the save prompt; the type nibble now picks the button
set properly), SetProcessDefaultLayout/WinHelpW no-ops; gdi32 grew
SetMapMode (MM_TEXT only) + loud-failing StartDoc-family stubs;
shell32 grew ShellExecuteW (spawns via CreateProcessW),
SHAddToRecentDocs, and the DragAcceptFiles set as honest no-ops (no
DnD transport into surfaces). kernel32 fix that rode this: a BARE
argv0 (PATH spawn) now PATH-resolves in GetModuleFileNameW instead of
cwd-joining — notepad's New Window respawns GetModuleFileName's
answer, and the res_ensure sidecar probe gets the real path.

0091 (context menus, 2026-07-11) rode the same primitive: the EDIT
control grew the standard WM_CONTEXTMENU menu (Undo/Cut/Copy/Paste/
Delete/Select All, built fresh per popup with state gating — Undo stays
grayed per the no-undo honesty above), and TrackPopupMenu grew modal
keyboard nav (Up/Down walk enabled rows, Enter fires, Esc closes,
everything else swallowed) plus right-button-down-outside close. The
wm.c desktop/taskbar menus are separate machinery (todos/WM.md — the
Start-menu furniture pattern, not this overlay). fileman's path EDIT
gets the menu for free; its file-LIST menu is 0092's.

0092 (fileman file operations, 2026-07-11) turned fileman from a
navigator into a real Explorer. The op CORE is `os/fileops.h`
(header-only, the openwith.h precedent — ONE implementation shared by
fileman AND wm.c, which is not a win32 app): recursive copy (symlinks
copy AS links, refuses dir-into-itself), move (rename(2) + EXDEV
copy-delete, refuses EEXIST — no silent overwrite), recursive delete,
the "Copy of"/"Copy (N) of" and "New Folder N" uniquifiers, and the
CLIPBOARD FILE LIST: a format-2 payload over the ONE 0090 kernel slot
("cut\n"/"copy\n" + one path per line), so cut/copy/paste crosses
processes. shell32 re-exports it as VENEER-LOCAL `SHFile*`/`SHClip*`
(NOT the real SHFileOperation double-NUL struct — no corpus consumer).
fileman.c: the right-click menu (Open/Open With[dir-gray]/Cut/Copy/
Rename/Delete/Properties on a row; Paste[clip-gated]/New Folder/
Refresh on the pane) over TrackPopupMenu, F2/Del/^C/^X/^V via a
runtime accelerator table (listbox-focus gated so the path EDIT keeps
its text chords), a rename DIALOG (the "Open with" picker pattern;
Enter/Esc route from the message loop, EEXIST keeps it open), delete
confirm (MB_YESNO) + Properties (stat) MessageBoxes, EROFS surfaced as
strerror(errno). New user32 surface: `AppendMenuA`,
`CreateAcceleratorTableA` + ACCEL/FVIRTKEY, `LB_ITEMFROMPOINT`, and —
the friction that fell out — AQ_CLICK now prefers an ENABLED match
(`agent_find_ex`, `Find.wantEnabled`) so modal-over-modal (an error
box over the rename dialog) is agent-drivable: a disabled
same-labelled button no longer shadows the live one. Delete is
PERMANENT until 0093 reroutes it. Tests:
`tests/kernel/test_fileman_ops_e2e.js` + `tests/browser/os-fileman.mjs`.

0093 (Recycle Bin, 2026-07-11) rerouted delete through a TRASH STORE.
The store lives in `os/fileops.h` (the shared core, so fileman and wm.c
behave identically): `/root/.recycle/files/` holds moved entries (name
clashes uniquified "x", "x 2", ...), `/root/.recycle/info/` one sidecar
per entry under the SAME stored name — line 1 the original absolute
path, line 2 the delete time as decimal Unix seconds (the Win95 INFO2
idea kept textual; the files/info split means an entry can't collide
with its own metadata). `fo_trash` refuses paths already in the store
(delete-in-store is permanent) and sweeps fo_move's EXDEV partial copy
on failure, so a refused trash (EROFS under /usr) never strands a store
entry; a failed sidecar write rolls the move back. `fo_restore` returns
an entry to its recorded path — EEXIST when occupied, the caller
prompts-and-replaces; `fo_trash_forget` drops the sidecar of a
permanently deleted entry; `fo_trash_empty` clears both dirs. shell32
re-exports the set as `SHFileTrash`/`SHFileRestore`/`SHRestoreTarget`/
`SHTrashForget`/`SHTrashEmpty`/`SHTrashCount`/`SHTrashFilesDir`
(veneer-local, the 0092 convention). fileman.c: Del/menu Delete confirm
with Recycle-Bin wording and trash; Shift+Del (FVIRTKEY|FSHIFT
accelerator) bypasses to a confirmed permanent delete; browsing the
store (cwd == files/) swaps the row menu to Restore/Delete/Properties
and the pane menu to Empty Recycle Bin (confirmed, grayed when empty) /
Refresh, with in-store deletes permanent. The desktop side is wm.c's
(WM.md); the bin ICON is a real `/root/Desktop/Recycle Bin` launcher
script (`#!/bin/sh` → `fileman /root/.recycle/files`) recreated by wm.c
at startup, so double-click rides the plain activate() path and
pre-0093 images grow a bin without a reseed. Non-goals kept: no quota
(unbounded until Empty), no /usr trashing (EROFS is the answer), no
dedicated bin app. Tests: `tests/kernel/test_recycle_e2e.js` +
`tests/browser/os-recycle.mjs`.

0094 (sound scheme, 2026-07-11) made WINMM's `PlaySound` REAL. The ONE
policy core is `os/sounds.h` (header-only, the openwith/fileops
precedent — wm.c's boot chime and winmm.c are the same code): the scheme
store is first-existing-of `~/.config/sounds`, `/etc/sounds`,
`/usr/share/sounds/scheme` (whole-file, `EVENT<ws>WAV-PATH` lines,
`none` = explicit per-event silence, reserved `mute on` = silence all),
the WAV parser takes PCM u8/s16 mono/stereo, and playback is
fire-and-forget through the 0017 mixer via the SDL3 audio-stream veneer
(open at the clip's spec, push whole, resume, destroy — AUDIO_CLOSE
drains dry kernel-side; pumpless kernels drop silently). winmm.c layers
the PlaySound contract on top: one current sound per process (new play
stops it; SND_NOSTOP refuses), SND_ALIAS/FILENAME/MEMORY resolution,
unknown-alias → SystemDefault unless SND_NODEFAULT, SND_SYNC as a
duration-capped queue poll (usleep, NOT SDL_Delay — that throws by
design), PlaySound(NULL)/SND_PURGE stop. Deliberate: SND_RESOURCE stays
silent success (corpus .wavs not vendored; winmine ticks every second —
no default-ding fallback), SND_LOOP plays once (looping needs a
process-side refill pump fire-and-forget doesn't have). user32 grew a
real `MessageBeep` (icon nibble → Win95 alias names) and MessageBox
beeps its icon's event at open; ctlpanel grew the Sounds applet (enable
checkbox → `snd_set_mute` writes the user store with the effective
table carried forward + a Test button). The clips are SYNTHESIZED
(`tools/mksounds.js`, committed under `os/sounds/`, baked to
`/usr/share/sounds/` by image.json v55) — real Windows media is
copyrighted. Tests: `tests/kernel/test_sounds_e2e.js` +
`tests/browser/os-sounds.mjs` + the ctlpanel e2e Sounds legs; the
0017 pump grew spent-tail reclaim (WM.md Lifecycle) with a
`test_audio.js` case.

0104 (dialog keyboard, 2026-07-11) made dialogs keyboard-native — the
0058 descope ("no Tab-order navigation") coming due. `IsDialogMessageW`
grew the full pre-translation: **Tab/Shift+Tab** walk the WS_TABSTOP
controls (`GetNextDlgTabItem`, depth-first creation order, wrap),
**Alt+mnemonic** jumps/presses the `&`-marked control (buttons press;
STATIC hands focus to the next tabstop — the Win32 label rule),
**Enter** fires the DEFPUSHBUTTON (or a focused pushbutton, or a newline
in a multiline edit), **Esc** = IDCANCEL (else IDOK, else the legacy
WM_CLOSE), and **arrows** move within a WS_GROUP radio run
(`GetNextDlgGroupItem`, auto-checking). Routing is generic: every
standard control answers `WM_GETDLGCODE` (EDIT flags WANTALLKEYS only
for VK_RETURN when multiline, so Tab still navigates), so app custom
controls participate. It's wired into BOTH modal loops
(DialogBoxParamW's template path AND MessageBox's #32770), and DefDlgProc
gained DM_GETDEFID/DM_SETDEFID/WM_NEXTDLGCTL. Rendering followed:
pushbutton/checkbox/static labels underline the mnemonic glyph, the
default button draws the classic black outline. LISTBOX picked up
PageUp/PageDown along the way. The `os/win32/ctldemo.rc` → `ctldemo.res`
sidecar seeds an Options template dialog (mnemonic'd `&Name`/`&Verbose`/
`&OK`/`&Cancel`) as the acceptance surface. Tests:
`tests/kernel/test_user32_e2e.js` (session B drives Tab/mnemonic/default/
Esc via the kernel INJECT_KEY path, `wmctl key SID SC SYM MOD`, MOD 256 =
LALT; the MessageBox leg too) + `tests/browser/os-user32.mjs` (the real
page keyboard). winmine's custom-board dialog gained Tab/Enter for free.
comdlg32's `WCFileDlg`/`WCFindDlg` (bespoke, not `#32770`) also got it —
WS_TABSTOP + a default button + the loop wiring (the file dialog) or just
the tabstops (Find/Replace is modeless, notepad's loop already pumps
IsDialogMessage), so **notepad's Save As is fully keyboard-driven**: type a
name, Enter saves (`test_notepad_e2e.js` keyboard leg). IsDialogMessageW is
top-level-generic, not `#32770`-coupled — it walks `dlg->child` and scans
for the BS_DEFPUSHBUTTON style.

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
