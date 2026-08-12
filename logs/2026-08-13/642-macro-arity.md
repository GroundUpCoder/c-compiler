# #642 — function-like macro arity is now checked (silent-miscompile class)

## The bug

`expand()`'s function-like branch bound parameters with
`for (p = 0; p < m.params.length && p < args.length; ++p)` and never compared
the two counts. Both directions were silent:

- **Too few**: an unbound parameter's NAME survived into the expansion and
  captured any in-scope identifier of the same name. Measured at base
  (`bbbab1ce`): `#define M(a,b,c) ((a)+(b)+(c))` with `int c = 1000` in scope,
  `M(1,2)` compiled clean and printed **1003**. `M(1)` with `b=500, c=1000`
  printed **1501** — every missing argument leaks independently. (The audit's
  1002 was the same class on a slightly different program.)
- **Too many**: extras were silently dropped — `M(1,2,3,4)` printed 6.

C11 6.10.3p4 makes the count a constraint; a diagnostic is required.

## The fix

One check in `expand()` immediately after the empty-invocation normalization,
before the parameter maps are built:

- non-variadic: `args.length !== m.params.length` → error
- variadic: `args.length < m.params.length` → error (extras are `__VA_ARGS__`)

Diagnostic follows clang's wording ("too few/many arguments provided to
function-like macro invocation of 'M' (got N, expected [at least] M)") via the
`result.errors.push(new LexError(...))` pattern the paste diagnostic
(todos/0227 G22 — the same silently-drop class) already established. One site
covers every invocation route: `applyTrailingCall` and the `#if`-expression
paths all delegate to `expand()`.

## Scope widening: too-many is diagnosed too — a decision, not an accident

The ticket is written about too-FEW arguments. The landed check also diagnoses
too-MANY, and this was approved by @master (2026-08-13) rather than trimmed to
the ticket's letter. Reasoning: it is the same root cause (the binder took
`min(params, args)` and said nothing in either direction), C11 6.10.3p4
requires the counts to *agree* — both directions are constraint violations —
and clang errors on both. Shipping the half-fix would knowingly leave a second
silent miscompile (`M(1,2,3,4)` silently dropped the extra and printed 6 at
base) in the exact code being touched — "build to the goal, not to the demo".
The blast radius is real: existing code passing extra macro args now fails to
compile; the full 25-suite diff tier is the instrument that proves the estate
carries none. Variadic macros are unaffected in this direction (extras land in
`__VA_ARGS__` by construction).

## Empty vs absent — the subtle part

An **empty argument is still an argument** (C11 6.10.3p4: arguments "may
consist of no preprocessing tokens"). The collector already got this right:
`M(1,,3)` collects THREE args (the middle one token-empty), and the
pre-existing normalization comment above the check records that `M()` on a
macro expecting parameters is ONE empty argument. So the arity check compares
*delimiter-derived counts*, and empty arguments count — `P(,+,)` is exactly
three. Nothing in the fix inspects whether an argument has tokens.

Variadic zero-trailing is legal (C23; clang/gcc accept, `__VA_OPT__` exists
for it): `L(head, ...)` invoked `L(5)` gives `args.length == params.length`,
which the `<` check accepts. `V()` on `V(fmt, ...)` is one empty arg for
`fmt` — also accepted, matching clang.

Verified-at-base non-bugs: variadic zero-trailing and empty arguments both
already worked; my early scratch "parse error on `M(1,,3)`" was the *expanded*
`()` being invalid C — correct behavior, not a collector defect.

## Tests

- `diag_pp_macro_toofew_args` (the ticket's repro shape), and
  `diag_pp_macro_toomany_args` (fixed-arity extras + zero-param extras) —
  exit-1 diag tests; clang errors on both with the same wording.
- `pp_macro_arity_empty_arg` and `pp_macro_arity_variadic_zero` — green
  guards for the two legal shapes the hazard note names; expected.stdout
  clang-verified (`-std=c23`). Note `SUM0(1,2)` → `(0 + 1, 2)` == **2**, a
  comma expression — clang caught my first wrong EXPECT comment.

Unit suite: base tree is 826 passed / 0 failed / 3 skipped (ticket's 825 was
at `b2d997aa`; `poll_highfd` landed since). With the fix + 4 new tests:
**830 / 0 / 3** — exactly baseline+4, no regressions.
