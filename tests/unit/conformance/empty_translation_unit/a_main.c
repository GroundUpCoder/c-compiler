// BUG: a .c file whose entire contents are preprocessed away is rejected with
//      `null:0: error: No tokens to parse`, so the whole build fails.
// C11: 6.9p1 does require a translation unit to contain at least one external
//      declaration, so this is a constraint violation on paper — but clang and
//      gcc both emit a valid empty object, and a port cannot use an upstream
//      source list without it.
// EXPECT: ok
// KNOWN-BUG: todos/0322 (pinned xfail via config.json "knownBug"). Found by the
//      todos/0313 CPython probe: CPython 3.13.5 has four such files in its core
//      build (Python/jit.c, optimizer.c, optimizer_analysis.c,
//      optimizer_symbols.c — Tier-2 JIT, compiled unconditionally by the
//      Makefile and empty unless _Py_TIER2 is set). Verified with a positive
//      control that clang emits 0 defined symbols for each of them.
#include <stdio.h>
int main(void) { printf("ok\n"); return 0; }
