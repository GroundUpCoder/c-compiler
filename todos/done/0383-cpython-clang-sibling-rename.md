# 0383 — Coordinated sibling rename: clang-simplified overlay `python-clang` → `cpython-clang` + flip `clangApp` (0374 merge-time step 3)

- **Status**: done
- **Priority**: P0 — **raised from P2 on 2026-07-30 by jku's ruling that the Rust and
  codex work outranks the rest of the ready band.** This ticket is not in that program,
  and it was hoisted for a mechanical reason: `todos/0416` (Lane A4) carries
  `after ▸ 0383`, so leaving this at P2 would have stalled Lane A at A4 while the board
  looked correctly ordered. The half-applied two-repo rename justifies the hoist on its
  own merits as well. `todos/queue.json` is the authority for the rank; read it with
  `node todos/queue.js list`, never as a raw array index (lesson (EU)).
- **Difficulty**: medium
- **Design**: `todos/CPYTHON.md` §6.3 (the two-sided interlock) and the
  **Merge-time steps** section of `todos/0374-rename-cpython-clang.md`, now on `main`.
- **Provenance**: **filed by master cont-126 at the `0374` merge, 2026-07-28.**
  `0374` deliberately deferred this step and recorded it *inside its own ticket* as
  "merge-time step 3". 🔴 **That is why this ticket exists: closing `0374` would have
  retired the obligation with it.** A gap that does not enter `todos/` does not exist.
  This is a **carry-over of a deferred step, not new scope** — `0374`'s reasoning for
  deferring is correct and is preserved below.

## Why `0374` deliberately did NOT do this

`packages/cpython-clang.json` still carries **`clangApp: "python-clang"`**. That field names
the **sibling clang-simplified overlay's payload key** (`/usr/bin/python-clang`) — it is
**not user-visible**, so the clean break jku ruled on is complete without it.

⭐ **The reason it had to be deferred is mechanical, not cosmetic:** renaming the sibling's
project mid-flight turns **every concurrent lane's `mkpkg --clang` red** (`test_clang_pkgs_e2e`)
via the **orphan check against main-tree definitions**. So the rename is only safe once no
in-flight lane still carries an old-name definition.

## Plan — all of it in ONE change window (the §6.3 two-sided interlock)

1. **Wait for the precondition.** Confirm no unmerged lane still carries a `python-clang`
   package definition. Lanes in flight when this was filed: `0370`, `0376`, and the
   iPhone-startup investigation lane. **Re-derive this at pickup — do not trust this list.**
2. clang-simplified `wasm/image/manifest.json`: project `python-clang` → `cpython-clang`
   (**`out` and `install` too**, not just the project key).
3. Rebuild `out-image/overlay.json`.
4. Flip `packages/cpython-clang.json`'s **`clangApp` → `"cpython-clang"`**.

🔴 **Steps 2–4 must land in the SAME change window.** A half-applied interlock leaves the
package definition pointing at an overlay key that no longer exists.

## Acceptance

- `wasm/image/manifest.json` project/`out`/`install` all read `cpython-clang`; `overlay.json`
  rebuilt from it; `packages/cpython-clang.json` has `clangApp: "cpython-clang"`.
- **`test_clang_pkgs_e2e` green** — that is the orphan check this ticket exists to not break.
- `kernel` green **with a NUMBER**.
- `grep -rn "python-clang"` over the tree: every survivor is **intentional and named** in the
  close-out. (At the `0374` merge the legitimate survivors were `tools/bench2x2/*` on-disk
  build roots and artifact names, `logs/` filenames, quoted jku leans, and `0331`'s dated
  record. **Re-derive; do not carry that list forward as fact.**)
- ⚠️ Note the surface is narrow: until this lands, the overlay app keeps its old name, and the
  **opt-in `--overlay=clang-apps` bake channel (default false)** is the only thing that shows it.

## What this does NOT settle

`todos/0331` still owes the **§6.2-vs-uid-657** question — §6.2 reserves `cpython` for a future
our-compiler package, while jku's uid-657 had CPython claiming `python3` + `cpython`. `0374`
settled the **package** name only; this ticket settles the **sibling overlay** name only.
🔴 Do not let either be read as settling the **key reservation**.

## Result (2026-07-30, branch `0383-sibling-rename`)

- Sibling: `clang-simplified` branch `0383-sibling-rename` @ **a1a2a6b** (pushed).
  The commit renames the three manifest fields. The `name`, the `out`, and the
  `install` fields now read `cpython-clang`. The sibling tree has zero other
  `python-clang` occurrences.
- `out-image/overlay.json` is a gitignored build artifact. I rebuilt it in the
  branch worktree with `mk-overlay.mjs --reuse`. Only the `cpython-clang`
  payload compiled (249 TUs, 7,632,598 bytes). The overlay publishes
  `/usr/bin/cpython-clang` and no old-name key. The sibling MAIN checkout keeps
  the old overlay on disk. Rebuild it there at the lockstep merge.
- This repo: `packages/cpython-clang.json` now has `clangApp: "cpython-clang"`.
  `todos/CPYTHON.md` §6.3 now records the rename in place of the stale
  pre-rename note.
- Precondition, re-derived 2026-07-30: **zero** in-flight lanes carry an
  old-name package definition. The lanes the ticket named (`0370`, `0376`, the
  iPhone lane `0379/0385`) have all merged. One unmerged branch,
  `suite-runner-invariant` (0368), holds `packages/python-clang.json` from its
  pre-rename base. Its diff against main does not touch `packages/`, so a
  rebase gives it the renamed file. Re-gate that lane only after a rebase. The
  sibling's one unmerged branch (`mgba-parity`) does not touch the manifest.
- Gate, on the rebased tree (planner selected todos, host, kernel, sweep; each
  suite ran once): todos green; host green; **kernel 137/137** (filter null,
  recorded == total; **`test_clang_pkgs_e2e` PASS**, `test_cpython_clang_e2e`
  PASS). The two clang tests read the sibling branch worktree through
  `CLANG_ROOT`. The pass proves the new overlay key: the old overlay has no
  `/usr/bin/cpython-clang` payload, so `mkpkg --clang` would fail loudly
  against it. **Sweep 42/42** (filter null, recorded == total). The sweep
  dirtied three committed PNGs and one untracked PNG (todos/0438); I restored
  them.
- Survivors of `grep -rn "python-clang"`, bare-name lines: c-compiler **119**,
  sibling **0**. Breakdown: 64 in `logs/` (dated records), 25 in `todos/done/`
  (state at closure), 16 in `todos/0331-*` (the dated record of the ask; 0331
  stays open for the §6.2 key question), 5 in `todos/CPYTHON.md` (a quoted
  lean, the `~/build/python-clang` build root, `logs/2026-07-27` file names),
  1 in `todos/COMMAND-ALTERNATIVES.md` (a quote with a dated rename note),
  1 in `todos/0117-*` (a recipe file name), 7 in `tools/bench2x2/` (on-disk
  build roots and artifact names). All are intentional records or machine
  paths. None is a live surface.
- This ticket does not settle the §6.2 key reservation. `todos/0331` still owes
  that question.
