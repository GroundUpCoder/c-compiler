# 0093 — Recycle Bin — trash, restore, empty

- **Status**: open
- **Design**: `todos/WIN32.md`, `todos/WM.md` (desktop icon layer). A trash
  store + a desktop Recycle Bin icon; integrates with fileman delete (0092)
  and the desktop/file context menus (0091).

## Goal

The Recycle Bin is the most iconic object on the Win95 desktop, and nothing
owns it. Deletes (0092) should be recoverable, not permanent. Ship the bin.

## Plan

- **Trash store** — a per-user trash dir (`/root/.recycle/`) holding the moved
  file plus a sidecar recording its original path + delete time (the Win95
  `INFO2` idea, kept simple as one metadata file per entry).
- **Delete = move to trash** — fileman delete (0092) and desktop-icon delete
  move into the store instead of `unlink`; Shift+Delete bypasses to permanent
  delete (with confirm).
- **Desktop icon** — a Recycle Bin icon on the desktop (`os/wm.c` icon grid),
  full/empty glyph by trash contents; double-click opens the bin in fileman
  filtered to the store.
- **Restore / Empty** — context menu (0091) on the bin: Empty Recycle Bin
  (confirm → real delete of the store); per-item Restore returns the file to
  its recorded original path (name-clash → prompt).

## Non-goals (record, don't build)

- Size quota / auto-purge policy — unbounded until Empty, like early Win95.
- Trashing from the RO /usr volume (0040) — those files are immutable; N/A.
- A dedicated Recycle Bin app window — it opens *in fileman*, not a new app.

## Acceptance

- Headless: delete a file via fileman → it's gone from its dir and present in
  `/root/.recycle/` with a sidecar; Restore returns it to the original path;
  Empty clears the store.
- Browser (`os-shell.mjs`): the desktop Recycle Bin shows empty, deleting a
  file switches it to full, opening it lists the file, Restore puts it back on
  the desktop.
