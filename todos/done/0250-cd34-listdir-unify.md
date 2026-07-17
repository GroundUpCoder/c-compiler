# 0250 — CD34 — one header-only list_dir over the three drifted dirent walks

- **Status**: done (2026-07-17) — `os/listdir.h` (`ld_ent` + `list_dir(path,
  out, max, flags)`, flags `LIST_HIDE_DOTFILES`/`LIST_FOLLOW_LINKS`, sorting
  caller-side) wired into comdlg32.c `fd_refill` (the `static char
  names[512][240]` + `isdir[512]` — 123,392 B of BSS in EVERY app linking
  the veneer — replaced by a refill-scoped heap snapshot + qsort; notepad
  `__heap_base` 335,400 → 212,008) and fileman.c `refill` (local `Ent`
  walk deleted, `typedef ld_ent Ent`, dotfile hiding = the flag gated on
  `g_hidden`); rendered listings proven BYTE-IDENTICAL pre/post over a
  fixture with dirs/files/dotfile/link-to-dir/link-to-file/dangling-link
  (fileman default + Show Hidden views, comdlg32 Open dialog); image v113;
  kernel 76/76 + browser sweep 27/27 green.
- **Design**: —

## Goal

Close code-debt scan CD34 (2026-07-17): the "open dir → walk entries →
stat → sort → render" loop was hand-written THREE times with drifted
policy — comdlg32.c:81 `fd_refill` (static 120 KB snapshot, no dotfile
hiding, O(n²) dirs-first selection sort), fileman.c:190 `refill`
(`g_ents`, dotfiles hidden behind the View toggle, qsort), wm.c:1139
`load_entries` (menu content: lstat + is_link, a symlink to a directory
cascades, all dotfiles skipped). The comdlg32 copy alone carried
122,880+512 bytes of static BSS into every app linking the Win32 veneer,
dialog opened or not.

## Plan

One general header-only helper (the openwith.h/cfgstore.h/fileops.h
textual-inclusion precedent): `os/listdir.h` — `ld_ent { name[256 =
BlockFS 255+NUL]; is_dir; is_link; long size; long mtime; }`, all fields
off ONE lstat per entry (+ one stat when a link is followed);
`.`/`..` always skipped, lstat-fail (vanished mid-walk) skipped; returns
count or -1 on unopenable dir (fileman tells an error from an empty
pane). Flags: `LIST_HIDE_DOTFILES`; `LIST_FOLLOW_LINKS` = a symlink
reports its TARGET's is_dir/size/mtime (dangling → zeros) while
`is_link` stays 1 — deliberately BOTH facts at once, wm.c's cascade rule.
Sorting stays caller policy (comdlg32 dirs-first cmp, fileman's
entcmp view keys, wm.c's Recycle-Bin tail pin).

## Acceptance

- comdlg32 + fileman both walk through `list_dir`; no static listing
  buffer remains; behavior exactly preserved (`../` row, `/` suffix,
  dirs-first, 512 cap, dotfile toggle, size/mtime columns) — proven by a
  byte-identical pre/post listing diff.
- Bake green (v113), kernel suite + browser sweep green.

## Deferred 3rd class member — wm.c load_entries (surfaced, tracked)

`os/wm.c` `load_entries` (menu/desktop content) is deliberately NOT wired
in this item: it overlaps the CS3-deferred /etc-vs-/usr-share menu-dir
work (todos/0244) and the pending kernel-anchored menu-subsurface
redesign, which reworks exactly this area — a coordination deferral, not
a complexity one. `list_dir` was built general enough to serve it as-is:
flags `LIST_HIDE_DOTFILES | LIST_FOLLOW_LINKS` reproduce load_entries
exactly (lstat-fail skip, is_link kept, link-to-dir cascades,
`LD_NAME` == wm.c's `ENT_NAME` 256). When the menu work lands, route
load_entries through os/listdir.h and delete the third copy.
