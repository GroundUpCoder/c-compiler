# #330 — ChooseFont style axis + the silently-discarded CF_* flags

Lane: lane-330, base `fc5b2056`. Ticket: c-compiler #330 (W3-TM, light, P2).

## What shipped

- **Style axis** in ChooseFontW (`os/win32/comdlg32.c`): a Style LISTBOX
  (Regular / Italic / Bold / Bold Italic, row index = `(bold<<1)|italic`)
  between the Font and Size columns; dialog grew 380x380 → 460x420.
  `cf_accept` now writes `lfWeight` (FW_BOLD/FW_NORMAL) and `lfItalic`;
  the sample preview renders the selected style, not hardcoded regular.
- **Style preselect** under `CF_INITTOLOGFONTSTRUCT` (bold =
  `lfWeight >= FW_BOLD`, gdi32's own #281 binarization). This is
  load-bearing, not cosmetic: notepad passes its LIVE LOGFONT, so a
  style list defaulting to Regular would make a plain size change
  silently CLEAR a registry-held bold on OK — a regression the old
  (never-writes) code could not have.
- **`CF_EFFECTS`** (new `#define 0x00000100` in `commdlg.h` — the master
  pre-flight comment on the ticket confirmed it was ABSENT from the tree
  and asked for the define in the same commit; checked against the
  clipboard-format `CF_` block, no name collision): gates Underline /
  Strikeout checkboxes per the upstream contract. ONLY with the flag does
  the dialog own `lfUnderline`/`lfStrikeOut` (preselect from the incoming
  LOGFONT, write-back from the checkboxes); without it the fields pass
  through UNTOUCHED and no checkbox exists.
- **Flags honesty**: `CF_SCREENFONTS`/`CF_BOTH`/`CF_NOVERTFONTS` are
  documented honored-by-construction (the family table IS the screen-font
  set; the printer-font set is empty so screen ∪ printer == screen; no
  vertical faces exist among mono/sans/serif). `CF_PRINTERFONTS` alone is
  unsatisfiable → `WIN32_UNSUPPORTED` + FALSE (the PrintDlgW honest-cancel
  pattern). Any UNKNOWN Flags bit → `WIN32_UNSUPPORTED` naming the bits —
  this closes the silent-discard class structurally, not per-flag.
- **`fontramp choose`** grew style/effects/honesty args (`bold`,
  `italic`, `underline`, `strikeout`, `effects`, `badflag`,
  `printeronly`) and prints the full returned style
  (`wt=/it=/ul=/so=`).
- `os/image.json` 242 → 243 (veneer + fontramp are bake inputs).

## The discovered product bug: NULL-dc LOGPIXELSY collapsed saved font heights

The new fresh-notepad leg went RED on first run (persist ink 1023 vs the
2742 regular baseline): notepad's `PointSizeFromHeight`/
`HeightFromPointSize` run `GetDeviceCaps(GetDC(NULL), LOGPIXELSY)`.
`GetDC(NULL)` returns NULL here (deliberate — no screen DC), and
`GetDeviceCaps(NULL, *)` returned **0**, so `MulDiv(..., 0)` → -1 → the
saved `iPointSize` was garbage and every relaunch fell back to the stock
20px. The style half round-tripped (raw dword); the size half had been
silently broken since 0059 — no test ever relaunched notepad. Fix
(`gdi32.c`): `LOGPIXELSX/Y` answer 96 for a NULL dc too — the constant is
synthetic and device-independent in this build, so 0 was a lie. Other
caps keep the NULL guard (they are genuinely per-DC).

**Knock-on, one committed assertion re-cut** (declared here per the
rules): notepad's default font is upstream's 10pt (`dwPointSize = 100`).
The broken conversion used to collapse it to `lfHeight 0` → the dialog's
20px/15pt fallback, and `test_notepad_menu_e2e.js` had pinned THAT
("preselects the stock size (15pt = 20px)"). Re-cut to pin the honest
value (EDIT '10', list row '> 10') — and the leg gained a companion:
the FRESH notepad's dialog must hold 28pt from the registry, which is
exactly the path the fix repairs. Only other `GetDeviceCaps` consumer of
the NULL-DC shape is `vendor/notepad/printing.c`, dead behind the
always-FALSE PrintDlg.

## Kickoff findings, verified

- **Finding A (CF_EFFECTS does not exist): CONFIRMED.** Zero hits in the
  tree pre-change; a caller naming it failed to compile (loud). The
  genuinely silently-discarded flags were SCREENFONTS / PRINTERFONTS /
  BOTH / NOVERTFONTS — notepad ships two of them.
- **Finding B (inbound round-trip broken): PARTIALLY WRONG, as the
  kickoff itself suspected.** Face preselect under CF_INITTOLOGFONTSTRUCT
  was ALREADY handled (the face-enumeration loop matches
  `lfFaceName` against the family rows — comdlg32.c, since C2/#282), and
  the committed e2e asserted it. Only the STYLE preselect was missing,
  because there was no style UI. Height was read; face was read; nothing
  else needed reading until this ticket added the controls that read it.
- **The kickoff's effects lean: adopted, against its own fallback.** The
  "theatre" condition (a flag no caller sets, no path exercises) does not
  hold: the ticket plan says "plus effects where C1 renders them", gdi32
  renders both rules for real, and fontramp — the designated acceptance
  app — exercises both arms (with the flag: preselect + toggle + write;
  without: field pass-through + checkbox absence). Cost was two
  checkboxes and one define.

## Evidence

- `build/repro-330-before.log` — pre-fix runtime capture (dialog tree
  with NO style control, style-less `choose:` line) + the source greps
  (flags accepted-but-never-read; CF_EFFECTS absent with positive
  control).
- `build/breakage-330-evidence.log` — deliberate scratch breakages, both
  caught and then reverted:
  - style write-back disabled → 3 FAILs (`wt=0` where 700 expected —
    the original defect reproduced);
  - unknown-flags report silenced → 1 FAIL (the honesty leg demands the
    stderr line positively).
  The GetDeviceCaps breakage evidence is the live pre-fix red itself
  (persist ink 1023 vs 2742, quoted above) — the leg was written before
  the fix existed.
- Non-vacuous by construction: every leg asserts a POSITIVE observable
  (the exact `choose:` line incl. all four style fields, the `> Bold`
  selected-row text, hive line `lfWeight...bc020000`, ink counts that
  must strictly GROW ~50% for bold at fixed size/geometry/text).

## Test deltas

- `test_multiface_font_e2e.js`: chooseSession → six arms (style
  round-trip + preview shots, style preselect, effects
  preselect/toggle/write, no-effects pass-through + checkbox absence,
  unknown-bit loud report, printer-only honest cancel); extract session
  crops re-derived for 460x420 (sample y 312..376, x 8..452) and gained
  the STYLE-axis crop diff next to the face one. The two pre-existing
  `choose:` assertions were re-cut to the extended line format (more
  fields asserted, not fewer).
- `test_notepad_menu_e2e.js`: Bold-through-the-dialog leg (ink count
  must grow >5% at identical 28pt/geometry/text; reopened dialog shows
  `> Bold` + size 28), then post-Exit hive assert + a FRESH notepad leg
  (renders registry bold, dialog preselects Bold and 28pt). 90 checks,
  ALL OK.

## Gate

Plan (`--dry-run` vs origin/main): kernel, sweep — the two `os/**` heavy
suites, as the RULES table mandates. Gate run 1 (`build/gate-330.log`):
rc=1 — sweep 56/56 green, kernel 167/168 with ONE red,
`test_netsurf_mutation_e2e.js` ("a mid-window radio repaint reaches the
screen AT ONCE", the 0386 mid-window re-conversion timing class,
documented open and intermittent; netsurf links none of this diff's
code). Attribution re-run of that single file on the same tree: PASS.
Re-gate (`build/gate-330b.log`): **rc=0, kernel 168/168, sweep 56/56,
zero fails** — the flake did not recur.
