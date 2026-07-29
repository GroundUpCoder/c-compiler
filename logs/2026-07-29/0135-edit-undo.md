# 0135 — EDIT undo buffer (EM_UNDO / EM_CANUNDO)

jku reported that Edit → Undo does nothing in notepad. The cause was known:
the EDIT control had no undo state, and `EM_CANUNDO` always returned FALSE.
The chord path was already live. `os/keys.h` binds Ctrl+Z (windows scheme)
and Cmd+Z (macos scheme) to `KA_UNDO`, and user32 routes `KA_UNDO` to
`EM_UNDO`. The fix fills in one control. It does not add wiring.

## Why one record, not a stack

The control now keeps one undo record (`EditState`). The record holds the
old bytes of the changed span and the selection from before the edit. This
is the Win95 model for the plain EDIT control. One record keeps the memory
bounded, and it matches the reference control. A multi-level stack is a
deliberate non-goal for v1 (the ticket records this).

`EM_UNDO` applies the record. Before it applies the record, it captures
the inverse of the record. Thus a second `EM_UNDO` applies the edit again.
This is the Windows undo/undo toggle. A consequence: `EM_CANUNDO` stays
TRUE after an undo, because the toggle is a valid undo target. The menu
item grays again only after a clear (for example `WM_SETTEXT`).

## The stale-record hazard

A rewrite that the record does not capture moves the text under the
record's offsets. A stale record then changes the wrong bytes. The rule in
the code: every buffer write either captures a fresh record, or clears the
record. `WM_SETTEXT`, `EM_SETHANDLE`, `EM_EMPTYUNDOBUFFER`, and the
non-undoable `EM_REPLACESEL` clear it. The non-undoable `EM_REPLACESEL`
clear is not in the ticket text, but the hazard requires it. `EM_UNDO`
also validates the record bounds before it applies the record.

## Why the capture has two steps

The insert path can shrink the text (`edit_normalize` folds CR bytes).
The byte count that the undo must delete is only known after the edit.
`edit_undo_capture` arms the record before the edit. `edit_undo_commit`
reads the count from the landed caret after the edit. Both edit
primitives land the caret at the span start plus the inserted length, so
the caret is a correct measure.

## The mac cell

jku hit the bug on a Mac. On a Mac host, the scheme auto-detect seeds
`scheme=macos`, and the undo chord is Cmd+Z. Headless boots pass no host
platform, so every kernel test runs the windows scheme. The kernel tests
therefore prove only the windows cell. `tests/browser/os-undo.mjs` is the
first browser test that passes `hostKeys:'mac'`. It proves the seed, the
menu gating, and the real Cmd+Z chord in notepad. Rule for future tests:
pin the scheme, or derive the chord from the active scheme. Do not
hardcode one chord. Both cells exist in the wild, because the seed only
runs on a fresh root volume.

## Redo

Redo stays out. The plain Win32 EDIT control has no `EM_REDO` (that is a
RichEdit feature), and no corpus app uses RichEdit. The toggle already
gives "undo the undo". `todos/KEYMAP.md` "As built" deviation 2 now
records this reasoning without the stale "no undo buffer" claim.

## Tests and gates

`ctldemo selftest` grew 22 message-level checks (57 total, 0 failed).
`test_notepad_menu_e2e.js` now asserts: the item enables after an edit,
the menu click restores the deleted text, ^Z re-applies, and a
programmatic set re-grays. `test_ctxmenu_e2e.js` asserts the context-menu
Undo un-grays after a paste. Gates on the rebased tree (base `ca977034`),
clean build dirs, single full runs: kernel 131/131 pass, browser sweep
42/42 pass (os-undo.mjs included), todos suite 5/5. Image bumped to v194.
