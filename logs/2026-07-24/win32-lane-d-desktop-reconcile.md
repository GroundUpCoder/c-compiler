# win32 Lane D — the additive desktop reconcile (design §6, image v158)

The final lane of the win32 source-lib stream (design:
win32-sourcelib-design §6/§8 Lane D; Lanes 0/A/B1/B2/C landed before it).
A deleted default Desktop icon used to be gone forever — the user section
seeds exactly once and desktop "Refresh" is a pure re-read. This lane adds
the reconcile: an additive "restore my default Desktop icons" that never
overwrites and never deletes.

## What landed

- **`foldDesktopDefaults(manifest)`** (os-common.js): a PURE manifest
  transform called from `bakeSystemImage` — the one bake choke point, so
  mkimage / boot.js / the in-worker fallback bake all agree. Every
  `user.dirs`/`user.files` entry under `/root/Desktop` gains a twin SYSTEM
  entry at `/usr/share/desktop/default/<rel>`, deep-copied verbatim (links
  stay links, launcher scripts keep content+mode, deck data rides as
  bytes; `optional` semantics included). The manifest stays the single
  author-side truth; the sealed blob carries a rendered copy
  version-locked to it. The Recycle Bin is not in the manifest → never in
  the default set (`ensure_recycle` stays its owner). Empty user Desktop
  set → identity (the foldPackages empty-fold rule); a double fold throws
  on the twin-path conflict (loud, the claim() discipline).
- **`/usr/bin/desktop-defaults`** (os/deskdefaults.c + os/deskdefaults.json,
  fileops.h + cJSON — the software.c build precedent): phase 1 walks the
  baked default tree against the live Desktop — absent → `fo_copy`
  (symlinks as links, dirs wholesale, files byte-copy preserving mode);
  both-dirs → recurse (the additive folder merge: a new default deck lands
  INSIDE the user's existing Presentations/); any other clash → skip,
  counted. Phase 2 walks the gucman DB: an installed package whose
  control.json declares `desktop:{cmd}` (§5, Lane C's field) and has no
  `/root/Desktop/<name>` gets its icon planted — deliberately IGNORING the
  desktop_shortcuts install-time flag (the user just asked for icons) —
  and the plant is RECORDED into the DB record's `desktop` array
  (tmp+rename, the gm_write_file_atomic rule) so `gucman remove`'s reverse
  replay unplants it exactly like an install-time shortcut. Output:
  `desktop-defaults: added N, kept M existing`; exit 0 on a no-op run,
  exit 1 only on a named stderr failure.
- **wm.c**: the desktop right-click menu grew an "Add Default Icons" row
  (CM_ADD_DEFAULTS) after Refresh — a fire-and-forget `spawn_path` of the
  tool (the ctlpanel-spawn pattern); the 1s desk poll surfaces the result,
  `.icons` untouched (new names auto-flow via desk_place).
- **image.json**: `/usr/bin/desktop-defaults` project entry; version
  157 → 158.

## Decisions & gotchas

- **newestBakeInput now scans the manifest AS BAKED** (it folds the
  Desktop defaults before the system-section scan): the twins turn the
  user section's `bin` blobs (mgp decks, gucos.deck) into system-blob
  bytes, so they must be freshness inputs — scan and bake agree by
  construction (the listTreeFiles rule).
- **Phase-2 DB recording** goes slightly beyond §6.2's letter: without it,
  `gucman remove` would strand the reconcile-planted icon (the DB replay
  only unlinks recorded paths). A failed record is a loud warning, never a
  failed plant.
- **The new menu row shifted the pinned desktop-menu geometry**:
  test_ctxmenu_e2e (DESK_MENU_H 164→194, DISPLAY_ROW_Y 146→176, the
  groove pixel row) and test_fileman_ops_e2e (DESK_PASTE_Y 106→136)
  updated in the same commit. os-ctxmenu.mjs needed nothing (its probes
  are row-0/gutter-relative) — verified by a real run.
- **Counting semantics**: a wholesale-planted subtree counts as ONE added
  (the copy decision point); every existing entry visited counts kept.
  The e2e derives expected totals from image.json (the 0166 rule), so a
  future seeded icon shifts the numbers without breaking the test.

## Verification

`tests/kernel/test_desktop_defaults_e2e.js` (registered in run.js, IMG):
blob rendering (link/dir/data/mode), delete three defaults of three kinds
→ all restored, user files on the Desktop and inside a default subfolder
untouched, a user file squatting a default name never overwritten,
idempotent re-run (`added 0`), phase-2 eligible-vs-field-less packages +
DB recording + flag override, and the ctx-menu row driving the tool.
Stable 3/3 under `--repeat 3 --under-load`. Gates: unit 771 pass; kernel
suite 107/108 (the one fail = test_clang_pkgs_e2e's known -j4
dist/packages race, passes isolated); win32ports drift green (PORTS.md
byte-identical); os-gucman.mjs + os-ctxmenu.mjs browser legs PASS.
