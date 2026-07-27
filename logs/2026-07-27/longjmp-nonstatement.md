# longjmp in arbitrary expression position — supported, not diagnosed (todos/0312)

**2026-07-27.** P0. `n ? longjmp(b,1) : longjmp(b,2)` killed the compiler with an
uncaught JS exception — `emitExpr: function 'longjmp' not found` at compiler.js:19509,
a raw Node stack trace with no file, no line, no source context. Same for a
for-increment and a return expression. The input is valid C11: unlike `setjmp`, whose
7.13.1.1p4 enumerates the contexts it may appear in, the standard puts **no** context
restriction on `longjmp`. It is an ordinary void call.

## Why it crashed

`lowerSetjmpLongjmp` strips `setjmp`/`longjmp` from `unit.importedFunctions` — they
are lowered, never imported — and then `lowerLongjmpInStmt` rewrites the calls. But
that walker only ever matched **statement position** (`AST.SExpr` and the compound
shapes containing one). That is not an oversight so much as a structural limit: what
the lowering produces is `__throw __LongJump(buf[0], val)`, an `AST.SThrow`, and a
statement can only replace a statement. A `longjmp` in a ternary arm has no statement
slot to be replaced with, so it survived the pass as a live `ECall` to a function that
had just been deleted from the import list. Codegen then looked it up and found
nothing.

The crash message is the tell: it names `longjmp`, a function the lowering had itself
removed. There was already a precedent for this exact failure mode one function down —
`findResidualSetjmp` exists precisely because a `setjmp` surviving the pattern matcher
would die the same way, and it converts that into a real `file:line: error:`. The
longjmp side simply never got its counterpart.

## The choice: diagnose or support

The ticket offered both, and the cheap one — mirror `findResidualSetjmp`, emit a
diagnostic — was explicitly *not* where to stop. A diagnostic on this input would
label a gap, not close it. `longjmp` is a normal call; the ONLY reason it is
special-cased at all is that the lowering wants to see it. Rejecting conforming code
because our own lowering is shaped inconveniently is the wrong answer.

So: support it.

## The mechanism — give the throw a statement home of its own

The general structural fix (hoist the enclosing expression, sequence the operands,
splice statements around it) is the obvious approach and the wrong one: it needs a
case per expression context, and every case is a chance to get evaluation order
wrong.

The actual fix sidesteps all of it. **`longjmp` never returns.** So the throw does not
have to happen *in* the expression — it only has to happen *at* that point in the
evaluation order. A function call satisfies that exactly. New in `__setjmp.c`:

```c
__exception __LongJump(int, int);
void __setjmp_throw(int id, int val) { __throw __LongJump(id, val); }
```

and a residual `longjmp(buf, val)` in any expression slot becomes
`__setjmp_throw(buf[0], val)`. The exception unwinds out of that frame into the
enclosing setjmp's `catch` — the try/catch the setjmp lowering already built — with no
special handling, because that is what wasm EH does across a call. The extra frame is
unobservable: nothing can run in it and nothing returns from it.

What this buys: **no structural analysis of the enclosing expression at all.** The
rewrite is a leaf substitution, so it composes with arbitrary nesting for free, and
evaluation order is preserved by construction (the call sits exactly where the call
sat). Ternary arms, for-increments, comma operands and declarator initializers are all
the same one-line case.

`__setjmp.c` declares the tag itself rather than including `<setjmp.h>` — that keeps
the TU free of a setjmp/longjmp import of its own (which would make
`lowerSetjmpLongjmp` try to lower the very function it is defining). Cross-TU tag
unification is by name, and `tests/unit/exception/cross_tu` already covers throw-here /
catch-there.

Two new pieces in compiler.js: `rewriteLongjmpExpr`, an `AST.walkExpr` visitor, and
`rewriteLongjmpInStmt`, which feeds it every expression slot of a statement tree. The
statement walker **enumerates shapes** rather than driving off the generic `children`
array, for two specific reasons worth not rediscovering: `SFor`'s children array is
variadic (3/4/5 slots depending on which clauses are present) and its `_withChildren`
deliberately throws, and `SDecl`'s children *mirror* initializers that actually live
on the `DVar`s — the DVars are sealed, not frozen, so those are rewritten in place.

## Cost, measured

Statement position is untouched — it still lowers to the inline throw. A
`--gc-sections` build of a setjmp program is **byte-identical** to pre-fix output
(checked against main on `sj_longjmp_comma`). Without `--gc-sections` the binary grows
by **5 bytes**: the now-unreferenced `__setjmp_throw`.

That 5 bytes was a deliberate call. The alternative is pushing `__setjmp.c`'s
definition into a separate source and `__require_source`-ing it only when a residual
is actually found — zero cost, but it makes correctness depend on the caller draining
`unit.requiredSources` *after* the lowering runs (today the driver drains them
*before*, at compiler.js:31487, so it would also need a reorder). `lowerSetjmpLongjmp`
is exported and callable standalone. One always-correct code path beat a conditional
one guarded by an ordering constraint nothing enforces.

## Not absorbed: todos/0311

Same code region, separate funded ticket. `switch (setjmp(b))` still reports
`unsupported use of setjmp` — verified after the fix, not assumed. This change never
reaches the setjmp residual path.

## Gate

todos 4/4 · unit 778 pass / 0 fail / 3 skip (781) · host 10/10 files, 160 assertions ·
blockfs 15/15 · kernel 118 files, 0 failed (92 + 26 resumed — the suite exceeds the
600s call ceiling; `--resume` off the checkpointed `summary.json` is the way through).

Pinned by four clang-verified conformance dirs: `sj_longjmp_ternary`,
`sj_longjmp_for_increment`, `sj_longjmp_return_expr`, `sj_longjmp_declarator_init`.
The fourth is not one of the three shapes the ticket named — it covers the
declarator-initializer slot, which is its own branch of the new walker and would
otherwise have been untested code.
