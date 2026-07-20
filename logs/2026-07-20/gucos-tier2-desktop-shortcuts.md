# gucOS Tier 2: install-to-Desktop toggle (#90/Q5) + icon-label wrap (#91)

Two desktop-shortcut follow-ons, one deploy. Both live in `os/` only.

## #90 / Q5 — "install to Desktop" toggle

**What.** A persistent, opt-in setting: when ON, a `gucman install <pkg>` also
plants `/root/Desktop/<pkg>` as a symlink to the package's primary command;
`gucman remove` cleans it up. Honored by BOTH the CLI and the software-center
GUI, because the setting lives with the engine, not the front-end.

**Design (why these choices).**

- **The flag lives in gucman, not software.c.** A one-line file
  `/var/lib/gucman/desktop_shortcuts` ("on"/absent). gucman reads it on every
  install (`gm_desktop_flag()`), so a bare CLI `gucman install` honors the
  toggle too — the spec's "prefer a persistent gucman setting" and the
  build-the-general-case principle. software.c only reflects/writes it via a
  header checkbox; it never touches install surface (the locked division of
  labor).

- **Depth-0 only.** The shortcut is planted for the *user-requested* package
  (`depth == 0`), never transitive library deps — you install `foo`, `foo`
  goes on the desktop, its libs don't clutter it. This is the correct general
  rule, not a shortcut.

- **Primary command, and skip if none.** The shortcut targets
  `/usr/local/bin/<cmd>` where `<cmd>` is the bin command named like the
  package if present, else the first planted command. A package with no
  command (a font/library — e.g. `font-unifont`) gets no shortcut: nothing to
  launch.

- **Cosmetic, never fatal.** A name collision or FS error on the desktop
  symlink is a stderr *warning* that skips the shortcut — it never fails or
  unwinds an otherwise-good install. But what IS planted is RECORDED in a new
  `db_desktop` array (written LAST, crash-safe like the rest) so uninstall's
  reverse replay (`gm_unwind` + `cmd_remove`) removes exactly it and nothing
  else — same mechanism as `menu_entries`.

- **Retroactive planting: deliberately NOT done.** The toggle affects
  *new* installs only; the checkbox label ("Install to Desktop") reads as
  forward-looking. Retroactive placement of already-installed apps is a noted
  follow-up, not silently skipped.

**UI.** `software.c` header checkbox (BS_AUTOCHECKBOX, left of Refresh, above
the subtitle), default OFF. Reads the flag at WM_CREATE, atomic tmp+rename
write on toggle. Own-eye verified: renders unchecked, fully legible, no clip.

## #91 — desktop icon label truncation

**What.** Labels that don't fit one line (`"Recycle Bin"` → `"Recycle B"`) now
WRAP to a second line instead of hard-truncating.

**Design.** `desk_label_wrap()` in wm.c: a label that fits whole stays ONE line
— **byte-identical** to the pre-#91 single-line render, so only genuinely
too-wide labels change (minimal golden/pixel churn; the browser sweep stayed
33/33 with no rebake). Otherwise greedy word-wrap at the last fitting space
(dropped), a single over-wide word breaks on the codepoint boundary via
`text_fit`, and line 2 gets a "..." tail only if the remainder still overflows.
Selection highlight draws one navy strip per rendered line. NOT widening
`CELL_W` — that would shift every icon, the whole grid, `.icons` math and every
desktop test (the wrong, invasive "bump one magic width" fix).

Own-eye verified: `"Recycle Bin"` → `"Recycle"`/`"Bin"`, `"Presentations"` →
`"Presentat"`/`"ions"` (full text now visible), all short labels unchanged.

## Test / gate

- `test_gucman_e2e.js`: added session C — toggle OFF → install → no
  `/root/Desktop/punes`; toggle ON → symlink appears, recorded in the DB;
  remove → gone. (52/52.)
- `test_software_e2e.js`: the new checkbox is a BUTTON created before the
  cards, so it shifts every card's `BUTTON:n` ordinal by +1 — bumped
  `punesBtn` from `1 + indexOf` to `2 + indexOf` (Refresh + the toggle), and
  added a check that the header carries the toggle. This was the one gate
  failure; the off-by-one made `wmctl click BUTTON:7` miss punes's button and
  a later `wait label` napped out its 15s clock (the exact test-sync
  anti-pattern — root-caused, not lengthened).
- Full gate green: kernel 95/95, browser sweep 33/33, win32 ports 7/7,
  present + openwith e2e pass. Own-eye screenshots before any (n/a) golden
  rebake — the desktop/software surfaces use live pixel probes, no goldens.
