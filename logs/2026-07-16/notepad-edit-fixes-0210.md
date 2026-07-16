# notepad/EDIT fixes: LF newlines, WS_VSCROLL scrollbar, mouse wheel (todos/0210)

Three user-reported notepad defects, all in the one win32/user32 EDIT
control (notepad is vendored ReactOS notepad over the veneer).

## 1. "?" at end of lines — CRLF vs the POSIX rule

Root cause was NOT the EDIT being CRLF-native — it was already LF-native
(flat buffer split on '\n', Enter inserts '\n'). The text-IN paths
(WM_SETTEXT, EM_REPLACESEL, EM_SETHANDLE, WM_CREATE) copied raw bytes, and
ReactOS notepad's loader *deliberately re-normalizes to CRLF* before
EM_SETHANDLE (`ReplaceNewLines` in vendor/notepad/text.c — the Windows EDIT
contract). So every file open planted a \r at each line end; the text path
has no 0x0D glyph → "?".

**Decision (design rule, don't re-litigate): gucOS is POSIX → LF
everywhere. The win32 layer is only a GUI toolkit API; it must not impose
CRLF on the filesystem.** One `edit_normalize` (CRLF and lone CR → '\n')
now runs at every EDIT text-in path, in place (dst may alias src — the
write index never passes the read index).

The save direction fixed itself: notepad's `WriteText` scans for `\r\n` to
re-emit its per-file EOLN — with a pure-LF EM_GETHANDLE buffer the scan
never fires and the whole buffer writes verbatim, LF intact. No vendor
patch needed. (`Globals.iEoln` still *displays* the detected EOLN in the
status bar; harmless.) The pinned test expectations that encoded the old
CRLF contract (`test_notepad_e2e` content/clip checks) flipped to LF.

## 2. Built-in WS_VSCROLL scrollbar

notepad's EDIT declares WS_VSCROLL (both wrap modes) but the control never
drew a bar — only the standalone SCROLLBAR control class existed. The
multiline EDIT now draws the classic bar in the right 16px inside its 2px
well: arrow buttons line-scroll, the channel page-scrolls, the thumb is
proportional (`chan*rows/lines`, min 8px) and drags live. Scrolling is
`edit_vscroll` (clamped topLine, never moves the caret — the Win32 rule).
The classic message contracts landed too: WM_VSCROLL (SB_LINE*/SB_PAGE*/
SB_TOP/SB_BOTTOM/SB_THUMB*) and EM_GETFIRSTVISIBLELINE; SB_TOP/SB_BOTTOM
were missing from windows.h. Unlike SB_CTL (notify-only, the app moves the
position), the EDIT owns its built-in bar and scrolls directly.

## 3. Mouse wheel

The plumbing was complete — os.html wheel → kernel wmPointer('wheel') →
SDL ring → user32 pump, which already hit-tests the wheel to the child
under the cursor. The gap was (b): edit_proc had no WM_MOUSEWHEEL case.
Now: 3 lines per WHEEL_DELTA notch, with a fractional accumulator so
sub-notch trackpad deltas add up instead of vanishing.

**Second bug found while wiring the test:** the browser feed passed DOM
*pixel* deltas (~100/notch in Chrome) into SDL `wheel.y`, which consumers
scale by WHEEL_DELTA assuming SDL's ±1-per-detent. One physical notch
would have been ~100 notches. `routeInput` (os path) and SDL_WEB.wheelMsg
(standalone path) now convert to notches (pixels /100, lines /3, pages ×3).
Existing consumers (quake, sent, sdl-wheel-check) are sign-only —
unaffected; LISTBOX's existing wheel handler becomes correct in the booted
OS for free.

`wmctl wheel SID DY` (INJECT_POINTER kind 3) is the headless driver — the
wheel event's position is the last tracked motion, so `wmctl hover` first.

## Testing

`test_notepad_e2e` grew: CRLF load (no \r survives) + LF save round-trip +
agent-settext strip; a scrollbar pixel shot (COLOR_SCROLLBAR channel where
the pre-0210 EDIT was white) + arrow/channel/thumb legs; wheel ±3
lines/notch and top clamp. Scroll position is probed by *clicking the top
text row* and reading the status bar's "Line N" — the caret probe pattern
(scroll must not move the caret, the click reveals topLine exactly).
Gotcha for future legs: notepad shows the file dialog *first* and prompts
save-changes only after the dialog's Open button (DoOpenFile→DoCloseFile),
not before the dialog.

Image v97. Gates: win32 ports compile check, host + blockfs + kernel
suites, full browser sweep, booted-OS manual verification w/ screenshots.

Deeper EDIT/user32 gaps (no horizontal bar despite WS_HSCROLL/AUTOHSCROLL
multiline, no SetScrollInfo on the built-in bar, no EN_VSCROLL notify) are
left for the queued win32/user32 compliance pass.
