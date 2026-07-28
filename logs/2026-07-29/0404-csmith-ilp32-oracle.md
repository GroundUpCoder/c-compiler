# 0404: the "1500x runaway" was an unsound fuzz oracle, not a miscompile

The live fuzz tier flagged seed 450020699 with `run timeout` (todos/0404):
native 0.48 s with checksum `65817AB`, our wasm killed after 12 minutes. The
kickoff assumption was a hang-class codegen bug. The reduction disproved it.

## How the trace narrowed it

Function-entry markers put the hang past `func_23`; probe counters showed the
native run does ~100 loop iterations total (so wasm was not "slow", it was
looping); a V8 tick profile (`--prof` + a `-g` build for the name section)
put the hot frames at `func_18`'s `lbl_235: ... if (g_122) goto lbl_235;`
loop, whose body never writes `g_122`. The divergence that gets there:
`func_18((~g_4) >= 0xD7D41305L)` receives 0 natively and 1 in wasm.

Both are correct. Host clang is LP64: `0xD7D41305L` is a signed 64-bit
`long`, and `-1 >= 3620999941` is false. wasm32 is ILP32: the literal does
not fit a 32-bit `long`, becomes `unsigned long` (C11 6.4.4.1p5), and the
compare goes unsigned — true. `clang -target i686-pc-linux-gnu` folds it
exactly as our compiler does. With 1, the program reaches the `goto` loop
with `g_122 == -3` and legitimately never terminates: csmith bounds its
`for` loops, but a value-dependent `goto` loop only terminates under the
width model csmith's recorded execution used.

**Closure proof:** rewriting all 273 `L`/`UL` suffixes in the seed to
`LL`/`ULL` (semantic no-op on LP64) makes our wasm build print `65817AB` in
~0.1 s. One literal-typing axis explains the entire 12-minute hang.

## The fix (harness, not compiler)

- `normalize_long_literals` in tests/run.py: both fuzz tiers now compile a
  width-normalized copy on both sides. No-op for the LP64 oracle, so tier-1's
  recorded checksums stay valid; the wasm side sees the oracle's literal
  types. Suffixes are the whole class for this generator config: the only
  bare `long` csmith emits is the unused `__undefined` sink, and the corpus
  has no `sizeof`.
- `tests/unit/conformance/ilp32_long_literal_typing`: pins ILP32 literal
  typing (sizeof ladder + the seed's exact comparison). Born green — the
  class is untestable against an LP64 oracle by construction, so the guard
  is verified against clang i686 constant folding instead.
- The seed joins the corpus as `c450020699.c` (raw source; normalization is
  applied at test time), making the 0404 acceptance a standing test.

Gotcha for future reducers: a csmith "miscompile" whose repro involves an
L-suffixed literal in `(INT32_MAX, UINT32_MAX]` or arithmetic through a
`UL` literal is suspect — check the width model before blaming codegen.
`vendor/csmith-corpus/README.md` now documents the soundness rule.
