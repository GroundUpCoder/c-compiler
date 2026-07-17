# 0130 — Default Programs applet — GUI file-association editor in ctlpanel

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/done/0072-openwith-associations.md` (the resolver +
  store this applet edits; its closeout descoped "a full GUI
  association-list editor (ctlpanel)" — no follow-up was owed until now),
  `os/openwith.h` (the ONE policy core — this applet is UI over it,
  nothing forks it), `todos/done/0089-control-panel-v2.md` (the applet-hub
  pattern every applet here follows)

## Goal

File associations exist and are editable today, but only via `open --set
KEY CMD` (the CLI, `os/open.c`) and fileman's per-file "With" picker
(`os/win32/fileman.c`). There is no central place to *see* every
association, and no read path at all — `open` can `--set` but not list,
so the only way to view the effective table is to `cat` the store files
directly. The Windows "Default Programs" / "File Types" control-panel
applet is the natural home; ctlpanel (`os/win32/ctlpanel.c`) is a Win95
applet hub (0089) with a `default.gui` stub already, so this slots in as
a 7th applet over a stable, already-shipped backend (`os/openwith.h`) —
zero new mechanism.

The backend is 100% done: `ow_load` (since todos/0244 a PER-KEY overlay
of `~/.config/openwith` > `/etc/openwith` > `/usr/share/openwith` —
os/cfgstore.h), `ow_find`/`ow_resolve` (extension key →
`default.gui`/`default.term`), `ow_set` (delta-writes just the changed
key to `~/.config/openwith` via tmp+rename). This item is UI + a small
CLI read path, nothing else.

## Plan

- **A `open --list` read path** (`os/open.c` + a tiny `ow_each`/iterator
  in `os/openwith.h`): print the effective `KEY<ws>COMMAND` table
  (extension keys + `default.gui`/`default.term`), so the applet and the
  shell share one enumeration of the store. NB since todos/0244 the store
  is a per-key three-layer overlay: the iterator must dedup keys over the
  merged text (first occurrence wins — the cfg_find rule).
- **A Default Programs applet** in `ctlpanel.c` (new `APP_*` enum entry,
  `APP_DEF[]` row, `draw_art()` pictogram, own `*_proc`): a LISTBOX of
  current associations (extension → command, plus the two `default.*`
  rows), an EDIT for the command of the selected key, and Set / Remove
  buttons that call `ow_set` (Remove under the 0244 delta model = drop the
  key from the USER file, so resolution reverts to the /etc//usr/share
  layer; removing a BAKED key outright would need a tombstone — decide
  there whether that's wanted). An "Add…" affordance to associate a new
  extension. All writes land in `~/.config/openwith` exactly like the CLI
  and fileman picker — three editors, one store, one format.
- Keep it agent-drivable per the OS.md pillar: label-addressable buttons,
  `wmctl click`/`settext`/`gettext` round-trip like the other applets.

## Non-goals (record, don't build)

- Per-key merge across the three stores — the model is whole-file
  first-existing (`os/openwith.h` header comment); don't fork it.
- A MIME database / content-type sniffing — keys are lowercase
  extensions, full stop (0072 decision).
- Registry-backed persistence — associations are plain-text store files,
  same as today.

## Acceptance

- `open --list` prints the effective association table (extension rows +
  `default.gui`/`default.term`); a conformance/e2e leg asserts it matches
  what `ow_resolve` would pick.
- Headless (`tests/kernel/test_ctlpanel_e2e.js` extended, not replaced):
  launching the Default Programs applet lists the baked associations;
  `settext` on the command EDIT + `wmctl click "Set"` writes
  `~/.config/openwith`, and a subsequent `open <file>` resolves to the
  new command; Remove drops the key and resolution falls back to
  `default.*`.
- Browser (`os-shell.mjs` leg): the applet opens in its own window,
  composites, and an edit round-trips through the store.
