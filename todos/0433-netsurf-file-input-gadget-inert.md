# 0433 — netsurf: <input type=file> is inert (file_gadget_open unset)

- **Status**: open
- **Design**: —

## Goal

A click on `<input type="file">` in the gucOS browser does nothing, so no page that
uploads a file is usable.

`todos/0422` diagnosed this while it diagnosed the dead `<select>` menu. The two faults
have the same shape and the same cause, but they do NOT have the same fix. A gadget click
sends `CONTENT_MSG_GADGETCLICK`, which `browser_window.c` routes to
`guit->window->file_gadget_open`. The gucOS window table (`vendor/netsurf/gucos/gui.c`)
does not supply that entry, so `gui_factory.c` installs its empty default and the click
ends there.

## Plan

1. Confirm the diagnosis still holds at HEAD. Read the gucOS window table and
   `gui_factory.c`, and check that `file_gadget_open` is still unset.
2. Design the file dialogue. This is the part `todos/0422` deliberately did not do.
   A file gadget needs a file CHOOSER, which is frontend window furniture, not a content
   popup. Decide what that dialogue is in gucOS: how it lists a directory, how it reads
   the selection back, and which kfs path it starts from.
3. Supply `file_gadget_open` in the gucOS window table and return the chosen path to the
   engine.
4. Cover it: open the dialogue, choose a file, cancel the dialogue, and submit a form that
   carries the chosen file.

## Notes

`todos/0422` takes the CORE select menu (`core_select_menu` in
`vendor/netsurf/gucos/options.h`), so it never supplies a window-table entry at all. The
apparent shared seam between the select menu and the file gadget is a shared TABLE SLOT,
not a shared implementation. Do not wait for 0422 and do not copy its approach.

Any edit to a vendored engine file must land in `vendor/netsurf/patches/` in the same
commit — see `todos/0423`.

## Acceptance

- A click on `<input type="file">` opens a file dialogue.
- Choosing a file sets the gadget's displayed value, and submitting the form carries it.
- Cancelling the dialogue leaves the gadget unchanged.
