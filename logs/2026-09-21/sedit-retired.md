# sedit retired from gucOS

jku ruling (2026-09-21, follow-up to the layout cleanup): drop sedit from
gucOS. The layout cleanup had deleted only the *untracked* port of an external
SDL3 editor and flagged that `os/sedit` (the shipped Source Editor, #718 with
the #729/#730 fixes) was a different program; jku confirmed both go.

## What went

- `os/sedit/` (the editor, its C lexer, document and style modules), and its
  bake: `/usr/bin/sedit`, the Start-menu `Development/Source Editor` link and
  the now-empty `Development` group, `/usr/share/doc/editor.md` (+ the
  `os/doc/README.md` row), and the `c`/`h` open-with associations — a `.c`
  or `.h` opened from the desktop now falls through to `default.gui`
  (notepad), as every other text type does.
- `tests/kernel/test_sedit_core.js` + `sedit_core_probe.c`,
  `tests/kernel/test_sedit_e2e.js`, `tests/browser/os-sedit.mjs` and their
  registry rows.
- `os/image.json` 297 → 298.

## What stayed, and why

`os/win32/gucedit_core.c` + `gucedit.h` — the EDIT control's styled-text ABI
(`GEM_SETSTYLES`/`GEM_CLEARSTYLES`/`GEM_GETTEXTGEN`, generation-bound style
batches, styled paint). It is a user32 capability, not a sedit file: any
win32 app's EDIT can carry syntax styles through it. `test_gucedit.js` still
executes the core through its standalone probe; its production-build leg
(the baked wasm exports no test override) now compiles notepad, the shipped
user32 app, instead of sedit. What no longer exists is an end-to-end
consumer that drives `GEM_SETSTYLES` through a real window — the two
e2e pins that did (`test_sedit_e2e`'s big-file highlight shot, `os-sedit`)
left with the editor.

Comments in `user32.c`, `wm_proto.h` and `test_taskbar_owner_e2e.js` that
used sedit's owned Find/Goto dialogs as the worked example of an owned
non-dialog-class window now say "an app's"; the taskbar rule they describe
is unchanged and still pinned by `test_taskbar_owner_e2e.js` on comdlg32's
owned dialogs.
