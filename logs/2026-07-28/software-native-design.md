# Design pass: software manager native-Win32 redesign (SOFTWARE-NATIVE.md)

Read-only design lane, branch `design-software-win32`. jku asked to
"redesign the software manager UI to use win32 instead" — but
verification showed `os/win32/software.c` already IS a Win32 app
(ticket #81), so the ask was resolved as **idiom, not substrate**: the
storefront paints a modern card UI (white header, PkgCard children,
colored states) inside an otherwise classic-Win32 desktop, and the
redesign target is the native Add/Remove-Programs shape.

Decision argued in `todos/SOFTWARE-NATIVE.md`: **build the real
SysListView32 + SysHeader32 in comctl32** (Path 1), then rebuild
software.c on it — not another owner-draw LISTBOX approximation.
The evidence that this is a platform gap, not an app detail: three
approximations already exist in-tree (fileman 0106's space-padded
mono columns — its own comment says "LB_SETTABSTOPS-free" —,
comdlg32's file-dialog LISTBOX, and open ticket 0130's plan written
as "a LISTBOX of" associations).

The load-bearing section is the agent surface: collapsing per-package
HWNDs into one control would break `wmctl` tree/label/click semantics
(tree_dump truncates a window's text at 160 bytes; label resolution is
exact-match). The design extends the menu-item precedent (0171):
rows dump as their own tree lines and resolve as click/gettext targets
via a generic veneer-internal seam, and state waits ride the existing
`wmctl wait text CLASS:n SUBSTR` form. Existing e2e legs
(test_software_e2e.js, os-minimal.mjs leg 2) get mechanical rewrites
and LOSE the fragile `BUTTON:n` ordinal prediction.

Cost: ~5–6.5 lane-days across two hard-ordered tickets
(comctl32-listview → software-native-redesign) plus a recommended
fileman-details follow-on. Ticket ids deliberately left to the master
coordinator (0358 cross-ref allocation; this lane branched while the
main tree was mid-gate).
