# 0328 — `inline` on a prototype/re-declaration never reached the definition

**Date**: 2026-07-28 · **Ticket**: `todos/0328` · **Branch**: `0328-inline`

## What was wrong

`DFunc.isInline` was taken from each declaration's OWN specifiers. Function
*attributes* already accumulate across re-declarations and back-propagate onto
the definition (`_mergeFnAttrs`, todos/0214) — `inline` did not travel with
them. So `static inline int big(int);` followed by a plain definition dropped
the specifier entirely, and `fnMeta.inlineHint` (`!!funcDef.isInline`) stayed
false, leaving the WAST inliner on `calleeCap` (64 nodes) instead of
`hintCalleeCap` (256).

Reproduced on `origin/main` — one 30-statement static function, three call
sites so the single-use bypass can't mask the budget decision:

| form                                                     | wasm bytes |
|----------------------------------------------------------|-----------:|
| no `inline` anywhere                                       | 8224 |
| `inline` on the definition                                 | 8776 |
| `inline` on a prototype only                               | 8224 ✗ |
| `inline` on a re-declaration after the definition          | 8224 ✗ |
| `inline` on a block-scope declaration only                 | 8224 ✗ |
| …on a block-scope declaration *before* the definition      | 8224 ✗ |

(The ticket's numbers were 8345/8749 — its repro used a `for` loop and thus a
single call site; with one site the single-use bypass fires and all four
spellings tie. Same defect, different absolute figures.)

## The one thing the ticket's plan would have broken

The ticket proposes `if (prev.isInline) funcDecl.isInline = true;`. That is
wrong, and the failure is silent.

`isInline` is read by TWO consumers with different meanings:

1. `fnMeta.inlineHint` — the inliner's size-budget bias. This is 6.7.4**p1**:
   the specifier is a property of the FUNCTION, so it should OR across
   declarations. This is the bug.
2. the linker's `addDecl` — C11 6.7.4**p7**, whether a TU provides an
   *external* definition. p7 requires **all** file-scope declarations to say
   `inline`. ORing the flag onto the definition node would make
   `inline int f(void); int f(void){...}` look like an inline definition, and
   a second external definition from another TU would then be **silently
   accepted** instead of rejected — the linker keeps the other TU's body, so
   calls in this TU bind to a different function. That is a miscompile, in a
   ticket explicitly scoped as "not a correctness bug".

Verified on `origin/main` that the duplicate is currently rejected, and pinned
both directions in the new unit test (`p7-decl-inline-still-external-definition`
/ `p7-true-inline-definition-still-links`).

So the fix uses a **separate** `DFunc.inlineHint` field: initialized from the
declaration's own `isInline`, ORed across re-declarations, and read by
`fnMeta`. `isInline` keeps meaning "this declaration's own keyword" and the
p7 decision is untouched.

## Why node-to-node threading isn't enough

The ticket's plan threads the hint from node to node (`prev` → `funcDecl` →
`.definition`), matching `_mergeFnAttrs`. That handles three of the four
directions but not this one:

```c
int main(void){ inline int big(int); return big(1); }
int big(int x) { ... }        /* defined after — clang accepts this */
```

The block-scope declaration's node is dropped from `varScope` when the block
pops, so by the time the definition is parsed there is nothing left to chase
and the hint is lost.

So `Parser._noteInlineHint(name, funcDecl, prev)` does three moves at once:
**forward** (record the name in a per-TU `fnInlineHints` set, so a definition
parsed later can ask), **sideways** (stamp this node — either it or `prev` may
be the one that keeps the scope binding), **backward** (stamp a definition
already parsed). Per-TU matches the `fnAttrs` accumulation it sits beside.

Call sites, all **above** the `continue`s that drop a redundant
re-declaration (todos/0321's static drop and the import drop) — below them the
fix silently does nothing on the common path:

- definition path (`compiler.js` ~13312, before the `prev` block)
- file-scope declaration path (~13424, *outside* the `prevFunc` guard, so a
  first declaration still records its hint)
- block-scope declaration path (~13005) — this one was also passing a
  hard-coded `false` for `isInline` to the `DFunc` constructor; now
  `specs.isInline`
- `fnMeta.inlineHint` now reads `funcDef.inlineHint`

## Blast radius — measured, not asserted

Byte-size drift over 22 vendor projects, same manifest, before vs after:

| | |
|---|---|
| byte-identical | lua, sqlite, snake, jq, doom, quake, busybox, micropython, sameboy, winmine, notepad, calc, sent, magicpoint, gameboy, punes, quickjs, pixman, cairo, mgba, disw (21) |
| moved | **netsurf +9402 B (+0.18 %)** |
| harness-limited | tinyemu, tcc, libgit2, fakegit (an ad-hoc `buildProject` probe rejects their `--allow-*` compilerArgs; all build and pass in their real pipelines) |

So the change is real but narrow: only NetSurf's headers use the decl-only
`inline` idiom on functions that straddle the 64-node cap. Total drift across
~24 MB of compiled corpus is +0.04 %.

**SameBoy framebuffer-checksum interlock**: `sum OK` at N=200/600/1000, and
`compiler.js` and `clang` agree on all three checksums. SameBoy's wasm is
byte-identical before and after (242749 B, 95231 instrs) — it does not use the
idiom, which makes it a clean control rather than a probe: it proves the
change is inert where the idiom is absent.

`micropython-upstream` reports 3 failures — `float/builtin_float_round.py`,
`float/math_domain.py`, `float/math_fun_int.py`. **Pre-existing**: the same
three fail on the stashed (pre-fix) `compiler.js`. That baseline run also
failed `basics/int_big_lshift.py`, which passes in isolation on both sides
twice over — a load flake, and it flaked on the *baseline*, not on the fix.

## Tests

- `tests/unit/conformance/inline_on_redeclaration/` — six spellings, same
  answer, clang-verified. `inline` is only a hint, so it must never move an
  observable result; this pins that and passes both before and after.
- `tests/ast/test_inline_hint_propagation.js` — the assertion that would have
  caught this. Reads `fnMeta.inlineHint` off the real `WasmModule`, by
  wrapping `WAST.runPasses` and snapshotting at ENTRY (a hinted callee that
  inlines into all its sites is deleted by the tree-shake, so its `funcDef`
  is gone by the time the bytes come back). Also asserts the hint is
  load-bearing (+3 inlined, −3 `budgetCallee`) and pins the two p7 directions.
  **Red on pre-fix `compiler.js`: 11 failures. Green after.**
