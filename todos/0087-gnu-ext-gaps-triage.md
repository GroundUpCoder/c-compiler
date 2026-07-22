# 0087 — Compiler triage: GNU-extension gaps surfaced by the SameBoy port

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: this file. Follow-up of `0075`; back of the queue. Each gap
  below was worked around with a documented vendored patch (see
  `vendor/sameboy/README.md`), so nothing is urgent — this item is the
  triage list so the findings don't evaporate. Promote individual lines to
  their own items when a second port hits them (the 0085 multi-char
  constants fix followed exactly that path and is already done).

## The gaps, roughly by expected payoff

1. **`offsetof` as an integer constant expression.** — ✅ **FIXED** (verified
   2026-07-22, cont-20/cont-22). No longer repros: `unsigned char
   buf[offsetof(T,c) - offsetof(T,b)]` compiles and const-folds (the bound is
   accepted as an ICE, NOT rejected as a VLA), and a false negative-size bound
   is still correctly rejected — proving real const-folding, not a silently
   ignored bound. Housekeeping-lag class (fix landed under another item; only
   the triage note was stale). Locked by conformance test
   `tests/unit/core/offsetof_array_bound` (offsetof-difference array bound
   folds to the expected size). Original bug: `((size_t)&((T*)0)->m)` didn't
   const-fold, so `uint8_t buf[offsetof(...) - offsetof(...)]` was rejected as
   a VLA (SameBoy gb.c rtc snapshot).
2. **GNU statement expressions `({ … })`.** Blocks MIN/MAX-style macros all
   over real-world code (SameBoy defs.h, Linux-adjacent headers).
   Medium-size parser+codegen feature; the payoff is fewer vendored macro
   patches per port.
3. **Elvis operator `x ?: y`.** Small parser feature (conditional with
   omitted middle operand, first operand evaluated once). 5 sites in
   SameBoy alone.
4. **Preprocessor directives inside macro arguments.** UB per C11 6.10.3p11
   but gcc/clang process them; SameBoy wraps `#ifndef`-gated struct members
   in a macro invocation (`GB_SECTION(unsaved, …)`). Needs the PP to run
   directives encountered during argument collection.
5. **`__attribute__((constructor))`.** Currently a hard parse error; even
   just lowering it to a pre-main init list for the single-module case
   would drop the lazy-init patch pattern (SameBoy apu.c/random.c).
6. **`vasprintf`/`asprintf` in libc.** Trivial over the existing vsnprintf.
7. **`__builtin_bswap16/32/64` as real builtins.** The shim is 12 lines of
   static inline; a builtin would just avoid per-port copies.

## Acceptance

- Not a landing item in itself: close by promoting-or-rejecting each line
  (own todo or "wait for a second consumer" note) once triaged.
