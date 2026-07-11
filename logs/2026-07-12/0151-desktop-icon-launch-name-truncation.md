# 0151 — Desktop icon won't launch for long/spaced filenames (name[32] truncation)

**What / why.** Reported P0: double-clicking a desktop icon whose filename
"has spaces won't seem to launch." The queue item had already done the
verification legwork and pinned the real defect — not spaces at all, but
**length**: `menu_ent.name` was a fixed `char name[32]` (os/wm.c). `load_entries`
`snprintf`-truncates any Desktop filename ≥ 32 chars into it, `desk_launch` then
builds `/root/Desktop/<truncated>`, and `activate()`'s `stat()` fails → **silent
no-launch, no error**. Long names disproportionately contain spaces, which is
why the reporter blamed spaces ("My Really Long Application Name Here" = 36
chars → truncated → dead icon).

**Fix.** Grew both `menu_ent.name` and the mirrored `sm_item.name` from `[32]`
to a new `ENT_NAME` (256) — a full BlockFS directory name is 255 chars + NUL
(host.js `d_name[256]`), so no filesystem name can truncate on the launch path
now. The same `menu_ent` feeds the desktop grid AND the Start-menu flyout
columns (`mcol.ents`), so the flyout launch (`c->dir + "/" + ents[i].name`) got
the same fix for free.

**Audit (the "no fixed-size truncation left" acceptance).** Walked every
fixed-size name/path buffer on the desktop/menu launch path and confirmed each
fits a 255-char name: `desk_launch` `path[300]` (14 + 255 = 269), the `.icons`
`line[320]`/`nl[320]` ("col row " + name + "\n" ≈ 270), the rename `oldn[256]`/
`oldp[300]`/`newp[300]`, `desk_ebuf[256]` (input capped at 255), and the flyout
`path[600]` (`dir[300]` + "/" + name). No other change needed. `menu_dir[32]`
only ever holds the literal `/etc/menu` or `/usr/share/menu`, not a user name.

**Not spaces.** Confirmed there is NO spaces-only failure beyond length: a SHORT
spaced launcher (`My App`) launches even with the pre-fix `name[32]`, so
truncation was the whole bug (Plan step 3 moot).

**Tests.**
- Kernel e2e leg in `tests/kernel/test_wm_service_e2e.js`: clears the Desktop to
  two known launchers (a short spaced name and a 36-char spaced name — the sort
  puts `My App` at row 0, the long name at row 1, Recycle Bin pinned to the
  tail), `wmctl dblclick`s each, and asserts the winbox count rose by one both
  times (`LN-SHORT-DELTA-1`, `LN-LONG-DELTA-1`). This drives the REAL wm.c +
  kernel + activate() launch path headlessly. **Proven regression witness**:
  temporarily reverting `menu_ent.name` to `[32]` makes only the long-name
  check fail (`LN-LONG-DELTA-0`) — the short one still passes.
- Browser leg in `tests/browser/os-shell.mjs`: same two launchers, `dblclick`
  each, coordinate-free `winCount()` (the existing `WBQ` idiom) asserts +1 both
  times. Operator-owed run under the standing 0064 browser-sweep debt —
  Playwright is not installed in this clone.

**Verified green:** `test_wm_service_e2e.js` (all legs incl. the 3 new checks),
`test_os_boot.js`, `test_ctxmenu_e2e.js` (menu-heavy wm.c paths), `queue.js
check`. Image bumped to **v72** (wm.c is a seeded bake input — a persistent
browser OPFS image only re-fetches on a version bump).

**Gotcha note.** The bug is invisible to any test that only uses short seeded
icon names — the whole existing desktop corpus is < 32 chars. Length-boundary
launch names are now covered.
