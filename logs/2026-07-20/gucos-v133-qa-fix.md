# gucOS v133 → v134: 20px-font visual-regression fix (branch `v133-qa-fix`)

## Why

v133 (`c7a209c`) shipped the "chrome font 20px + AA" retune. The font/baseline
**engine** was correct, but the retune left a swathe of **hand-laid fixed-pixel
`CreateWindow`/control geometry unscaled for the doubled font** — text clipped,
occluded, or overflowing its box — plus two general width-measurement bugs and a
compositor title-bar seam. The retune re-baked ~40 goldens **to the broken
output**, so golden-diffs passed where text was occluded. This pass fixes the
sources at the right level of generality and **visually verifies each surface
before re-baking any golden** (the process failure that let v133 ship).

## Ground-truth font metrics (measured, not guessed)

Booted the real gdi32 with a temporary probe in `gdidemo selftest`
(`GetTextMetrics` + `GetTextExtentPoint32` on the stock font, then reverted):

- **tmHeight = 28** (ascent 22, descent 6), tmInternalLeading 8 → em body 20px.
- **advance = 12px / char** exactly (NotoSansMono, monospace).
- LISTBOX row pitch = tmHeight + 2 = **30px** (user32 `lb_row_h`).

So the canonical rhythm the retune already used elsewhere (MENU_BAR_H 30,
MENU_ITEM_H 30, software-center STATUS_H 30 / BTN_H 32) is: **one text line box
= 28px, single-line control = 30px, button = 30–32px, label/edit ≥ 28px, per
4-char word ≈ 48px + button padding.** Every geometry number below is derived
from these, not nudged to a screenshot.

## Per-defect fixes (before → after screenshots in `os/media/v133-qa-fixed/`)

| # | Surface | Fix | old → new |
|---|---------|-----|-----------|
| D1 | fileman toolbar strip | `os/win32/fileman.c` `TOP_H` — path EDIT was `TOP_H-6 = 20 < 28` (glyph bottoms clipped) | `TOP_H 26 → 36` (EDIT/buttons now 30) |
| D5 | fileman toolbar buttons | `BTN_W` — "Open"/"With" (48px) overflowed a 46px button, read "OpenWith" | `BTN_W 46 → 60` |
| D7 | fileman Open-With picker + rename dialog | EDIT/checkbox/buttons on 32px pitch, 28–30px line boxes; dialogs grown | picker `320×106 → 360×160`, rename `320×82 → 360×130` |
| D2 | comdlg32 File Open/Save-As (shared: notepad + paint) | labels overflowed under the EDITs; listbox height wasn't a whole row multiple | STATIC `70→130`, EDIT x `80→142`, listbox height snapped to `rh` (=30) via `GetTextMetrics`; `FD_W 380→460`, `FD_H 300→340` |
| D3 | ctlpanel — all 7 applets | systematic re-tune: window sizes, control w/h, row pitch, group-label baseline clears its frame; buttons/statics fit their real text | see `APP_DEF` table + per-applet rects |
| D4 | ctlpanel hub | icon labels overflowed 76px cells (4/7 unreadable) → **two-line word-wrapped labels** (Win95/XP CPL behaviour), selection strip measured to hug the text | `CELL_W 84→120`, `ICON_W 76→112`, `ICON_H 60→96`; hub width auto-scales |
| D6 | ctldemo bottom row | Verbose checkbox clipped baseline (h20), "Options" (84px) overflowed 76px | checkbox h `20→28`, Options `76×26 → 96×30`, About/Quit h `26→30` |
| D8 | notepad status bar | `SB_SETPARTS` widths keyed to old advance; 400px `CW_USEDEFAULT` window too cramped for 3 parts (~460px needed) | `vendor/notepad/dialog.c` defaultWidths `{120,120,120} → {200,210,130}`; `main.c` window `CW_USEDEFAULT(=400×300) → 640×480` |
| D9 | **GENERAL** user32 MessageBox width | root cause: text measured with `DT_CALCRECT|DT_WORDBREAK` seeded at a 320px rect (gdi32 leaves `r->right` untouched under WORDBREAK) → box sized to stale width, single-line STATIC clipped it. Fix measures the **true `'\n'`-aware extent** (no cap, no WORDBREAK) — auto-sizes EVERY MessageBox | `os/win32/user32.c` MessageBox measure + button h `24→28` |
| D10 | compositor title-bar seam | title bar (compositor rasterizer) under-grew vs the 30px in-OS menu bar | `os/compositor.js` LABEL_FONT `18px→20px`, LABEL_H `26→28`; `kernel.js` `WM_TITLE_H 28→32`, `WM_CLOSE_PAD 4→6` (vcenter the 20px boxes). Pinned in BOTH rasterizers (shared chrome). |

### ctlpanel `APP_DEF` window sizes (old → new)
Sound 280×102→324×156, Sounds 280×102→324×126, System 280×82→384×220,
Display 280×62→444×96, Date/Time 232×56→300×76, Screen Saver 280×162→336×212,
Keyboard 280×132→496×150 (widest — holds the 36-char "Emacs editing in text
fields (macOS)" checkbox: 432px text + ~20px check glyph → 464px control).

## Deliberately NOT fixed (relayed to coordinator, per the brief)
- Desktop icon-label truncation (`wm.c` `text_fit`/`CELL_W 116`) — jku named
  icon-label ellipsis a future item, do not block. Untouched.
- Taskbar button long-title truncation — expected/acceptable.

## Known pre-existing (not this regression)
- System applet still right-clips very long os-release lines (PRETTY_NAME ~444px,
  the fat-image PACKAGES= list) — a 40+ char single line can't fit any sane
  window; predates the retune. The regression (h16 descender clip + bottom lines
  falling off the short window) IS fixed; NAME/VERSION_ID/UPTIME render clean.

## Verification
Each surface booted, driven, screenshotted, and confirmed by eye BEFORE any
golden re-bake (before/after pairs in `os/media/v133-qa-fixed/`, mirrored to
`s3://groundupcoder/gucos/v133-qa-fixed/`). `image.json` bumped `133 → 134`.

## Gate — all green
- **kernel suite: 95 passed / 0 failed** (`tests/kernel/run.js`) — incl.
  present-e2e, openwith-e2e, the changed-surface e2es.
- **browser sweep: 33 passed / 0 failed** (`tests/browser/os-sweep.mjs`).
- **win32 ports: 7/7 link + PORTS.md current** (`tools/win32ports.js --check`).
- **projects: 26 passed / 0 failed** (`tests/run.py --types=projects`, incl. the
  standalone notepad build).

### Goldens re-baked to the CORRECTED output (with reason — all confirmed
visually FIRST, never a blind re-bake)
The `TOP_H 26→36` and `WM_TITLE_H 28→30` geometry shifts moved a handful of
coordinate/pixel constants in tests. Each was a stale golden (assumed the old
geometry), not a product regression:
- `test_fileman_ops_e2e.js` / `test_openwith_e2e.js` / `test_recycle_e2e.js` /
  `os-fileman.mjs` / `os-recycle.mjs` — the row-0 right/left click moved from
  `y=30` (now inside the 36px toolbar strip → no context menu) to `y=51` (row-0
  centre in the listbox); the rename-EDIT refocus click `36→55`.
- `test_fileman_e2e.js` — the resized-listbox rect regex `rect=4,26 → rect=4,36`
  (listbox top = TOP_H).
- `test_notepad_e2e.js` — the status-bar pane2|pane3 border sample `sp.w-120 →
  sp.w-130` (ENCODING pane widened to 130).
- `os-aero.mjs` — the rounded-frame-corner sample `WY-31 → WY-33` (frame top rose
  2px with the 30px title bar).

### D10 tuning note (judgement call)
First cut used `WM_TITLE_H=32` + `WM_CLOSE_PAD=6` (perfectly vcentred boxes). That
4px bump pushed a neighbour window's drop shadow into several title-bar pixel
samples across the sweep. Settled on **`WM_TITLE_H=30`** (exactly `MENU_BAR_H`,
still satisfies "caption ≥ menu bar") + **`WM_CLOSE_PAD=4`** (unchanged → no box
X-shift): the 2px delta keeps title samples clear of neighbour shadows and
avoids horizontal box-coordinate churn. Re-verified the caption/menu/status read
as one 20px scale at this final config (`after-notepad.png`).
