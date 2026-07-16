# 0210 — notepad/EDIT: LF newlines + vertical scrollbar + mouse-wheel scroll

- **Status**: done (2026-07-16) — edit_normalize strips CRLF/lone-CR at every EDIT text-in path (LF save round-trip for free via WriteText's dead \r\n scan), built-in WS_VSCROLL scrollbar (arrows/channel/proportional thumb + WM_VSCROLL/EM_GETFIRSTVISIBLELINE), WM_MOUSEWHEEL 3 lines/notch with fractional carry + browser wheel feed converted px→SDL notches + `wmctl wheel`; image v97, kernel suite + full sweep green, booted-OS screenshots; log: logs/2026-07-16/notepad-edit-fixes-0210.md
- **Design**: todos/WIN32.md

## Goal

Three user-visible defects in notepad (vendored ReactOS notepad over the
win32/user32 EDIT control):

1. **"?" at end of every line when opening a CRLF file.** The EDIT is
   LF-native but its text-in paths (WM_SETTEXT / EM_REPLACESEL /
   EM_SETHANDLE / WM_CREATE) copied raw bytes; notepad's loader normalizes
   to CRLF before EM_SETHANDLE, so a stray \r sat on each line and rendered
   as "?" (no 0x0D glyph). Design rule: **gucOS is POSIX → LF everywhere;
   the win32 layer is a GUI toolkit API and must not impose CRLF on the
   filesystem.**
2. **No vertical scrollbar.** notepad's EDIT declares WS_VSCROLL but the
   control never drew or served a built-in bar.
3. **Mouse wheel doesn't scroll the EDIT.** The pump hit-tests
   WM_MOUSEWHEEL to the child under the cursor, but edit_proc had no
   handler. (Also: the browser feed passed DOM pixel deltas into SDL
   wheel.y — ~100x off from the notch units consumers assume.)

## Plan

- `edit_normalize` (CRLF + lone CR → LF) at every EDIT text-in path; a
  pure-LF buffer makes notepad's WriteText a verbatim write, so save →
  reopen stays LF with no vendor patch.
- Built-in WS_VSCROLL bar on the multiline EDIT: arrows, page-scroll
  channel, proportional draggable thumb, WM_VSCROLL + EM_GETFIRSTVISIBLELINE
  contracts.
- WM_MOUSEWHEEL in edit_proc (3 lines/notch, fractional accumulation);
  routeInput/wheelMsg convert DOM deltas to SDL notches; `wmctl wheel`.

## Acceptance

- test_notepad_e2e: CRLF load with no \r + LF save round-trip + agent
  settext strip; scrollbar pixel shot + arrow/channel/thumb legs with exact
  status-bar caret probes; wheel ±3 lines/notch + top clamp. All green.
- Kernel suite + full browser sweep green on the v97 image; booted-OS
  manual verification with screenshots.
