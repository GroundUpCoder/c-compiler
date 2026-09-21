# 0208 — alloca inside a variadic call's argument corrupts the arg block pointer

- **Status**: done (2026-07-16) — argBlockBase now FIXED (per-store SP recompute removed) + conditional SP release (emitVaBlockRelease: restore only when SP == base - tracked deferred delta, else leak until epilogue per the alloca contract); both direct and indirect variadic sites; conformance test vararg_alloca_arg; full gate green
- **Design**: compiler.js variadic call emission (EXPR EFuncCall, direct + indirect sites), the alloca caller-frees contract (spillScalarLocals comment)

## Goal

`printf("arg %d\n", use(5))` where `use` calls alloca() prints NOTHING
(exit 0). Root cause (instrumented + code-read): after storing each
variadic argument the emitter RECOMPUTES `argBlockBase = SP +
<tracked struct-ret deferred delta>` — but a callee that used alloca()
returns with an untracked retained SP bump (the caller-frees contract:
alloca() is a wrapper returning `__builtin(alloca)`'s bump to ITS
caller), so the recomputed base is shifted down by the alloca amount and
the callee receives a garbage block pointer (format slot unwritten).

## Plan

Keep `argBlockBase` FIXED (the block never moves; per-arg store
addresses were already precomputed) and make the post-call SP release
CONDITIONAL: restore SP = base + blockSize only when SP sits exactly at
base - <tracked deferred delta> (i.e. only tracked movement happened);
otherwise LEAVE SP alone — the block + alloca region leak until the
function epilogue, which is the alloca contract's designated free point.
Apply to both the direct and indirect variadic call sites. Conformance
test `vararg_alloca_arg`.

## Acceptance

- New conformance test fails before, passes after.
- Full estate green.
