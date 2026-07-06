# The aligned(N) attribute crash — smaller cause, bigger blast radius

Context: the top `compiler.js` entry in `todos/CONFORMANCE-REMAINING.md` —
"`__attribute__((aligned(N)))` after an array declarator crashes the compiler"
(found 2026-07-06 porting busybox, todos/0005).

## Root cause: a one-character-class typo, not a parser gap

`parseSingleAttribute`'s `aligned` handler called `this._constEvalInt(alignExpr)`.
That method **does not exist anywhere** — the intended helper is the free
function `constEvalInt` (compiler.js ~5063, the integer view over
`constEvalItem`). The parser catches the `TypeError` as a parse error, which is
why it surfaced as `null:0: error: this._constEvalInt is not a function`
instead of a stack trace.

Consequence the remaining-list entry got wrong: it crashed in **every**
declarator position with **any** argument — before-declarator, scalars,
everything. "After an array declarator" was just where busybox's `ALIGN1`
happened to sit; since the port then defined all `ALIGN*` empty under
`__wasm__`, no other `aligned(N)` was ever exercised to disprove it. Lesson
for remaining-list entries: record the *minimal repro tried*, not the context
it was found in, or the entry over-narrows the bug.

## What "fixed" had to mean

Calling the right helper made statics work immediately (`allocateStatic`
honors any power-of-2). But it exposed two latent holes that would have been
silent miscompiles/footguns:

1. **Locals requesting > 16**: frame slots got the requested *offset*
   alignment, but the frame base is only 16-aligned (frameSize rounds to 16,
   SP is inductively 16-aligned) — so `int x __attribute__((aligned(64)))`
   parsed fine and was silently misaligned. Fixed in codegen: the frame
   layout tracks the max requested alignment; when it exceeds 16 the
   prologue masks the base down (`(savedSp - frameSize) & -maxAlign`) into
   a dedicated frame-base local, and `emitFrameAddr` switches to base+offset
   addressing. Zero cost for normal frames (the masked path only exists when
   requested). Epilogue/return/longjmp all restore `savedSp`, so no
   unwinding changes; alloca subtracts from the already-masked SP, so it
   composes. All frame addressing was verified to funnel through
   `emitFrameAddr` before touching it.
2. **No argument validation**: the attribute accepted any N. Once the
   prologue masks with `-N`, a non-power-of-2 is a *correctness* bug, not a
   style issue — now diagnosed like gcc/clang ("not a positive power of 2"),
   capped at 2^28. Note `_Alignas` keeps its stricter documented policy
   (error > 8, C11 6.2.8 implementation-defined); the GCC attribute is an
   extension and follows GCC semantics instead. That asymmetry is
   intentional — `_Alignas(64)` erroring while `aligned(64)` works mirrors
   what the standard requires vs what the extension promises.

## Tests + fallout

- `tests/unit/conformance/parse_attr_aligned_arg` (committed failing first,
  per convention): all three positions, const-expr arg (`1 << 4`), static +
  local observable alignment; clang-verified golden.
- `tests/unit/conformance/diag_attr_aligned_pow2`: `aligned(24)` must be a
  compile error (clang agrees).
- Manual stress (recursion + `__builtin(alloca,…)` + memory struct params +
  string-init-to-frame-slot in one over-aligned frame) matches native clang.
- **busybox workaround reverted**: `platform.h`'s "`ALIGN*` emptied under
  `__wasm__`" patch is gone — upstream `ALIGN1/2/4/8/INT/PTR` (including the
  `aligned(sizeof(int))` forms) now compile as-is. Kernel suite (which
  rebuilds busybox at seed time) passes 10/10; `os/image.json` bumped to
  version 6 so existing images re-seed with the new build.

Suites: unit 697/697, kernel 10/10 (incl. headless hush OS boot).
