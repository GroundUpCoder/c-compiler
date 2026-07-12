# 0159 — compiler: unprototyped calls / K&R float params / empty-parens fn-pointer calls emit invalid wasm (default-promotion ABI)

- **Status**: open (filed from the 0119 MagicPoint port; queued after 0160/0161 per user)
- **Priority**: P1 (was P0 — internal compiler error on accepted input; deprioritized behind 0160/0161 since the mgp port works around it, so nothing ships broken; restore to P0 if the edge case resurfaces in live code)

## Symptom

Three flavors of the same hole, all found compiling mgp's xloadimage code
with `--allow-old-c`, all ending in "internal compiler error: emitted
invalid WebAssembly" (validation failure) instead of either correct code or
a diagnostic:

1. **K&R float param**: `Image *zoom(oimage, xzoom, yzoom, verbose) float
   xzoom, yzoom; {...}` called through the unprototyped `Image *zoom();`
   decl with float/int args → `call[1] expected type f32, found
   f64.promote_f32` (or `expected f64, found i32.load` with int args).
   C89 6.7.1: parameters in K&R definitions get the default argument
   promotions — a `float` param IS a `double`; calls through empty-parens
   decls promote args. The codegen keeps the callee param as f32 while
   call sites push promoted f64 (or vice versa).
2. **Empty-parens function POINTER call with args**: `Image *(*loader)();
   ... loader(fullname, name, verbose)` → `expected 0 elements on the
   stack for fallthru, found 3`. The call_indirect is typed off the
   0-arg pointer type while args were pushed.
3. Same class for plain unprototyped externs when arg counts/types differ
   from the definition.

Workarounds in vendor/magicpoint (see its README): ANSI-fied the defs with
`double`, real prototypes in `image.h` and in `imagetypes.c`'s table.

## Fix expectation

Implement the C89 unprototyped-call ABI (default argument promotions on
both the call and the K&R-definition side), or at minimum detect the
mismatch at link/codegen time and emit a diagnostic. Never an invalid
module. quake/doom-era code is full of this pattern — worth a conformance
test trio (K&R float def + unprototyped call; fn-pointer table; arg-count
mismatch diagnostics).
