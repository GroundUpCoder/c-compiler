# win32/user32 compliance + fail-loud pass (todos/0211)

The win32 layer is gucOS's GUI toolkit veneer over POSIX. This pass had
two sides: make the surface we DO support behave like real Win32 (modulo
deliberate POSIX divergences — the EDIT's LF-native text model from 0210
stays), and make everything we DON'T support fail LOUDLY instead of
silently no-oping (the 0210 lesson: silent gaps read as mysterious app
bugs — the wheel/scrollbar holes hid for months).

## How the audit ran

Four parallel audit agents read the veneer against real Win32 semantics
(gdi32; kernel32+advapi32+crt16; comdlg32+comctl32+shell32+winmm; user32
minus EDIT), grounding every finding in file:line and weighing severity
by the in-repo consumers (winmine/notepad/calc ports, paint, fileman,
ctlpanel, ctldemo, k32demo, gdidemo). The EDIT/gdi32 first slice came
pre-scoped from 0210. Roughly 60 divergences + 40 silent stubs surfaced;
the ones fixed are below, the verified remainder is recorded in
WIN32.md's "0211 compliance audit" section (the durable list).

## The fail-loud substrate

`__win32_unsupported(fmt, ...)` (kernel32.c) prints ONE line per call
site — `win32: unsupported <what>` — via the `WIN32_UNSUPPORTED` macro
(win32_internal.h, once-per-site static); `WIN32_STRICT=1` escalates to
abort() for tests. The load-bearing property: **booting the whole app
suite emits zero reports**, so any report in a log is a real gap hit by
a real code path, not noise. The e2e estate now asserts both directions:
ctldemo's selftest triggers one deliberately (scroll API on a bar-less
LISTBOX) and the user32 e2e asserts the stderr line appears.

## What landed (7 commits)

1. **gdi32 text is UTF-8** (2e406b2): the glyph cache was ASCII-per-byte
   ('é' drew as two '?'s). Decode code points everywhere (shared
   `__u8_*` steppers in win32_internal.h), per-cp side cache, and a
   SYNTHESIZED tofu box for code points the face lacks — Roboto Mono's
   own .notdef is empty, so "render .notdef" would have been an
   invisible gap. Missing glyphs also report once.
2. **EDIT hscroll + UTF-8 caret + EN_*SCROLL + Get/SetScrollInfo**
   (faf9024): the whole 0210 wishlist. WS_HSCROLL draws a real bottom
   bar (arrows/channel/proportional thumb/drag/corner); multiline
   scrolls horizontally with ES_AUTOHSCROLL caret-follow (notepad's
   no-wrap styles); WM_HSCROLL contract; EN_VSCROLL/EN_HSCROLL on user
   scrolls only (notepad's status bar rides these); the caret walks
   whole code points (arrows, backspace/delete, hit-test, up/down column
   snap); WM_CHAR takes any code point and inserts UTF-8. SCROLLINFO
   lands; the Get/SetScroll* family routes by target (SB_CTL →
   SCROLLBAR + a real SIF_PAGE thumb model; SB_VERT/HORZ → the EDIT's
   built-in bars where bar state IS view state) — it used to poke
   h->ctl blindly, so SetScrollPos on an EDIT type-confused its state.
3. **Menu popups cascade one nested level** (73425bb, the audit's P0):
   an MF_POPUP inside a popup was a dead row — paint's Tools ▸ Width was
   unreachable by mouse or keyboard (only the agent's direct WM_COMMAND
   path worked, which is why tests were green — a lesson in itself:
   the agent tree can mask UI-reachability bugs). Hover/click/Right
   open the cascade, ► arrows draw, Left/Esc close the deepest level,
   keyboard nav lands on popup rows. WM_INITMENUPOPUP says
   fSystemMenu=FALSE for app popups; WM_EXITMENULOOP carries TRUE for
   TrackPopupMenu loops.
4. **gdi32 compliance batch** (58bbf13): unknown ROP3s refuse loudly
   instead of painting opaque black (the old fall-through copied a
   never-fetched S — the worst latent trap); out-of-source blit pixels
   leave the dest untouched; Get/SetDIBits honor biWidth as the DIB
   stride (over-read fixed); DrawText handles '&' mnemonics (strip +
   underline unless DT_NOPREFIX); TEXTMETRIC's inverted
   TMPF_FIXED_PITCH fixed (clear = fixed); DeleteObject on a selected
   pen/brush/font refuses like real GDI (live-DC registry) instead of
   dangling the DC.
5. **comdlg32/shell32/winmm/kernel32/crt16 batch** (e9d1842): defExt
   appends only when the typed name doesn't exist — extensionless files
   were unopenable in notepad/paint; OFN_PATHMUSTEXIST enforced;
   too-small lpstrFile fails loudly (was silent truncation + success);
   ShellExecuteW quotes paths with spaces (they split into argv);
   ShellAbout keeps the '#' tail; PlaySound falls back to SystemDefault
   on a failed SND_FILENAME and retries flagless names as paths; '*.*'
   matches everything (DOS rule — extensionless files vanished from
   listings); named GetModuleHandleW is an honest NULL (faked 'loaded'
   for any DLL); FILE_MAP_WRITE on PAGE_READONLY refuses (writes were
   silently dropped at unmap); strsafe's Ex flags act (calc passes
   STRSAFE_FILL_ON_FAILURE).
6. **user32/comctl32 batch + the fail-loud sweep** (a90067d):
   MB_ABORTRETRYIGNORE/MB_RETRYCANCEL button sets; WM_INITDIALOG
   FALSE = keep-my-focus; BS_AUTORADIOBUTTON groups bounded by
   WS_GROUP; plain LBS_MULTIPLESEL toggles; BM_GETSTATE; SetFocus(NULL)
   clears; status bar re-parks on any WM_SIZE; and the systematic
   reports (unknown classes, skipped dialog controls, control-message
   ranges at DefWindowProc, thread messages, SW_MINIMIZE family).
7. Image bump + this log (closing commit).

## Testing

Each fix carries a regression: gdidemo selftest grew 9 checks (UTF-8
extents/ink, tofu, ROP refusal, OOB-source, PatBlt negatives, prefix
strip+underline, selected-object delete refusal); ctldemo grew a
`selftest` mode (EDIT scroll/UTF-8 message contracts + the fail-loud
stderr assert) and a `menudemo` mode (the cascade driven through the
REAL menu UI via bar click + arrow keys over the kernel input ring);
k32demo grew *.*-extensionless / readonly-map / GetModuleHandleW legs;
notepad-e2e opens /root/Makefile through the dialog and asserts the
WS_HSCROLL bar pixels (its scrollbar-coordinate legs updated for the
16px hbar — the vbar ends higher now, and the thumb-drag grab point
moved to the thumb's actual center).

## Visual verification

Booted-OS screenshot (notepad, v98 image):
s3://groundupcoder/gucos/0211-notepad-utf8-hscroll.png — one frame shows
UTF-8 text rendering (é, an em-dash, Greek "λέξη"), the synthesized tofu
box where Roboto Mono lacks U+55E8, BOTH built-in EDIT scrollbars with
proportional thumbs and the dead corner square, and the status bar's
"Unix (LF)" (the POSIX newline model intact).

## Gotchas for the next reader

- The **agent tree can hide UI-reachability bugs**: AQ_CLICK posts
  WM_COMMAND directly, so a menu item can test green while being
  unreachable by mouse/keyboard. When adding menu-shaped features,
  drive at least one leg through real input (the menudemo pattern).
- Roboto Mono's `.notdef` is EMPTY — a "render glyph 0" fallback is
  invisible. If the seeded font ever changes, the tofu synthesis in
  gdi32 (`glyph_tofu`) stays the loud path regardless.
- The EDIT's scrollbar geometry is now part of two e2e tests' pixel
  math (notepad-e2e comments carry the derivation). Changing EDIT_SB_W
  or the bar layout means re-deriving those coordinates.
- `win32_internal.h` now carries plain-static `__u8_*` helpers by
  textual inclusion (the openwith.h precedent) — including it into a
  new veneer TU is free, but keep it out of app-side headers.
