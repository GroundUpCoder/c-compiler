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

## #113 (todos/0307) — strptime + the strftime tail

Sequenced after #116 by the recorded hard edge; its acceptance was restated
against the post-#116 world: with (a) chosen, the strftime test's `%s` rows
pass as written, so the full un-skip is reachable.

**Bug-fix-first (class 1, wrong answer from shipped code).** `tm_year +
1900` was computed in `int` at every year-consuming conversion, so a
near-INT_MAX `tm_year` wrapped (`%Y` → `-2147481749`). All year arithmetic
now goes through `long long` (`__ap_llw`, the year-shaped formatter). The
`%s` leg of the same class was already retired by #116's closed-form
helper. Standing guard independent of the libc-test skip:
`tests/unit/conformance/strftime_year_overflow` — NOTE its expected.stdout
is musl-semantics-verified (vendor/libc-test's own assertions), NOT
host-clang-verified: BSD libc prints no `+` for wide `%Y` and has no width
modifiers, so the host libc cannot be the oracle for libc-owned formatting.

**The width/'+' engine (`__ap_llw`).** One formatter implements the
C23/musl `%[+0][width]` rules for %C/%F/%G/%Y, derived row-by-row from the
libc-test's 30 width assertions: no-width = zero-pad to the default width
counting the sign, `+` prefix once a Y/G/F year outgrows 4 digits (Austin
#739); explicit width = pad (sign first) to exactly the width, implicit
`+` suppressed, the `+` flag emitting only when the digits leave room.
%F applies the width to the whole string by giving the year
`width - strlen("-mm-dd")` (floor 1). The parser also accepts bare-digit
widths and skips C99 E/O modifiers. Incidental fixes in the same move:
zero-padding now goes sign-first (the old `__ap_int` emitted zeros BEFORE
a minus), and `%y`/`%x` take `|year % 100|` in long long (musl's absolute
value for negative years).

**ISO week (`__iso_week`).** musl's yday/wday algorithm, shared by %V and
%g/%G (they must agree). The subtraction operands stay nonnegative because
the dec31 form only runs at yday < 7 and the jan1 form only at yday > 360 —
noted in the comment since musl leans on unsigned wraparound instead.

**strptime.** New, in `__time.c` next to strftime, sharing the name
tables: POSIX XSI set + glibc %F/%s/%z (what the corpus exercises), glibc
%y/%C century combination ("10.7.56 in 18th" → 1856), immediate %p
adjustment, recursive compound conversions (%c %D %F %r %R %T %x %X),
optional max field widths, %z filling tm_gmtoff (+hh[[:]mm] and Z). %s
parses via gmtime_r — the parse-side face of the #116 decision (glibc
reads it through localtime_r, i.e. TZ-dependent; the corpus runs under
TZ=UTC0, which this target cannot express).

**Measured rows (python3 tests/run.py --types=libc -v, this worktree):**

| row | BEFORE (@9105adbb) | AFTER |
|---|---|---|
| libc/strftime | SKIP | PASS |
| libc/strptime | SKIP | PASS |
| suite totals | 36 passed / 0 failed / 40 skipped | 38 passed / 0 failed / 38 skipped |

Direct runs: strftime 40 diagnostics → exit 0; strptime absent → exit 0.
`tests/unit/conformance/strftime_year_overflow` passes. L27 retired from
todos/LIABILITIES.md in the same commit; both skip entries deleted from
tests/run.py.

## Gate-found: two vendored strptime fallbacks collide with the new symbol

The first full gate went red across the whole kernel estate — every boot
died with `Link error: Duplicate definition of symbol 'strptime'` at the
image bake (vendor/jq/bin.json), which cascaded into 30+ kernel e2e
failures including a SIGTERM storm from re-bake memory pressure. Cause:
two vendored WASM-port shims existed precisely because the libc used to
lack strptime, and #113 made them collisions:

- `vendor/jq/src/jq_gucos_shims.c` — a full non-static strptime. Its own
  header note said "if a future compiler.js grows them, drop the
  define(s) and this TU can shrink"; this is that moment. TU deleted
  (bin.json + README updated); `jq_gucos_shims.h` reduced to
  `#include <time.h>` so builtin.c needs no further patching. The libc
  strptime covers jq's full specifier set.
- `vendor/busybox/src/coreutils/sort.c` — a static `"%b"`-only shim under
  `__wasm__`, now an invalid static redeclaration against `<time.h>`.
  Deleted; `sort -M` calls the libc. date.c's ISOFMT guard stays (a pure
  config choice now — comment and README updated to stop claiming the
  libc lacks strptime).

Swept the rest of vendor/: netsurf/libgit2/duktape/cpython only CALL or
mention strptime — these two were the only definitions. Verified: all 29
`projects` builds pass; a headless boot bakes clean and in-OS
`date +%s` / `sort -M` / `jq -R .` all behave.

**Kickoff correction (harness mechanics, measured):** the claim "the Bash
tool caps at 600s and the harness converts the call into a tracked task at
the cap" is FALSE in this session's harness — a foreground call is
SIGTERM-killed at its timeout (measured twice: explicit 600s cap and the
120s default; exit 143 both times, gate process dead, no task created).
The only mechanism that reaches the kickoff's mandated state (a tracked
task + the turn held open with blocking TaskOutput until real exit) is
starting the gate as a tracked background task and never ending the turn
while it runs. Recorded because the "kills, not converts" behaviour also
explains the first red gate's SIGTERM storm: attempts 1 and 2 died this
way mid-run.
