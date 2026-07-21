# gucOS keybind epic bundle → main + v138 deploy

The payoff of the keybind epic: the full stack merged to main and shipped live
to groundupcoder.com as image **v138**. One bundled deploy, three features.

## The stack (all pre-committed, merged as one --no-ff)

Branch `expose` @764a121 carried the entire stack; merged into main at
**743297d**, version bump at **bb3d4ea** (the deployed sha):

- **CHUNK 3** (82131a2) — wire wm.c into the kernel key-grab table
  (KEYBINDING-OVERRIDE-SYSTEM §4): the 4 hardcoded `wmKey` chord blocks become
  `WMP_GRAB_SET` registrations dispatched via `EV_HOTKEY`.
- **Item 2 META-ARROW** (6e63f02) — mode-dependent ⌘+arrow line/doc nav + Mac
  host auto-detect. `seedHostKeyScheme(kfs, platform)` (os-common.js) seeds
  `scheme\tmacos` into the admin `/etc/keys` on a Mac host only, idempotent,
  never clobbering a user override (`~/.config/keys` is a higher cfgstore
  overlay). Tiling relocated to Ctrl+Alt+arrow (keys.h).
- **Item 1 EXPOSE** (764a121) — window overview / Mission Control (Option B:
  LIVE miniatures, not snapshots), Ctrl+Alt+E. Kernel overview state +
  compositor miniature render pass + `wmctl overview`/`pick`.

## Merge

Base of the stack was `2cf1784` (behind main); main had advanced through the
T1 clang ladder + 0270 PP fix + inliner design. Clean `--no-ff` auto-merge —
two files overlapped and both carried each side's additions:
- `os/os-common.js`: main's clang `bakedPackages`/`foldPackages` + the stack's
  `seedHostKeyScheme` (verified my merge is a pure superset of main — only adds
  the seed fn + its export; main's overlay code byte-identical).
- `tests/kernel/run.js`: both `test_overview_e2e.js` and `test_clang_pkgs_e2e.js`
  registry entries present.

## Gate (on the merged tree, v138)

- Image bakes clean at v138 (wm.c/wmctl.c/keys.h/compositor all compile in).
- Kernel suite: **100 passed, 1 flake**. The one red — `test_clang_pkgs_e2e.js`
  — is a **-j4 parallel race on the shared `dist/packages` dir** (the test's own
  Part II §7 "accepted thrash": it rebuilds packages as the `--clang` superset
  while a sibling gucman test rebuilds them as the plain set). Proven: PASS in
  isolation on the merged tree AND on pristine pre-merge main; my merge touches
  zero files on the clang-install path. Same flake class as the known
  `test_gucman_quake` cold-bake flake. Not a keybind regression.
- Both keymap schemes (windows + macos): green (`test_keymap_e2e.js`, incl. the
  Mac-host auto-detect leg).
- `test_overview_e2e.js`: green (10 assertions).
- Browser sweeps `os-keybind` + `os-snap` + `os-overview`: **3/3 green** (the
  overview leg asserts 10 live-miniature behaviors incl. the Option B "miniature
  is LIVE, not a black snapshot" + "injected key flips the miniature").

## Deploy (image-bump path — the wasm blob changed)

Standard comguc recipe (v136/v137 precedent):
1. `image.json` version **137 → 138**, committed on main (bb3d4ea), pushed to
   origin/main (2b6bfb7..bb3d4ea).
2. Clean worktree `git worktree add /tmp/deploy-v138 bb3d4ea` (no node_modules →
   dep-free bake → `build-info dirty:false`).
3. `C_COMPILER=/tmp/deploy-v138 pnpm build` — mkimage v138 (9.0 MiB sealed) +
   12 gucman packages (33 MiB) + provenance. img sha `79170c8d6cc5…`.
4. `ln -s node_modules` then `pnpm verify` — **16/16** (real headless boot of the
   dist: WebGPU compositor, boots to Desktop, in-OS C compile+run, gucman
   install quake from the deployed repo).
5. `CLOUDFLARE_API_TOKEN=… node scripts/deploy.mjs --commit` — uploaded to
   Cloudflare Pages (https://68827bbd.comguc.pages.dev); comguc ledger committed
   local (dfdd54d, unpushed convention).

**Static assets shipped** (not baked): kernel.js (65 overview hits live),
compositor.js (27 overview hits live, the miniature render pass), os.html.
`wm_proto.h` is deliberately NOT a served asset (404) — it's a build-time C
header; its protocol changes are baked into the v138 blob (wm.c/wmctl.c) and
mirrored in kernel.js's JS constants. Both in sync.

## Live verification (real apex, groundupcoder.com)

- `build-info.json`: cCompiler **bb3d4ea**, imgSha `79170c8d…`, dirty:false.
- Served `image.json` version == **138**.
- Live headless smoke (`chromium`, real apex): boots to ready, v138 served,
  hush prompt on VT1, **`wmctl overview` enters live (rc 0)** and toggles back
  out — the Exposé facility works on the deployed bytes — and the baked keymap
  store resolves (`/usr/share/keys` has `scheme`). **PASS.**

## Cleanup

Removed the merged keybind worktrees (`expose`, `meta-arrow`, `keybind-wm`) +
their stray node_modules symlinks + the two temp deploy/repro worktrees; pruned.
The branches `expose`/`meta-arrow`/`keybind-wm` remain (fully merged; jku can
delete anytime). t2-ladder worktree left untouched (separate task).
