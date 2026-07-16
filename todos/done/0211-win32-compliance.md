# 0211 — win32/user32 compliance + fail-loud pass

- **Status**: done (2026-07-16) — six fix commits: gdi32 UTF-8 text (per-code-point glyphs + synthesized tofu), EDIT WS_HSCROLL bar + UTF-8 caret + EN_*SCROLL + Get/SetScrollInfo (SCROLLINFO/SIF_PAGE), menu popup cascade (paint Tools▸Width was unreachable — the P0), gdi32 ROP/blit/DIB-stride/DrawText-prefix/TMPF batch, comdlg32 defExt/PATHMUSTEXIST + shell32 quoting + winmm fallback + kernel32 *.*/GetModuleHandle/map-protect + strsafe flags, user32 MB button sets/WM_INITDIALOG focus/WS_GROUP radios/LBS_MULTIPLESEL/BM_GETSTATE/SetFocus(NULL) + comctl32 re-park; fail-loud substrate __win32_unsupported/WIN32_UNSUPPORTED applied estate-wide (zero reports from the working app suite); audit remainder in WIN32.md §0211; image v98, kernel suite 73/73 + full sweep green; log: logs/2026-07-16/win32-compliance.md
- **Design**: todos/WIN32.md

## Goal

gucOS is POSIX; the win32 layer is ONLY the GUI toolkit API veneer. Two-sided
correctness pass over `os/win32/`:

1. **Compliance**: the surface we DO support behaves like real win32/user32
   (modulo deliberate POSIX divergences — the EDIT control's LF-native text
   model from 0210 stays; do NOT converge back to CRLF).
2. **Fail-loud**: anything we DON'T support fails loudly — a distinct
   `win32: unsupported <api/msg/flag>` diagnostic at the veneer's dispatch
   points (DefWindowProc, message pump, API stubs) instead of a silent no-op
   or wrong default. Silent no-ops read as mysterious app bugs (the 0210
   wheel/scrollbar gaps).

## Plan

- Audit user32.c / comctl32.c / gdi32.c / kernel32.c / comdlg32.c /
  advapi32.c / shell32.c + the standard controls against real Win32;
  enumerate divergences with file:line grounding.
- First slice (known, from 0210): EDIT renders ASCII only (non-ASCII UTF-8
  → "?"), no horizontal scrollbar despite WS_HSCROLL, no SetScrollInfo on
  the EDIT's built-in scrollbar, no EN_VSCROLL notification.
- Fix divergences on the supported surface, each with a regression test.
- Systematic fail-loud reporting; grep-able marker; verify it does NOT fire
  on the working app suite (fileman, notepad, ctlpanel, paint, winmine,
  ctldemo, k32demo).

## Acceptance

- Divergence audit recorded (dev log under logs/); supported-surface fixes
  landed each with a gucOS-specific regression test.
- Unsupported paths emit a grep-able loud diagnostic; a test proves the
  fail-loud path fires on a known-unsupported call; existing suites stay
  green (no loud-fail on working apps).
- Image version bumped; kernel suite + full browser sweep green.
