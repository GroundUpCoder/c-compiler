# 0396 — `tests/kernel/test_punes_e2e.js` is not in the kernel registry, so it has never run under the suite

- **Status**: open
- **Difficulty**: light
- **Provenance**: found by todos/0387 while COUNTING the kernel suite to verify a
  gate artifact (127 files on disk, 126 registry entries). Pre-existing on `main`
  — not introduced by `0370`/`0387`.

## The gap

`tests/kernel/run.js` drives an EXPLICIT registry, not a glob. `test_punes_e2e.js`
(the 0088 acceptance for `/bin/punes`, last touched by `d8701a1e` for todos/0213)
is the one `tests/kernel/test_*.js` file absent from it:

```
diff <(node tests/kernel/run.js --list | grep '^test_.*\.js$' | sort) \
     <(ls tests/kernel/test_*.js | xargs -n1 basename | sort)
83a84
> test_punes_e2e.js
```

Nothing else references the file (`grep -rn test_punes_e2e` over the tree finds
only itself), so it is not invoked by a parent test either. It runs only if
someone types its path.

## Why it matters more than one skipped test

`tests/run.js:363` maps `^vendor/(jq|mgba|punes)/` → `projects, kernel, sweep`.
So a diff touching `vendor/punes/` *selects the kernel suite*, the kernel suite
runs 126 green files, and the reporting is honest about everything except the
one thing the rule was written to cover. This is the `--diff` table's failure
mode that UNMAPPED was built to prevent, arriving through the other door: the
path IS mapped, the suite IS selected, and the coverage still is not there. A
rule pointing at a suite that does not contain the test reads as covered.

`recorded == total` cannot catch it — the registry defines `total`.

## Plan

1. Register `test_punes_e2e.js` in `tests/kernel/run.js` with a `timeoutMs`
   sized like the other emulator e2es (`test_mgba_e2e` is the sibling shape).
2. Run it. It has not executed under the suite since `d8701a1e`; treat a red as
   expected and root-cause it rather than deleting the registration.
3. Close the class: make the registry's completeness self-checking — a
   `tests/kernel/test_*.js` on disk that no registry row names should FAIL the
   suite (with an explicit opt-out list for anything deliberately excluded), the
   way `recorded == total` makes a partial run visible. Without this step the
   next orphan is invisible again.
