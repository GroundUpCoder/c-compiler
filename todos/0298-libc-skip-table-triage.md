# 0298 — tests/run.py skip table: triage the 13 TODO-candidate libc gaps into real items (check fnmatch first)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #11).

## Goal

Turn a permanent skip table into either coverage or filed items.

`tests/run.py:1388-1407`:

```python
# Library features not implemented (TODO candidates)
"fnmatch": "TODO: fnmatch()",  "search_hsearch": "TODO: search.h",
"random": "TODO: random()/srandom()/initstate()",  "strptime": "TODO: strptime()",
"setjmp": "TODO: sigsetjmp/siglongjmp aliases",  "memstream": "TODO: open_memstream()",
"wcstol": "TODO: wcstol() family",  "fwscanf": "TODO: wide scanf",  …
```

**Every one of these makes the suite report green while skipping the test.** Ticket grep:
`fnmatch` 0, `strptime` 0, `hsearch` 0, `wide scanf` 0.

Individually low blast radius. The **aggregate** is what matters: a green libc suite with 13
documented holes in it. "TODO candidate" is a status that has never advanced to anything.

## Start here — one entry is probably already stale

**`fnmatch` IS available** via the optional `libc-ext.js` (`ext/`). So at least one skip entry
may be obsolete, meaning the table is not only unfunded but partly **wrong** — a skip that hides
working functionality. Not verified; verify it first, since it is the cheapest possible win and
it calibrates how much of the rest of the table to trust.

## Status of the facts

**Inventory-only.** The sweep read the table and grepped tickets; it did not test any of the 13.

## Plan

- Verify each of the 13 against current libc + `ext/`: **already works** / **genuinely missing**.
- Remove skip entries for anything that works (and let the tests run).
- For what is genuinely missing: either implement the cheap ones, or file real items and make the
  skip entry **cite the ticket id** — `0286`'s register rule applied to the skip table.
- Outcome must be that no entry says only "TODO" with nothing behind it.

## Acceptance

- Zero skip entries reading "TODO" without either a ticket id or a removal.
- `fnmatch`'s actual status determined and acted on.
- Any newly un-skipped tests pass (or their failure is filed).
- The libc suite green with a **NUMBER** reported, and the skip count stated before and after.

## VERIFICATION (cont-78, 1e8a940)

**Verdict: PARTIALLY CONFIRMED — and the headline guess is right, twice over.
`fnmatch` is a stale skip hiding a test that PASSES today. So is `fdopen`.
`setjmp`'s stated reason is wrong (the aliases exist; a different, bigger thing
blocks it). The other 10 entries are genuinely missing.**

### `fnmatch` — the named cheap check: **STALE SKIP, and the test passes**

`fnmatch()` is implemented: `ext/src/fnmatch.c:298` (musl's own, MIT), declared in
`ext/include/fnmatch.h:18`, which `__require_source("fnmatch.c")`s the TU
(`fnmatch.h:6`). `libc-ext.js` is present in the tree (148 KB) and carries it.

Proven twice, both cheap single-file compiles (no suite run):

1. A hand-written probe — `fnmatch("*.c","foo.c",0)`→0, `("*.c","foo.h",0)`→1,
   `("a?c","abc",0)`→0, `("/a/*","/a/b/c",FNM_PATHNAME)`→1. All four match glibc.
2. **The actual skipped libc-test, compiled and run exactly as `run_libc_tests`
   would** (`tests/run.py:1431-1441`):
   ```sh
   node compiler.js vendor/libc-test/src/functional/fnmatch.c \
        vendor/libc-test/src/common/print.c vendor/libc-test/src/common/rand.c \
        -Ivendor/libc-test/src/common -o /tmp/libc_fnmatch.wasm
   node --experimental-wasm-exnref host.js /tmp/libc_fnmatch.wasm
   ```
   → **exit 0, empty stdout = PASS** (that is `run.py`'s exact pass condition).

`tests/run.py:1389` `"fnmatch": "TODO: fnmatch()"` is therefore **not merely
unfunded — it is wrong**, and deleting the line un-skips a green test. This is the
free win the ticket predicted.

### `fdopen` — a SECOND stale skip, not predicted by the ticket

`tests/run.py:1395` `"fdopen": "TODO: mkstemp()"`. `mkstemp()` has been implemented
since: declared `compiler.js:24549`, defined `compiler.js:29853-29870`
(`/* mkstemp: POSIX temp-file creation (sed -i and friends). */`), plus
`mktemp`/`mkdtemp` at `:29872+`. Same direct run as above → **exit 0, empty
stdout = PASS**. Deleting this line also un-skips a green test.

### `setjmp` — reason is WRONG, but the skip is still needed

`tests/run.py:1394` says `"TODO: sigsetjmp/siglongjmp aliases"`. Those aliases
exist: `compiler.js:24116-24122`
```c
/* POSIX sigsetjmp/siglongjmp: signals are cooperative on this platform and
   … */
#define sigsetjmp(env, savemask) setjmp(env)
#define siglongjmp(env, val) longjmp(env, val)
```
Verified working by a probe (`sigsetjmp`/`siglongjmp` round-trip returned 7).

The real blocker is a **compiler.js restriction, not a libc gap**:
`vendor/libc-test/src/functional/setjmp.c:23` writes `r = setjmp(jb);`, and
compiler.js rejects it — *"unsupported use of setjmp — only forms like
`if (setjmp(buf))`, `if (!setjmp(buf))`, `if (setjmp(buf) == 0)`, or
`if ((v = setjmp(buf)))` are supported"*. That limitation is already recorded at
`todos/CONFORMANCE-REMAINING.md:92-94`, which also notes plain
`int r = setjmp(b);` is UB per C11 and rejecting it is defensible. **Fix the
reason text and point it at CONFORMANCE-REMAINING; keep the skip.**

### `strftime` — reason is stale in its specifics, still genuinely failing

`tests/run.py:1399` says `"TODO: width modifiers on %F, ISO %g/%G, %s (epoch)"`.
Direct run → **FAIL (exit 1, 40 diagnostics)**. Actual current state:
- `%s` **is** implemented (`compiler.js:31097-31100`, via `mktime`) — the reason
  text is wrong to list it as absent.
- Width/`+` flag parsing **is** implemented (`compiler.js:31002-31016`) but only
  `%C` consumes it (`:31018-31024`); `%Y` ignores it, so `%05Y`/`%+5Y`/`%02Y`/
  `%011Y` all still fail.
- Still entirely absent (they fall through to the literal-echo `default:` at
  `compiler.js:31106-31109`): `%F`, `%g`, `%G`, `%r`, `%T`, `%V` — the reason text
  names only three of those six.
- `%y` is wrong for negative years (expected `47`, got `-49`).
- **`%s` is TZ-dependent and diverges from musl**: for the test's
  `tm1` (2016-01-03 13:23:45, `tm_gmtoff` 0) it expects `1451827425` and we
  produce `1451795025` — exactly 32400 s / 9 h, this host's `+0900`. Ours calls
  `mktime()` (local-time interpretation); musl's `%s` is `tm_gmtoff`-based, so
  musl is TZ-independent and we are not. Recorded here rather than filed
  separately: it is only observable inside this already-skipped test, and fixing
  `%s` is part of whatever funds this entry.

### Triage table — all 13 "TODO candidate" entries (`tests/run.py:1388-1399`)

| line | entry | reason text | verdict | evidence |
|---|---|---|---|---|
| 1389 | `fnmatch` | TODO: fnmatch() | **STALE SKIP — test PASSES** | `ext/src/fnmatch.c:298`; direct run exit 0 |
| 1390 | `search_hsearch` | TODO: search.h | genuinely missing | `hsearch`/`hcreate` → 0 hits in `compiler.js` and `ext/` |
| 1390 | `search_insque` | TODO: search.h | genuinely missing | `insque`/`remque` → 0 hits |
| 1391 | `search_lsearch` | TODO: search.h | genuinely missing | `lsearch`/`lfind` → 0 hits |
| 1391 | `search_tsearch` | TODO: search.h | genuinely missing | `tsearch`/`tfind`/`twalk` → 0 hits |
| 1392 | `random` | TODO: random()/srandom()/initstate() | genuinely missing | only `emscripten_random` (`compiler.js:23398,27701,27716`); `srandom`/`initstate` → 0 hits |
| 1393 | `strptime` | TODO: strptime() | genuinely missing | 0 hits |
| 1394 | `setjmp` | TODO: sigsetjmp/siglongjmp aliases | **REASON WRONG, skip still valid** | aliases at `compiler.js:24116-24122`; real blocker `CONFORMANCE-REMAINING.md:92-94` |
| 1395 | `fdopen` | TODO: mkstemp() | **STALE SKIP — test PASSES** | `compiler.js:29853`; direct run exit 0 |
| 1396 | `memstream` | TODO: open_memstream() | genuinely missing | `open_memstream`/`fmemopen` → 0 hits |
| 1397 | `wcstol` | TODO: wcstol() family | genuinely missing | `wcstol`/`wcstod` → 0 hits |
| 1398 | `fwscanf` | TODO: wide scanf | genuinely missing | `fwscanf`/`swscanf`/`vfwscanf` → 0 hits |
| 1399 | `strftime` | TODO: width modifiers on %F, ISO %g/%G, %s (epoch) | **REASON STALE, still FAILS** | see above; 40 diagnostics |

Adjacent, outside the 13 but in the same block: **`tests/run.py:1407`
`"utime": "TODO: utimensat()"`** is a 14th `TODO:` entry the sweep's count missed.
Not re-verified here.

### Net effect of acting on this

2 entries delete outright and go green (`fnmatch`, `fdopen`). 2 keep their skip but
need honest reason text pointing at a real cause (`setjmp` → the C11-form
restriction; `strftime` → the specific conversions). 9 are genuine libc gaps that
need real items. The ticket's premise — "a green libc suite with 13 documented
holes" — holds, but **two of the holes are not holes**, which is worse than the
ticket assumed: the table was actively misreporting working functionality.

Not done in cont-78 (that lane was read-mostly): the skip table itself was untouched,
and the un-skipped tests were verified by direct invocation rather than through
`tests/run.py`. Confirming via the runner needs `python3 tests/run.py --types=libc`
(a real, but not heavy, run) after the two lines are deleted. — **done below.**

## EXECUTION (branch `libc-skip-triage`)

Acted on the verification above. `python3 tests/run.py --types=libc`:
**before 25 passed / 0 failed / 51 skipped → after 28 passed / 0 failed / 48 skipped.**

**Three stale skips deleted, not two.** `fnmatch` and `fdopen` as predicted, plus the
14th entry the sweep's count missed: **`utime` ("TODO: utimensat()") also PASSES** —
`utimensat`/`futimens` are implemented at `compiler.js:24693-24730`, and a direct
compile+run of `vendor/libc-test/src/functional/utime.c` gives exit 0, empty stdout.
(That test also asserts a 64-bit `time_t`; it would fail loudly on a 32-bit one, so
the pass is real, not vacuous.) All three confirmed again through the real runner.

**Two reason texts corrected.** `setjmp` now names the C11-UB bare-assignment form and
points at `todos/CONFORMANCE-REMAINING.md:92-94` instead of the aliases, which exist.
`strftime` now names the six genuinely-absent conversions and drops `%s` from the
absent list.

**Six items filed** for the remaining ten skips, grouped by facility rather than
one-per-entry: **0305** search.h (4 entries), **0306** random family, **0307**
strptime + strftime conversions (2 entries — they share the `%` conversion table),
**0308** memstream, **0309** wcstol + wide scanf (2 entries — wide scanf is specified
in terms of `wcsto*`), **0310** the `%s` TZ divergence. Every remaining skip line cites
its item; `LIABILITIES.md` L17 retired and replaced by L25–L30.

**Correction to the verification above.** The `%s` finding is stated as "musl is
TZ-independent and we are not", implying we are wrong. Measured against the *host*
libc with a clang-built probe: `TZ=Asia/Tokyo` → `1451795025` (identical to ours),
`TZ=UTC` → `1451827425`. glibc does the same (its `%s` calls `mktime`). So **we match
glibc/BSD and musl is the outlier** — it is a semantics decision, not a defect. Filed
as 0310 on that basis rather than as a bug.

Also found, not in the verification account: the `strftime` failure list includes an
**integer overflow** — `tp->tm_year + 1900` is computed in `int`, so a near-`INT_MAX`
`tm_year` wraps (`%Y` → `-2147481749` where musl gives `+2147485547`). That IS a
correctness bug in shipped code, recorded as defect class 3 in 0307.
