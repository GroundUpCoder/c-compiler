# MagicPoint tutorials + .mgp view/edit wiring (todos/0202)

Three deliverables, one theme: make MagicPoint on gucOS *learnable*.

## What landed

1. **The learn-mgp tutorial series** — ten numbered decks
   (`vendor/magicpoint/decks/tutorial/01-welcome.mgp` … `10-mastery.mgp`),
   beginner → advanced, written against an audited whitelist of what the
   0119 port actually renders. Progression: what mgp is / driving the
   viewer → deck anatomy (pages, directives-as-state, comments, escapes) →
   text (size/vgap/hgap/prefix/cont) → color (names, grayNN, #hex, %bar) →
   alignment (%left…%leftfill, %area) → lists (%tab depths, %icon shapes) →
   images (%newimage transforms, formats) → backgrounds (%back/%bgrad/
   %bimage) → builds (%pause, %mark/%again columns, %sup/%sub) → mastery
   (%default templating, fonts, %include, port descopes, deck craft).
   Seeded twice: masters at `/usr/share/mgp/tutorial/` (Start ▸ Demos ▸
   learn-mgp launches deck 01) and **writable copies** in
   `/root/Desktop/Presentations/` — the 0185 showcase links are gone from
   the desktop folder (the showcase decks stay at `/usr/share/mgp/`, the
   present-e2e DECKS loop pins them). Upstream `SYNTAX` is seeded at
   `/usr/share/mgp/SYNTAX`. Image v95 → v96.

2. **Double-click = view** (verified, no code needed): the baked openwith
   table already mapped `mgp → /bin/mgp`; desktop dblclick and fileman
   Open both raise the viewer (new e2e legs prove it, screenshots below).

3. **Right-click Edit = the GUI text editor**: new `ow_editor()` in
   `os/openwith.h` resolves the `default.gui` entry (deliberately NOT the
   extension association — Edit on a deck must open the TEXT, not the
   presentation), shared by both surfaces. fileman's row menu grew an
   `Edit` item (grayed on dirs, `IDM_EDIT → spawn_assoc(ow_editor(), path)`);
   wm.c's desktop icon menu grew an `EDIT` row **on document icons only**
   (regular + not `ow_is_runnable` — launchers/binaries/folders keep the
   pre-0202 menu, so runnable-icon row geometry stays test-pinned).

## The bug the Edit path flushed out (kernel32 OPEN_ALWAYS)

Edit on a Presentations *symlink* into `/usr` died with "The media is
write protected" — notepad's `DoOpenFile` uses `OPEN_ALWAYS` with
`GENERIC_READ`, and our kernel32 mapped OPEN_ALWAYS to unconditional
`O_CREAT`; POSIX `open(O_CREAT)` on an EXISTING file on a read-only
volume is EROFS. Windows OPEN_ALWAYS only creates when missing, so the
fix is `if (!existed) fl |= O_CREAT` (kernel32.c already computed
`existed`). Notepad now opens `/usr` files read-only-honestly (saving
still fails EROFS with the honest error). k32demo grew a self-check
(OPEN_ALWAYS on `/usr/share/os-release` → success + ERROR_ALREADY_EXISTS).
Independently of the fix, the Presentations decks became **copies** in
user territory rather than links: decks 01/02 literally teach "right-click
Edit, change the text, press ctrl-r to reload" — that loop needs rw files.

## Deck-authoring gotchas (now in vendor/magicpoint/README.md)

- **`\%` escapes are line-start only.** Mid-line `\%` is "unknown escape
  sequence" and mgp EXITS (killed decks 02/09 on first run); mid-line bare
  `%` in a text line is fine. `\\%` renders a literal `\%`.
- **Line budgets**: tab-1 at size 5 fits ~42 chars before mgp folds the
  overflow to column 0 with no hanging indent (caught by eyeballing a
  screenshot, invisible to the pixel asserts). The series uses tab-1
  size 4 (~50 chars) + tab-2 size 3; deck 06 keeps the 5/4/3/3 ladder as
  its own four-depth lesson, with bullets trimmed to the size-5 budget.
- A page title that *names* a directive (`%size`) must be written
  `\%size` or restructured — column-0 `%` is always parsed.

## Geometry ripple (documented, updated)

The conditional EDIT row shifts the wm.c icon menu on document icons
(OPEN 4-24 / EDIT 24-44 / sep / CUT 52-72 / COPY 72-92 / DELETE 92-112 /
RENAME 112-132, h 116 → 136). Updated: `test_fileman_ops_e2e`
(ICON_CUT_Y/ICON_COPY_Y), `test_recycle_e2e` (DELETE y + the 120x136
assert), `test_wm_service_e2e` (RENAME y; also the DEMOS flyout list —
the new learn-mgp menu entry shifts `DEMOS.indexOf('winbox')`),
`os-recycle.mjs`, `os-shell.mjs` (DEMOS), `test_ctxmenu_e2e` comment
(alauncher is runnable → unchanged there).

## Verification

- `test_present_e2e` grew a TUTORIAL loop: every deck launches, pages
  through **every** %page+%pause stop (steps pinned per deck), window
  alive before q, plus title-page background/glyph pixel asserts (the
  hex `#102040` deck included). 116 checks green.
- `test_openwith_e2e` grew the 0202 legs: desktop dblclick `.mgp` →
  MagicPoint; fileman Open → MagicPoint; row-menu Edit (enabled, tree
  dump) → "01-welcome.mgp - Notepad"; desktop icon EDIT row → notepad.
- Full kernel suite 73/73; browser sweep legs os-present / os-fileman /
  os-recycle / os-shell / os-ctxmenu green; `projects` build check green.
- Booted-OS visual pass (real Chromium, compositor screenshots): fileman
  showing the ten numbered decks, real-mouse dblclick → deck 01 rendering,
  the row menu with Edit, notepad holding the deck source, deck 09's
  rendered E=mc²/H₂O sup/sub page, deck 10's hex background and descopes
  page. Driver kept at `/tmp/verify0202.mjs` (not committed — one-off).

## Warts noted, not fixed here

- `newestBakeInput` treats gitignored `os/media/*.png` as bake inputs —
  dropping screenshots there makes serve.js/boot.js re-bake once. Cosmetic,
  but a screenshots-heavy session pays a spurious bake per boot.
- Persistent-OPFS browsers keep their old Presentations (user territory is
  seeded once, never upgraded — by design); old showcase links still
  resolve since the showcase decks remain at `/usr/share/mgp/`.
