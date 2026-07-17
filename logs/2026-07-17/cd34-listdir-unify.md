# CD34 — os/listdir.h: one dirent walk, 120 KB of comdlg32 BSS gone (todos/0250)

The "opendir → readdir → stat per entry → sort → render" loop existed
three times, each with drifted policy: comdlg32.c `fd_refill` (a
`static char names[512][240]` + `isdir[512]` snapshot — 123,392 bytes of
BSS in every app linking the Win32 veneer, dialog opened or not; no
dotfile hiding; an O(n²) dirs-first selection sort), fileman.c `refill`
(its own `Ent {name, isdir, size, mtime}`, dotfiles behind the View
toggle, qsort), and wm.c `load_entries` (menu content: lstat, `is_link`,
a symlink to a directory cascades, ALL dotfiles skipped).

## The shape

`os/listdir.h` (header-only, the openwith.h/cfgstore.h/fileops.h
textual-inclusion idiom): `ld_ent { char name[LD_NAME=256]; int is_dir;
int is_link; long size; long mtime; }` — 256 because BlockFS caps names
at 255; fileman's old 240 and comdlg32's 240 were quiet truncations.
`list_dir(path, out, max, flags)` does ONE lstat per entry (all four
facts are free off it), skips `.`/`..` always and lstat-failures
(vanished mid-walk), and returns the count — or **-1 on an unopenable
dir**, so fileman can keep telling "(cannot open directory)" from an
empty pane. Flags:

- `LIST_HIDE_DOTFILES` — skip leading-dot names.
- `LIST_FOLLOW_LINKS` — a symlink reports its TARGET's
  is_dir/size/mtime (dangling → zeros) while `is_link` stays 1. Both
  facts at once is deliberate: wm.c's menu rule needs "is a link" AND
  "links to a dir" simultaneously.

Sorting is CALLER policy — comdlg32's dirs-first comparator (now a plain
qsort; the old selection sort existed only because names and isdir were
parallel arrays that a qsort would have unpaired), fileman's entcmp
(view sort keys), and wm.c's Recycle-Bin tail pin are all different on
purpose, so the helper bakes in no order.

## Callers wired (and the one deferred)

comdlg32's snapshot is now heap-scoped to the refill (`malloc`/`free` —
it must not be static, and 136 KB doesn't fit the wasm stack).
Measured by `__heap_base` on the linked apps: notepad 335,400 → 212,008
(**−123,392**, exactly the two dead statics); fileman 897,944 → 784,792
(−123,392 from comdlg32, +10,240 from `Ent`'s name field growing
240→256 via `typedef ld_ent Ent`).

wm.c's `load_entries` is the third class member and is deliberately NOT
wired here: menu-content code that overlaps the CS3 menu-dir deferral
(todos/0244) and the pending menu-subsurface redesign — a coordination
deferral, recorded in todos/0250 with the adoption recipe (flags
`LIST_HIDE_DOTFILES | LIST_FOLLOW_LINKS` reproduce it exactly;
`LD_NAME` == `ENT_NAME`).

## Proof

Behavior-preservation is a byte-identical pre/post diff of the rendered
listings over a fixture exercising every axis (dirs, files, a dotfile, a
link-to-dir, a link-to-file, a dangling link; mtimes pinned with
`touch -d "… 03:04:05"` — a bare `touch -d DATE` under busybox keeps
wall-clock minutes and defeated the first diff): fileman default view,
fileman Show Hidden view, and the comdlg32 Open dialog navigated to the
fixture all match HEAD's output exactly. Image v113; kernel suite 76/76;
browser sweep 27/27; compiler.js untouched (not codegen).
