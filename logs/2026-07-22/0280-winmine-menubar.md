# 0280 — winmine menu bar overflow: tighten bar padding on overflow

**Bug.** Beginner WineMine is 154px wide (correct port metric: 9×16 board
+ 10), but at the 20px system font (v133 retune) the menu bar's classic
16px/item padding put "Options"+"Info" at ~164px — "Info" clipped
mid-glyph at the window's right edge ("Options Inf|c"). The e2e drives
menus by agent label, so it never saw pixels. Any narrow win32 window
with 2+ menus had the same exposure; Win95's 8px menu font never hit it.

**Mechanism chosen: (a) overflow-gated padding tighten** (over (b) bar
wrap and (c) a min-width floor). `menu_bar_pad(top)` in user32.c keeps
the classic 16 (8 a side) whenever `2 + Σtext + n*16` fits the window
width — so every bar that fit before is byte-identical — and otherwise
splits the leftover width evenly per item, floor 6. Beginner winmine
lands at pad 11: the bar exactly spans 154px and "Info" renders complete
with ~6px clearance. Rationale: (b) would touch AdjustWindowRect/
GetSystemMetrics and every fixed-size port's client math for a case a
padding tweak fully absorbs; (c) would falsify the port's own geometry.
If a future port's titles can't fit even at the floor, revisit (b).
`menu_bar_rect` / hit-test / draw / popup-anchor all share the one pad,
so highlight, click zones and popup x stay consistent.

**Test.** `test_winmine_e2e` now shots the "menubar" strip surface (its
own SHOT-able child since 0257) and asserts the rightmost text-ink
column (near-black, AA-safe threshold, BTNSHADOW bottom row excluded)
clears the right edge — plus an anti-vacuous "ink past mid-bar" check.
Red→green pinned: pre-fix the probe reads ink at column 153/154 (the
clip), post-fix 147/154.

**Gate.** kernel 102/102 (test_clang_pkgs_e2e failed in the -j4 run —
the known dist/packages race — and passes isolated); full browser sweep
36/36 (os-shell flaked twice under load at wm.c desktop/start-menu
pixel waits, passes isolated in this tree AND on clean origin/main —
outside this diff's reach); flake gate: winmine e2e 3/3 under load,
browser tripwire leg green; the kernel tripwire's wm_service taskbar
flake (33%) reproduces identically on clean main — pre-existing, not
this change.
