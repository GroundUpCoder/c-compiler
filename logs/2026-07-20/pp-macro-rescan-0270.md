# 0270 — PP: function-like macro name from inner expansion not re-scanned

**Branch:** `fix-0270-pp-rescan` · **Status:** built + gates green in worktree,
awaiting coordinator review/merge (compiler.js is codegen-sensitive — master
reviews the diff + sequences before T2 ETL).

## The bug (P0, surfaced by the jq vendor)

C11 6.10.3.4: the fully-expanded replacement list is rescanned for further macro
names, *including function-like invocations formed only during that expansion*.
compiler.js missed exactly one case: a **function-like** macro name produced by
an inner expansion, whose `( … )` argument list is glued on in the **same**
replacement list.

The jq count-dispatch idiom (`JV_ARRAY`/`JV_OBJECT`/`BLOCK` in `vendor/jq/src`)
is the canonical shape:

```c
#define SUM_IDX(_1,_2,_3,NAME,...) NAME
#define SUM(...) SUM_IDX(__VA_ARGS__, SUM_3, SUM_2, SUM_1, dummy)(__VA_ARGS__)
```

`SUM(10)` → the selector `SUM_IDX(…)` expands to the bare token `SUM_1`, and the
trailing `(10)` sits in the outer stream. clang re-invokes `SUM_1(10)`;
compiler.js emitted the literal `SUM_1 ( 10 )` and the program failed to compile
("Undeclared identifier 'SUM_1'"). jq worked around it with a one-arg
`JV_PP_EXPAND(x) x` wrap to force a second rescan pass.

Minimal repro (compiler.js pre-fix vs clang `-E`):

```
#define SEL_1(a) f1(a)
#define SEL_2(a,b) f2(a,b)
#define IDX(_1,_2,NAME,...) NAME
#define SEL(...) IDX(__VA_ARGS__, SEL_2, SEL_1, dummy)(__VA_ARGS__)
SEL(x)     // pre-fix: SEL_1 ( x )   clang: f1(x)
SEL(x,y)   // pre-fix: SEL_2 ( x , y )   clang: f2(x,y)
```

## Root cause

`expand()` already had a trailing-rescan loop for the **object-like** branch
(`#define h g` where `g` is function-like and `h(2,3)` appears in another
macro's replacement list): after `expand(relocated, …)`, if the result *ends* in
a function-like macro name and the following tokens supply `(…)`, it pulls them
in and re-expands. The **function-like** branch (the `IDX(...)` → `SEL_1` case)
had **no** equivalent — the recursive `expand(substituted, …)` runs in
isolation and never sees the `(args)` that follow in the current stream.

## Fix (right generality, not jq-specific)

Factored the object-like branch's inline while-loop into a shared helper
`applyTrailingCall(replacement, hideset, i)` inside `expand()` and applied it to
**both** branches. It mutates the expansion in place and returns the advanced
input index; the existing blue-paint guards (`last.noExpand`,
`hideset.has(last.text)`) prevent self-referential loops — `R(x)→R(x)` still
terminates. This is general C11 rescan semantics, not a special-case for the jq
idiom.

## Verification

- **Minimal repro + jq's real macros** (9-arg `JV_ARRAY_IDX`, 8-arg
  `BLOCK_IDX`, **no** `JV_PP_EXPAND` wrap): compiler.js output now byte-for-byte
  matches `clang -E` — so **jq's `JV_PP_EXPAND`/`BLOCK_PP_EXPAND` workaround is
  now redundant** (removing it is optional cleanup for a later jq re-bake).
- **Conformance:** new `tests/unit/conformance/pp_variadic_argcount_rescan/`
  (runnable program, clang-verified `11 32 63`). Fails pre-fix
  (Undeclared identifier 'SUM_1/2/3'), passes post-fix.
- **compiler.js-touch mandate — SameBoy byte-identity:** SameBoy build sha256
  identical pre/post fix (`3c8e7b3d…`) — SameBoy doesn't use the idiom, so
  codegen is untouched, as required.
- **Gates:** unit 769/0/3, host + blockfs green, kernel green (compiler.js →
  unit/host/blockfs/kernel per the run.js RULES).

## Sequencing

Lands before the C++ ladder T2 (ETL) rung — heavy variadic-template + macro TMP
(T2 ETL, T6 fmt/exprtk/CTRE) hit the same rescan limit.
