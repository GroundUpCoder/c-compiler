# P0: test_wm_service_e2e near-deterministic failure on clean main — root cause + fix

## Symptom
`tests/kernel/test_wm_service_e2e.js` fails on clean origin/main with three
`wmctl: wait count timed out after 15000ms` (driveBoot's 0171 loud-symptom
gate), reproduced deterministically in a fresh worktree at c7119be.

## Root cause — a regression, not a race
Commit **a291187** (0272: MagicPointPlus, landed 2026-07-23 01:22) added a new
baked Demos menu entry `/usr/share/menu/Demos/mgp-plus` to `os/image.json` —
and did NOT bump the hardcoded `DEMOS` leaf lists in
`test_wm_service_e2e.js` and `tests/browser/os-shell.mjs` (the lists the
test's own comment said to bump).

The live Demos flyout is now NINE rows (`startmenu3` height 274 = 4 + 9·30);
sorted, `mgp-plus` lands between `mgp` and `slides`, pushing `slides` to
row 7 and `winbox` to row 8. The test clicks
`flyRowY(DEMOS.indexOf('winbox'))` = row 7 → it launches **slides** (sent,
800x500 — visible at `==menu2` in the transcript; `~/.config/recent` records
`/usr/share/menu/Demos/slides`). The second winbox never spawns, so
`wmctl wait count winbox 2` times out, and the later `count winbox 6`/`7`
waits inherit the same off-by-one. All three timeouts are ONE root cause:
the wrong flyout row.

### Why "33% flake" drifted to "near-deterministic"
It didn't drift. The historical ~33% load-flake was the 0283 placement race
(fixed by the `wait flag $WSID f` settle). This is a fresh, fully
deterministic breakage that landed ~14h ago and was misread as the old flake
by reputation. No environment shift involved.

## Fix — derive, never hardcode (the 0164/0166 rule, applied to menu rows)
The desktop icon grid already derives from `os/image.json` (`deskEntries`,
after 785eca2's notepad icon shifted every hardcoded row — todos/0166). The
Start-menu tree had the same latent trap and it fired. Same cure:

- `tests/kernel/lib/drive.js` grew `menuGroups()` / `menuLeaves(group)`:
  the baked menu tree = image.json's `/usr/share/menu/*` entries ∪ every
  **non-gated** package's `menu` entries (what `mkimage --packages=all` —
  the FAT test fixture — folds in at `/usr/share/menu/<group>/<entry>`).
  The gating rule is REUSED from `os-common.js listPackages` (a def with a
  non-empty `requires` stays out of the fold), not duplicated. Sort
  replicates wm.c `entcmp` (groups first, byte strcmp). A fresh boot has an
  empty `/etc/menu`, so the baked tree IS `menu_load_union`'s result.
- `test_wm_service_e2e.js`: `MENU_GROUPS`/`DEMOS` now call those helpers.
  The `/etc/menu/Apps` union leg (`flyH(MENU_GROUPS.length + 1)`) stays
  correct — that dir is created at runtime, on top of the derived groups.
- `tests/browser/lib/os-harness.mjs` RE-EXPORTS the two helpers via CJS
  interop instead of twinning them (deskEntries is twinned there for
  historical reasons; a second copy of the menu model is exactly the drift
  class that caused this bug). `os-shell.mjs` switched to the derived lists.

## Evidence
- Pre-fix: fails 2/2 in the worktree (and 3/3 in the 0273b lane's runs).
- Post-fix isolated: 5/5 green (~56s each; the failing runs were ~101s —
  3×15s dead timeouts).
- Flake tripwire `node tests/flake.js --kernel-only --filter=wm_service`:
  green 3 invocations × 3 under-load repeats = 9/9.
- Full kernel suite: 102 passed / 1 failed — the failure is
  `test_clang_pkgs_e2e.js`, the pre-known -j4 dist/packages race (passes
  isolated, 3.4s, confirmed). Not related.
- Browser: `os-sweep --filter=os-shell` green (112.9s) with the derived
  lists.

## Deferred, not cut
- `os-harness.mjs` still twins `deskEntries`/`deskSort`/`deskCell` instead
  of re-exporting drive.js the way menuGroups/menuLeaves now do; unifying
  them is a trivial follow-up but out of this P0's blast radius.
- The 0272 lane's process gap (a manifest menu edit with no test-list bump)
  is now structurally closed for menu ROWS; other hardcoded row models
  (if any appear) should follow the same derive rule.
