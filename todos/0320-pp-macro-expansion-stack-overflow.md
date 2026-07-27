# 0320 — Preprocessor blows the JS stack on a macro expanding to ~70k+ tokens

- **Status**: open
- **Priority**: P0 (compiler crash — valid input, no diagnostic)
- **Difficulty**: light
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe. `Python/pylifecycle.c`
  and `Python/pystate.c` both die on it (`_PyRuntimeState_INIT` is an enormous
  nested initializer macro).

## The bug

A single macro whose expansion exceeds roughly 70,000 tokens crashes the
compiler with an unhandled JS exception and no source location:

```
compiler.js:1836
            expanded.push(...expandedResult);
                     ^
RangeError: Maximum call stack size exceeded
    at expand (compiler.js:1836:22)
    at processTokens (compiler.js:2473:38)
    at preprocess (compiler.js:2498:3)
```

This is **not** recursion depth — a 800-deep nested macro chain is fine. It is
`Array.prototype.push(...bigArray)`: the spread passes every element as a
separate argument, and V8's argument limit (~65k–125k) is exceeded.

Measured threshold, one object-like macro expanding to N tokens:

| N       | result |
|---------|--------|
| 30,000  | OK |
| 70,000  | `RangeError: Maximum call stack size exceeded` |
| 130,000 | `RangeError: Maximum call stack size exceeded` |

Repro generator:

```sh
python3 -c "N=130000; open('wide.c','w').write('#define BIG ' + ' '.join(['1,']*N) + '0\nint a[] = { BIG };\nint main(void){return 0;}\n')"
node compiler.js -a lex wide.c
```

## Root cause

Spread-into-`push` at eight sites in the preprocessor:

`compiler.js:1591`, `:1657`, `:1658`, `:1695`, `:1716`, `:1754`, `:1836`, `:2113`

Each is `target.push(...arr)` where `arr` can be an arbitrarily long token list.

## Plan

Replace the spread with a loop (or `for (const t of arr) target.push(t)`) at all
eight sites. Verified during the probe: patching exactly those eight makes both
the synthetic 130k-token repro and CPython's `Python/pylifecycle.c` compile.

Worth a sweep for the same shape elsewhere — `grep -c "push(\.\.\." compiler.js`
reports 12 sites in total; the other 4 are outside the preprocessor and should
be checked for unbounded inputs too.

## Regression guard — do NOT use a corpus fixture

I tried to land this as a pinned-xfail conformance test and **pulled it back
out**: the threshold is a V8 stack/argument limit, not a language property, so
it moves with the execution context. The same 131,072-token fixture that crashes
`node compiler.js` from a shell **XPASSed** under `tests/run-unit.js`, which
compiles in-process inside a `worker_threads` worker (larger default stack).
Chasing that with a bigger token count just buys a fixture that will flip again
on the next Node bump — exactly the latent-flake shape the repo's test-sync
discipline rejects.

Guard it with a **direct unit test of the expander** (assert a large token list
survives the expansion path), or simply assert that no `push(...)` spread remains
at the eight sites. Not a fixture tuned to a limit.

## Acceptance

- The 130k-token repro compiles when run from a shell (main thread).
- `Python/pylifecycle.c` from CPython 3.13.5 gets through `-a parse`
  (the M0 probe's build recipe is in `todos/0313`'s report).
- A regression guard exists in the form described above (NOT a threshold-tuned
  corpus fixture).
