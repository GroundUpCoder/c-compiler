# C2 — the win32 system font goes proportional (#282) + GetObject on HFONT (#291)

One lane carried both tickets, in the ordered sequence the tickets bind:
the stock-font model first, the GetObject read-back second. If the order
were reversed, the #282 commit would falsify the #291 arm that was
already verified.

## What changed

**Stock fonts (#282).** `SYSTEM_FONT`, `DEFAULT_GUI_FONT`,
`ANSI_VAR_FONT` and `DEVICE_DEFAULT_FONT` are now explicit `GF_SANS`
stock objects at the 20px stock size. `OEM_FIXED_FONT`,
`ANSI_FIXED_FONT` and `SYSTEM_FIXED_FONT` are new mono-backed stocks.
Before this change, the constants for the fixed stocks did not exist,
so after the flip there would have been no stock mono font at all — the
documented Win32 escape hatch now exists and is tested. Before C2,
every stock font was mono only because `obj_new`'s calloc left
`fontFam == GF_MONO == 0`; the family is now a visible decision.

**The NULL-face CreateFont default stays mono.** This is deliberate. C2
moves the stock OBJECTS. A NULL face is a request for the platform
default face, and that stays mono (the terminal-first heritage). An app
that wants the UI look takes `DEFAULT_GUI_FONT` or names "sans". The
C1 test arms that pin this behavior stay green unchanged.

**The menucore font seam.** The engine used to measure with its own
memory DC (DC default font) and draw with whatever font the front-end
selected. The two agreed only because both were 20px mono. The flip
breaks that coincidence, so `mc_set_font` now makes the agreement
structural: measure and draw both honor the registered engine font.
wm.c registers its chrome font (explicit mono), so the desktop chrome —
taskbar, icons, Start root, wm menus — is byte-identical. user32 leaves
the seam NULL and inherits the sans DC default.

**ChooseFontW (#282, the L65 retirement).** The face LISTBOX enumerates
gdi32's family table through `__gdi_font_families` — one authoritative
source, no parallel list. `cf_preview()` builds the sample font from
the SELECTED face row; the old `"mono"` literal let the accept path go
face-generic while the sample rendered mono (a user-visible defect the
round-trip arm could not see). Face selection re-renders the sample;
`CF_INITTOLOGFONTSTRUCT` preselects the incoming face's row.

**GetObject on HFONT (#291).** `GetObject` fills the RESOLVED LOGFONT:
family name from `g_familyName` ("Courier New" reads back "mono"),
weight/italic as resolved, cell-mode positive height preserved, clamp
semantics per Win32. `GetObjectW` no longer raw-forwards for fonts —
LOGFONTW differs in size and face-name encoding, so the W path
translates at the boundary. Non-font GetObject is byte-identical.

**software.c** headings name "sans" now, to match the sans controls
around them.

## The per-control audit (#282 acceptance)

The 0223 seam is the mechanism: `GetDC(hwnd)` selects the per-HWND
`hfont` into every DC (`dc_with_font`, user32.c), and `BeginPaint` goes
through `GetDC`. The DC default is `SYSTEM_FONT`. The audit asked: does
each paint path go through that seam?

| # | Surface | Paint DC | Font source | Verdict |
|---|---------|----------|-------------|---------|
| 1 | BUTTON (`btn_paint`, ownerdraw) | BeginPaint(control) | hfont → DC default | seam |
| 2 | STATIC (`static_proc`) | BeginPaint(control) | hfont → DC default | seam |
| 3 | EDIT (paint + measure) | GetDC(control) | hfont → DC default | seam |
| 4 | LISTBOX (`lb_proc`, row height via `edit_line_h`) | BeginPaint/GetDC | hfont → DC default | seam |
| 5 | SCROLLBAR (`sb_proc`, no text) | BeginPaint(control) | n/a | seam |
| 6 | #32770 dialogs + MessageBox | child controls above | hfont → DC default | seam |
| 7 | user32 menu bar strip | `__gdi_dc_wrap` | DC default | follows |
| 8 | user32 menucore popups | `__gdi_dc_wrap` | DC default | follows |
| 9 | menucore MEASURE (`mc_measure_dc`) | CreateCompatibleDC | DC default | **gap — fixed** (`mc_set_font`) |
| 10 | comctl32 status bar | GetDC/BeginPaint(control) | hfont → DC default | seam |
| 11 | listview + header | BeginPaint(control), forwards WM_SETFONT | hfont → DC default | seam |
| 12 | comdlg32 dialogs (file/find/font) | standard controls | hfont → DC default | seam |
| 13 | wm.c chrome + wm menus | explicit `chrome_font()` | app font (mono) | untouched by design |
| 14 | term / ksvc title bars | own freetype paths | n/a | untouched |

Count: 12 of 14 surfaces consult the seam or the DC default and follow
the flip with zero code change. Zero controls silently ignore their
`hfont`. One real gap existed (row 9, the measure/draw split); C2 fixed
it. The bare "WM_SETFONT round-trips" arm was already green from 0223
and proved nothing about this change — the table above is the arm that
matters.

## Test fallout — five reds, each reviewed, none a rendering bug

1. **gdidemo selftest** — the UTF-8 legs assert equal mono cells. They
   now select `ANSI_FIXED_FONT` explicitly (and dogfood the new stock).
2. **test_user32_e2e** — descender-measuring columns were mono-cell
   constants; sans's wider 'N' put its mnemonic underline inside the
   'o' window. ctldemo prints advance-derived extents (`descgeom`) and
   the test slices by those.
3. **test_calc_e2e** — dialog DLU width scales by `tmAveCharWidth/4`.
   Sans avgw 11 vs mono 12: the 169-DLU template gives 464 (was 507),
   the 316-DLU scientific gives 869 (was 948) — verified by arithmetic,
   not eyeball. Heights identical (both 20px cells have equal tmHeight).
4. **test_notepad_menu_e2e** — the Font dialog lists three family rows
   now; "Lucida Console" is not a family name, so row 0 stays selected.
5. **os-edittab (browser)** — after "line oneX" the sans pen sits 3px
   short of the 88px default tab stop, and a real tab legally advances
   3px. The tab code is correct; the test now types at column 0, where
   the next stop is a full grid cell away in any face.

## Goldens

No stored golden artifact diffs. The disw/conformance goldens are
compiler-side and this lane does not touch the compiler. The pixel
"goldens" in the wm tests are computed invariants, and all pass
unchanged — the VT2 desktop chrome is byte-identical by construction
(wm.c selects its own chrome font everywhere; `mc_set_font` closes the
one measure-path hole).

## Evidence

`logs/2026-07-31/c2-font-shots/`: before/after pairs (headless
`wmctl shot`, before = origin/main `0e96ef38` in a scratch worktree) of
notepad (status bar sans, EDIT correctly still Lucida-Console-mono),
the notepad File menu (mono 316px → sans 287px), the About MessageBox,
and the ctlpanel hub. The automated checks behind the pictures live in
`test_multiface_font_e2e.js` (89 checks: stock model, ChooseFontW
enumeration + sample re-render pixel diff + LOGFONT round-trip +
preselect, GetObject/GetObjectW read-backs).

Tickets: `#282`, `#291`. Liability L65 retired.
