# 0110 — wm.c desktop confirm dialogs — Empty Recycle Bin, delete, Shift+Del bypass

- **Status**: open
- **Design**: `todos/WM.md` ("Recycle Bin, desktop side" — the recorded
  deviations this item closes), `todos/0093` (the store semantics).

## Goal

0093 shipped the desktop side of the Recycle Bin with three deliberate
deviations, all rooted in one gap: the wm process has no dialog
furniture. Close them Win95-faithfully once it does:

- **Empty Recycle Bin** from the bin icon's menu fires WITHOUT a confirm
  (the one destructive-unconfirmed action in the desktop; fileman's Empty
  confirms). Win95 asks "Are you sure you want to delete all items?".
- **Desktop icon delete** (menu DELETE / Del key) trashes without a
  confirm. Recoverable, so low-stakes — but Win95 shows "Are you sure you
  want to send X to the Recycle Bin?".
- **No desktop Shift+Del permanent bypass** — fileman has it; the desktop
  doesn't, deliberately, because permanent-without-confirm would be
  unacceptable.

## Plan

- A minimal wm.c confirm popup: one more borderless window in the Start
  menu/ctxmenu furniture family (title "wmconfirm", top layer, parked at
  its EV_CREATED echo, Esc/outside-focus = No, Enter/Y = Yes, two
  clickable buttons). Sized by message text; ONE at a time.
- Route Empty + delete + a new Shift+Del (modifiers already tracked by
  keysym, 0077) through it. Keep the fileman wording so tests share
  goldens.
- This is the same furniture 0109 (desktop icon Properties popup) wants —
  whichever lands first builds it, hence the soft-dep after 0109.

## Acceptance

- Headless: bin-menu EMPTY raises the confirm; No/Esc keeps the store,
  Yes empties. Desktop DELETE confirms with Recycle-Bin wording.
  Shift+Del confirms with permanent wording and skips the store.
- `wmctl` can drive the popup (click by coords on the confirm window —
  it's a wm surface, not a user32 agent tree).
