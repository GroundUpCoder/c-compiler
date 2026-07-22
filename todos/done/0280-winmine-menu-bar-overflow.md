# 0280 — WineMine: menu bar overflows the beginner-width window ("Info" clips)

- **Status**: open
- **Design**: os/win32/user32.c menu-bar layout; vendor/winmine metrics; found by bughunt-sc

## Goal
Beginner WineMine is 154px wide (correct port metric) but the 20px-font
menu bar needs ~164px for "Options"+"Info" — the last item clips mid-glyph
at the window edge. Any narrow win32 window with 2+ menus has the same
exposure. The e2e clicks by agent label so it can't detect this.

## Plan
- Pick the mechanism: (a) tighten bar item padding when the bar would
  overflow, (b) real Windows behavior — wrap the bar to a second row and
  teach AdjustWindowRect/GetSystemMetrics the extra height, or (c) a
  minimum-width floor for menued windows. (b) is the general fix; (a) is
  the cheap one that covers winmine.
- Pixel-assert the last bar item's full text fits in test_winmine_e2e
  (label-click coverage stays as-is).

## Acceptance
Beginner WineMine shows "Info" complete; no port regression at
advanced/custom sizes.
