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

⚠️ **The `83a84` offset and the "127 on disk / 126 registered" provenance above are
DATED MEASUREMENTS, not current facts.** The kernel suite grows, so both numbers move
whenever any lane adds a test. Re-measured 2026-07-30: **138 files on disk, 137 registry
entries, gap still exactly 1, still `test_punes_e2e.js`.** (todos/0413 added a test and
registered it correctly, so the gap did not widen.) 🔴 **Do not carry any of these
numbers. Re-run the `diff` above on your own branch and print what it says.** The
identity of the orphan is the durable fact here; the counts are not.

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

## Acceptance

**All THREE Plan steps are required.** Step 3 is not optional polish — it is the step
that closes the class, and steps 1-2 without it fix one file and leave the next orphan
just as invisible.

- `test_punes_e2e.js` is named by a registry row in `tests/kernel/run.js`, with a
  `timeoutMs` sized like the sibling emulator e2e. **State the value you chose and the
  sibling row you matched it against.**
- The kernel suite runs the file. Report the suite with a **NUMBER**, `filter: null`, and
  `recorded == total` — and state the **NEW** total. 🔴 The old total is a
  passing-looking number that means your test did not run.
- 🔴 **A RED on `test_punes_e2e.js` is EXPECTED.** It has not executed under the suite
  since `d8701a1e`. **Root-cause it. Never delete the registration, never opt the file
  out, and never edit the test to agree with a broken `/bin/punes`.** State the root cause
  in the close-out. If it passes first try, say that explicitly — a silent pass on a test
  that has not run for months is a claim worth flagging, not burying.
- A `tests/kernel/test_*.js` on disk that no registry row names **FAILS** the suite. An
  explicit opt-out list exists for anything deliberately excluded, and every entry on it
  carries a one-line reason.
- 🔴 **Prove the completeness check by making it FAIL.** Add a throwaway unregistered
  `tests/kernel/test_*.js`, show the suite goes RED and quote the message, then remove it
  and show the suite goes green again. **Both halves, in the close-out.** A guard that has
  never been observed to fail is not known to guard, and this guard's entire value is
  catching an orphan nobody is looking for — the exact failure this ticket documents.
- **Print the derived counts**: files on disk, registry rows, and the size of the opt-out
  list. 🔴 **Derive them; do not carry a number from this ticket or from any note.** They
  have already moved twice (127/126 at filing, 138/137 on 2026-07-30). Printing them is
  what makes a future shrink visible.
- No existing kernel test is deleted, renamed, skipped, or opted out in order to make the
  suite green. If a second orphan turns up when step 3 lands, **register it or file it** —
  do not opt it out to get a green.
- `node todos/queue.js check` passes, and the todos suite is green **with a NUMBER**.
