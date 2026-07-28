# 0381 — git clone -> kfs -> compile -> run a real GitHub repo on gucOS (THE consumer of 0380)

- **Status**: open
- **Blocked by**: `0380` (hard — there is no reachable origin without the relay)
- **Design**: this file; substrate design in `todos/0380-github-fetch-proxy.md`.
- **Provenance**: jku, stated goal — *git clone a repo, compile it, and run it on gucOS*.
  Filed by master cont-125 off the inbox-triage decider's **D1** ruling, 2026-07-28.
  ⚠️ Same D-namespace warning as `0380`: three unrelated D-series exist.

## Goal

Close the loop jku actually asked for: from inside gucOS, clone a public GitHub repo, land it
in kfs, compile it with the in-image clang, and run the result.

## Plan

The relay (`0380`) is the small half. This is the real work, and it is a **stream**, not one
change — expect it to split into further tickets once step 1 lands and the shape is measured.

1. **Fetch → kfs.** Land a repo into the filesystem. Start with the codeload tarball path
   (simplest correct thing over the relay), untar into kfs.
2. **Real clone.** isomorphic-git (or equivalent) over git-smart-HTTP through the relay, so
   the result is a genuine working copy with refs — not a snapshot. ⚠️ This is the step that
   justifies having built (b) rather than (a); do not stop at step 1 and call the stream done.
3. **Compile.** Drive the in-image clang over the cloned tree. Expect the first real repos to
   surface missing headers/libc surface — file those as their own tickets rather than
   widening this one.
4. **Run.** Execute the built artifact in gucOS.

## Sequencing

Hard-blocked on `0380`. Both sit **after the current P0 merge train**.

## Acceptance

- A named, pinned public repo clones, compiles, and runs end-to-end **in a browser sweep**,
  asserted by a test — a rendered screenshot for the run step, per the `0345` precedent.
- Pin the repo and the commit. 🔴 A test that clones `HEAD` of a live upstream is a
  **network-flaky test that also silently changes what it proves**; pin the sha.
- The clone path is exercised, not only the tarball path (step 2 is not optional).
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS beside each.

## Notes

`todos/LIABILITIES.md` is machine-checked by the `todos` suite — if a change here rewrites an
anchored line the gate goes RED; re-anchor or retire it in the same commit.
