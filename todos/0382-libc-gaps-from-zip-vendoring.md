# 0382 — libc gaps surfaced by the 0350 zip vendoring: umask(2) and id_t absent, strcasecmp mis-headered, 6 time/at-family functions missing

- **Status**: open
- **Design**: this file.
- **Provenance**: fallout of the **`0350`** libarchive-vs-libzip measurement (branch `0350-zip`,
  harness `tools/zipmeasure/`). Filed by master cont-125, 2026-07-28.
  ⭐ **These are ours regardless of which zip library wins the `0350` tie-break** — both
  candidates hit them. Do **not** block this on that decision, and do not let it get closed as
  "no longer needed" if the veto flips the library (lesson (CF): the consumer moving is not the
  defect being fixed).

## Goal

Close the libc surface the zip lane had to shim or configure around, so the next real vendoring
does not re-pay the same cost.

## The gaps, as measured

**Absent outright — the lane had to shim them to compile at all:**

1. **`umask(2)`** — missing.
2. **`id_t`** — the type is missing.

**Mis-headered:**

3. **`strcasecmp`** — needs `<strings.h>`; the lane had to reach for it explicitly.

**Absent but cleanly configurable around** (upstream autoconf-style probes find them missing and
take a fallback path, so they cost portability config rather than a shim):

4. `gmtime_r` · 5. `timegm` · 6. `tzset` · 7. `fstatat` · 8. `openat` · 9. `mkfifo`

⚠️ **Do not treat group 3 as low value just because it is "configurable around".** Every absent
`*at` function is a portable-code paper cut that each future vendoring pays again, and the
`*at` family in particular is what modern upstreams reach for by default.

🔴 **Cross-check before scoping:** `0325` tracks a separate absent-symbol set (`fma`,
`gmtime_r`, `clock_getres`, `wcstol`, `isascii` — all re-measured absent on main, 2026-07-28,
and **`0325` is anchored by pinned liability `L48`**). **`gmtime_r` appears in BOTH.** Decide
deliberately which ticket owns it and say so in both, rather than letting two lanes implement
it twice or each assume the other did.

## Plan

1. Confirm each gap on current `main` with a compile probe. 🔴 **Give the probe a POSITIVE
   CONTROL** (a symbol we *do* have, compiling clean in the same run) — lesson (AZ): a
   "not found" sweep with no control cannot distinguish absence from a broken harness. This
   ticket's whole content is a list of negatives, so the control is load-bearing.
2. Implement 1–3 (the hard blockers) first — they are what stopped a real build.
3. Implement 4–9, resolving the `gmtime_r` overlap with `0325` first.
4. Test each added symbol against real semantics, not just linkage — an `umask` that links and
   returns 0 unconditionally is worse than an absent one, because it silences the probe that
   would have caught it (the `tcflush`/L48 failure shape: reporting success without doing the
   work).

## Acceptance

- Each implemented symbol has a test asserting **behaviour**, not merely that it links.
- The `0350` harness (`tools/zipmeasure/`) builds **without its shims** for whatever it needed
  shimmed — that is the natural end-to-end proof, and it is already committed.
- The `gmtime_r` ownership overlap with `0325` is resolved in writing in both tickets.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS beside each.

## Notes

`todos/LIABILITIES.md` is machine-checked by the `todos` suite — if a change here rewrites an
anchored line the gate goes RED; re-anchor or retire it in the same commit.
