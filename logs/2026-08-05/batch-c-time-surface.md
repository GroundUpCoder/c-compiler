# Batch C — the time-formatting surface: #116 (%s semantics) then #113 (strptime + strftime tail)

Lane: batch-c worktree, base = main @ 9105adbb (re-measured, matches kickoff).
Sequence is forced: #113 carries a recorded hard `blockedBy` edge naming #116,
because #116's decision rewrites #113's acceptance (the strftime libc-test
asserts `%s`).

## #116 (todos/0310) — strftime %s: musl semantics chosen (option a)

**The question.** Our `%s` was `mktime((struct tm *)tp)` — a *local-time*
reading of the broken-down fields that shifts with the host timezone. musl
computes `%s` from the fields minus `tm_gmtoff` — TZ-independent — and
`vendor/libc-test/src/functional/strftime.c` asserts musl's answer. On this
+0900 host the two differ by exactly 32400 s. Neither is "the bug": the
ticket's own probe showed this host's BSD libc reads TZ and ignores
`tm_gmtoff`, exactly as our mktime reading did.

**What changed since the ticket was filed (2026-07-27), MEASURED in this
lane:** todos/0325 shipped a real zone story — `localtime`/`localtime_r` now
fill `tm_gmtoff` with the true host offset for the instant
(`__timezone_offset` import), `gmtime` fills 0, and `tzset`/`timezone`
publish the host zone. That makes the decisive equivalence checkable:

- **MEASURED: `date +%s` is byte-identical under (a).** busybox `date`
  formats via `strftime` over a `localtime_r`-derived tm
  (`vendor/busybox/src/coreutils/date.c:265` → `:390`). For such a tm the
  fields carry the offset and `tm_gmtoff` records it, so
  `fields-as-UTC − gmtoff` == `mktime(fields)` == the original epoch.
  Verified by compiled probe: both readings return t exactly
  (`mktime_rt:0`). The kickoff's stated risk of (a) — "silently changes
  what date +%s-shaped shell code reports" — does not materialize on this
  target, *because* 0325 landed first.
- **MEASURED: (a) fixes a real wrongness (b) had.** For a `gmtime`-derived
  tm (gmtoff 0), the mktime reading returned `t − host_offset`; the musl
  reading returns `t`. Only (a) round-trips BOTH of this libc's own
  converters. Verified by compiled probe (`gm:1451827425`).
- **MEASURED: no other OS-image consumer.** The only `strftime` callers
  under `os/` are `gcode.c` (%Y-%m-%d shapes) and `ctlpanel.c`
  (%Y-%m-%d %H:%M:%S) — no `%s` anywhere outside busybox date.
- **MEASURED: (b) would make the test permanently impossible.** The test's
  `setenv("TZ", "UTC0", 1)` is inert here — no env vars by design, the
  host owns the zone. Under (b) the two `%s` assertions can never pass.

**BELIEVED, NOT VERIFIED: that glibc computes %s via mktime like BSD.** No
glibc box was probed (per kickoff instruction, none was hunted for). The
decision does NOT rest on it: given the equivalences above, (a) strictly
dominates on this target regardless of which libc family is the majority.
The decision rests on the BSD measurement plus the three bullets above.

**Decision: (a), match musl.** Recorded in the comment at the `%s` case in
compiler.js. The two `%s` TZ rows in the libc strftime test now pass (40 →
37 diagnostics), as does the near-INT_MAX `%s` row (see below). L30 retired
from todos/LIABILITIES.md in the same commit.

**Implementation note.** `%s` needed a fields→secs arithmetic that doesn't
consult the zone; rather than add a third copy, the fields→secs computation
was unified: new `__days_from_civil` (Hinnant era-based closed form, exact
over the full `long long` year range under C truncating division) +
`__tm_to_secs_utc`, now used by `mktime`, `timegm`, and `%s`. This replaces
two O(|year−1970|) per-year loops and `mktime`'s own `int y = tm_year +
1900` overflow (same class as #113's) in one move. Round-trips, negative
years, and month normalization verified by compiled probes; the closed form
verified against all the test's expected epochs including
tm_year == INT_MAX (67768036160140800).

**Residue, deliberately left:** `__secs_to_tm` (the secs→fields direction,
used by gmtime/localtime writeback) still walks years from 1970 — fine for
sane dates (~55 iterations), O(|years|) for absurd ones. Not asserted by
any test, not part of either ticket.
