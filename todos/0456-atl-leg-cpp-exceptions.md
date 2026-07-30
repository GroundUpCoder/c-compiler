# 0456 — ATL leg: vendor ReactOS ATL + COM-lite on libcxx-mini, WITH_EXCEPTIONS packaging

- **Status**: open
- **Priority**: P3 — **jku's explicit call** (see 0455's Provenance; same ruling).
- **Design**: `todos/CLANG-CPP-EPIC.md` (§2.1 covers the libcxx-mini
  burn-down) and `todos/CPP-LADDER-PROPOSAL.md`;
  `~/git/meta/gucos/notes/image-viewer-followup-gdiplus-cpp.md` §3 is the
  scoping read.
- **Provenance**: filed 2026-07-30 by @master (cont-220) on jku's ruling —
  *"The lower tier stuff (ie C++ etc) let's queue it as active but put them as
  P3."* **Queued ACTIVE at P3.**

## Goal

Vendor ReactOS's **ATL** (`sdk/lib/atl`) plus a **COM-lite** layer, built on
**libcxx-mini**, and add **`WITH_EXCEPTIONS`** support to cc2wasm packaging.
This is the leg that unlocks ATL-dependent ReactOS C++ apps — chiefly
**mspaint** (ticket 0457), which is the consumer that justifies it.

## Blocked by 0347 + a PROVEN 0455

Hard deps: **0347** (win32-veneer apps clang-buildable) and **0455**
(solitaire/spider — the ATL-free first rung). 0455 is not merely "done" but
**proven**: if C++-on-veneer is not actually working after 0455, this ticket's
premise is gone. Read 0455's closing statement on that point before starting.

## 🔴 TWO CORRECTIONS TO THE RULING'S FRAMING — both MEASURED by @master at filing

The decomposition handed to @master named two things loosely. Both were checked
against the tree, and both change what this ticket has to do.

### 1. 🔴 THIS IS A CROSS-REPO TICKET. `libcxx-mini` IS NOT IN THIS REPOSITORY.

`libcxx-mini` lives at **`~/git/clang-simplified/wasm/libcxx-mini`** — a
**different repo**. Measured: `find -iname "*libcxx*"` in `~/git/c-compiler`
returns **0** hits (positive control: `libpng` returns **7**, so the instrument
works), while the same search in `~/git/clang-simplified` returns **7** hits
including the `wasm/libcxx-mini` directory itself. The name appears **8 times**
in `todos/CLANG-CPP-EPIC.md`, which is what makes it read as in-tree.

⇒ **This lane spans `~/git/c-compiler` AND `~/git/clang-simplified`.**
🔴 **Its kickoff MUST name a separate worktree for EVERY repo it touches.**
"Work each repo on its own branch" is **not** sufficient — a branch is not a
worktree, and a lane told only that will branch the second repo's **MAIN TREE**,
which is compliant but silently breaks the coordinator's merge recipe at its
last step, *after* the push has already landed. One explicit `git worktree add`
line per repo.

### 2. 🔴 `WITH_EXCEPTIONS` DOES NOT EXIST YET — YOU ARE CREATING IT, NOT FLIPPING IT.

Measured: `WITH_EXCEPTIONS` = **0** hits across `*.json`/`*.js`/`*.mjs`/`*.md`
in this repo (positive control: `WITH_PNG` = **1** hit, so the search works).
The ruling's phrase *"`WITH_EXCEPTIONS` support in cc2wasm packaging"* describes
**new work**, not an existing switch.

⇒ Because it is a **new build-time switch on a vendored engine**, it owes the
repo's **four-part kill-switch convention** (from 0431), and part 3 is the whole
point:

1. the `#ifdef` in a header,
2. a doc comment saying what it restores,
3. 🔴 **an A/B baseline leg that builds the compiled-out variant and asserts the
   pre-switch behaviour**,
4. a `README.md` entry naming the switch and its leg.

Guard the **behaviour at its chokes**, not every file the commit touches.

## Plan

1. Set up a worktree **per repo** (`c-compiler` + `clang-simplified`).
2. Assess `libcxx-mini`'s current surface against what ATL needs; grow it toward
   libc++-lite per `CLANG-CPP-EPIC.md` §2.1's standing ruling rather than
   forking a parallel STL.
3. Vendor ReactOS `sdk/lib/atl`; record the upstream revision.
4. Implement the **COM-lite** layer ATL needs. Keep it thin — note 0453's
   finding that `shimgvw`'s own `comsup.c` is 57 lines.
5. Add **`WITH_EXCEPTIONS`** to cc2wasm packaging with the full four-part
   convention above.
6. Prove ATL compiles and links against the veneer with a minimal ATL consumer
   (0457 is the real one).

## Acceptance

1. **Both repos' work lands together.** State the branch/worktree in each repo.
   🔴 Before reporting done, rebase onto current `origin/main` **in each repo**
   and re-gate on the rebased trees. **Do not merge to main — the coordinator
   merges.**
2. 🔴 **Ask what the CONSUMER READS, and whether that thing is under version
   control.** A cross-repo interface can have a **third, non-git half** — a
   *built* artifact (this fleet has been bitten by a gitignored `out-image/`
   overlay twice). If `clang-simplified`'s side publishes anything consumed via
   a build output rather than a committed file, **say so and state what the
   merge owes** (e.g. a rebuild), because no git-level check will reveal it.
3. **`WITH_EXCEPTIONS` ships with all four kill-switch parts**, and **the A/B
   baseline leg demonstrably fails when the switch is compiled out** — a guard
   that passes without guarding is worse than no guard. Show the failing leg.
4. **ATL compiles and links** against the veneer; a minimal ATL consumer runs.
5. **libcxx-mini growth is additive** — nothing already green on the ladder
   (Box2D, ImGui, ETL's 1,984 wasm unit tests, GLM, Ninja, tinyrenderer,
   Stockfish) regresses. **Name the suites you ran and give their numbers.**
6. **A registered test, with the new total stated** (before and after).
7. **Build-to-the-goal:** ATL and the exceptions path are first-class. "Only
   mspaint needs it" is not a reason to narrow the implementation to mspaint's
   exact call set.
