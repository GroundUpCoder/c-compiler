# todos/0159 — the C89 unprototyped-call ABI, in promoted terms

Second half of the 0158/0159 pair (same territory — implicit/unprototyped
function resolution under `--allow-old-c` — landed as two changes because the
root causes are disjoint: 0158 was a linker-visibility hole, 0159 is a
call-ABI hole). Three flavors from the mgp/xloadimage port, all ending in
"internal compiler error: emitted invalid WebAssembly": K&R float params,
empty-parens function-pointer calls with args, and arg-count/type skew
through unprototyped decls.

## The contract

C89 6.5.2.2p6: a call through a declaration with no prototype applies the
default argument promotions (float→double, sub-int→int), and behavior is
defined when the promoted argument types match the definition's parameters
*taken in promoted terms*. So the ABI of everything unprototyped is the
PROMOTED signature — the fix makes every party agree on that:

1. **K&R definitions** (`zoom(x, n) float x; {...}`): the function TYPE's
   param slot promotes float→double, so the wasm signature is what promoted
   callers push. The parameter *variable* keeps its declared float type via
   a `_knrDeclaredTypes` side channel (`sizeof x` == 4, `&x` is `float*` —
   C89-correct, unlike ANSI-fying the def to double), and `assignLocals`
   gives such params their own local of the declared type with an
   entry-prologue `emitConversion` from the promoted signature local —
   emitted BEFORE the frame prologue so address-taken (MEMORY) params copy
   the converted value. Sub-int K&R params need nothing: char/short/int
   share the i32 wasm type.
2. **Empty-parens function-pointer calls** (`double (*p)(); p(1.5, 2)`):
   the call_indirect is now typed off the promoted ARGUMENT types instead of
   the pointer's empty param list (which validated as a 0-arg call under a
   stack imbalance, or trapped with a spurious signature mismatch). A
   matching callee — prototyped in promoted types, or K&R per (1) — agrees
   exactly; a non-matching callee is UB and gets the call_indirect trap, not
   an invalid module.
3. **Direct calls through unprototyped decls** (`int f(); f(x)` with a
   prototyped definition elsewhere): per-arg, when the promoted arg's wasm
   type differs from the definition's param slot, `emitConversion` reconciles
   (f64 demotes back to a f32 param — value-correct, the arg was float before
   promotion; i32/i64 widen/wrap). Arg-COUNT skew is a real diagnostic now
   ("call to unprototyped function 'f2' with 1 argument(s), but the
   definition takes 2") via the codegen `gotoErrors` channel — push error,
   emit `unreachable`, fatalExit before validation. C89 makes the mismatch
   UB; an invalid module was never the right outcome, and wasm's typed call
   ABI can't express it.
4. **The AST inliner** (`tryInline`) had the same hole one level up: it
   substitutes call args into param slots verbatim, which spliced a promoted
   f64 expr into a body typed f32 (`f32.div[0] expected type f32, found
   f64.promote_f32`). It now wraps the arg in an `EImplicitCast` back to the
   param's declared type when the scalar types differ.

## Deviations worth recording

- **We are more permissive than clang -std=c89 on `int f(); int f(float v)
  {...}`**: clang rejects the prototype as incompatible with the
  unprototyped decl (float doesn't survive default promotion — 6.7.5.3p15);
  our `_eqStructure` keeps its either-side-unspecified-is-compatible rule
  and the demote-back in (3) makes the call value-correct. Tightening
  compatibility to promotion-surviving params would be standard-truer but
  is exactly the kind of rejection `--allow-old-c` exists to avoid; noted,
  not changed.
- A K&R float def now has type `(double, ...)`, so a coexisting *float*
  prototype for it becomes a "conflicting types" error — that's the
  standard's position (a float-param prototype never matches a K&R def).

## Tests / gate

`cg_knr_float_promotion_cross_tu` (two-TU, the exact todo shape,
clang-verified "3"), `cg_unprototyped_fnptr_call` (clang-verified "3.5"),
`diag_unprototyped_argcount` (`expected.compiler.exitcode` 1). Edge probes:
address-taken K&R float param + sizeof (matches clang), K&R char/short
unchanged, 0158's repro still 42. Gate: unit 715/0 (+3 skip), blockfs 15/0,
kernel 73/0 — with the system image re-baked by the fixed compiler, i.e. the
whole vendor corpus (busybox, doom, quake, sqlite, mgp, ...) recompiled
clean under the new promotion rules.

## Residue

The vendored mgp workarounds (explicit externs / ANSI-fied defs, see
`vendor/magicpoint/README.md`) still stand — they're upstream-fork patches,
correct either way; un-patching them is possible dogfood but not done here.
