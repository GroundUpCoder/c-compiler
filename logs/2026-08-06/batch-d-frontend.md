# Batch D — #121 empty translation unit, #126 __extension__ (branch batch-d)

Base: `54ef63dd` (verified against origin/main at start). Commits: `9b01f522`
(#121), `ce555f2b` (#126). One lane, sequential — both edit compiler.js.

## #121 — the design call: accept silently, strict reading as an opt-in flag

C11 6.9p1 makes an empty translation unit a constraint violation. The choice
was (a) accept silently vs (b) accept with a warning. Landed: **(a) by
default, plus an opt-in `-Wempty-translation-unit`** (clang's flag name;
clang itself only enables it under `-pedantic`, which we do not have).

The argument: gcc and clang both accept silently by default, and the shape
being legitimized — a whole file behind a feature `#ifdef` that is off for
this target — is *intentional, ordinary* code in configurable codebases. A
default-on warning would fire precisely on the files the fix exists to
accept (CPython's four Tier-2 JIT sources, numpy's `arm64_exports.c`) and
train users to ignore warnings. Measurement for the noise question: the
estate is green today with the ERROR in place, therefore zero currently-built
vendored TUs are empty, therefore a warning would fire zero times across
`vendor/` — the only firers would be the new files the fix admits. The
opt-in flag preserves the strict reading at ~6 lines in the existing named
`-W` flag idiom.

Mechanically, `parseTokens` now takes the TU filename via options (threaded
from `parseAllUnits`/`parseSource`) so the empty unit is attributed to its
real file — `unit.filename` has consumers that call `.startsWith` on it, so
returning a null-filename unit into the link was not an option.

A pinned xfail for this exact bug already existed
(`tests/unit/conformance/empty_translation_unit/`, `knownBug: 0322`, from the
0313 M0 probe lane). The fix made it XPASS loudly; per the xfail protocol the
tag is deleted, converting it into a permanent regression guard. A second
all-`#if 0` TU was added to the same link. (Process note: I initially
collided with that dir by creating same-named files blind — caught by the
XFAIL turning into duplicate-main, recovered by restoring the committed
files. mkdir -p on a test dir is not a check that it is new.)

## #126 — the design call: lexer keyword + parser skip, at clang's positions

Landed as the ticket argued: a real keyword (`X_EXTENSION`), skipped by the
parser — not a `#define` shim. Four skip sites, each probed against clang on
the exact shape before implementing:

- external declaration (`parseExternalDeclaration` entry);
- block-scope declaration / expression statement (consumed AFTER the
  statement-keyword dispatch in `_parseStatement`, so `__extension__ if (...)`
  stays rejected — clang rejects it too);
- cast-expression entry (covers `__extension__ (T){...}` compound literals
  and `int y = __extension__ 4`), recursing so repetition works;
- struct member declaration (CPython `object.h`'s anonymous-union shape —
  a real GCC position the ticket's three-position list did not name).

Deliberately NOT accepted: `__extension__` before a plain initializer brace
(`int a[2] = __extension__ {1,2};`) — clang errors on it, so the ticket's
"before an initializer … brace" phrasing is narrower than it reads: the only
legal brace after `__extension__` is a compound literal's, which is
expression position.

## The CPython harness: what actually moved the number, measured honestly

The /tmp/cpy-m0 harness is DEAD (macOS swept it; only `Misc/` survives). The
live harness is `vendor/cpython` (249 TUs, bin.json) — whose includes already
fix the old probe's `_elementtree.c` expat harness flag, so the ticket's
"9 → 1" row translates to "8 → 0" here.

Four cells, all measured on this tree (`compiler.js -a parse
vendor/cpython/bin.json`, failing-TU count):

| compiler | bin.json define | failing TUs |
|---|---|---|
| base 54ef63dd | — | 8 (all `__extension__` at krml fstar…h:27) |
| + keyword | — | **8** (now `Unexpected token: PUNCT '{'`) |
| base 54ef63dd | `-D__USE_SYSTEM_ENDIAN_H__` | 0 |
| + keyword | `-D__USE_SYSTEM_ENDIAN_H__` | **0** |

The construct at fstar…h:27 is `load64_be` → `be64toh` → `htobe64` →
`__extension__({ ... })` — a **statement expression**, not a compound
literal. The keyword alone moves nothing on this instrument; statement
expressions are a separate feature with real semantics, deliberately outside
this ticket (scope fence held — separate finding, reported not implemented).

The 8 → 0 movement comes from restoring `-D__USE_SYSTEM_ENDIAN_H__` to
vendor/cpython/bin.json — the define the original M0 `link.sh` always
carried and `minlink.sh` (the driver bin.json descends from) dropped. It
selects lowstar_endianness.h's glibc branch, which includes our `endian.h`
(complete static-inline surface since e9275f18, 2026-06-16), so the
statement-expression fallback macros are preprocessed away entirely. Same
fix class as the expat include: harness config, not compiler semantics.

## Gate

`node tests/run.js --diff origin/main` on ce555f2b: all 25 suites, one run,
3229 s. 6/7 dispatcher rows pass; kernel 166/167 with ONE red —
`test_netsurf_mutation_e2e.js`, the known 0386-class intermittent (mid-window
radio repaint timing in NetSurf's re-conversion window; no interaction with
front-end parsing, file untouched by this diff). Re-run solo on the same
tree: PASS in 143 s. Sweep ran FULL, 51/51, `filter: null`,
`recorded == total`. Liabilities check OK (43 entries, 5 pinned) on both the
pristine base and this tree. Finding: that intermittent has NO live funding
ticket (searched all 256 open tickets, title + body) and its design doc is
gone from todos/ — surfaced to the coordinator rather than filed, per lane
rules.
