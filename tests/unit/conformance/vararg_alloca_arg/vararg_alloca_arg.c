// BUG: a variadic call with an alloca()-using callee in its argument list
// lost its output entirely — after each arg store the emitter recomputed
// the arg-block base from live SP (+ the tracked struct-return deferral
// delta), but an alloca-retaining callee returns with an UNTRACKED SP
// bump (the caller-frees contract), so the callee got a garbage block
// pointer. Found in the 2026-07 fresh-eyes hunt (todos/0208).
// C11: n/a (alloca is a POSIX/GNU extension); clang/gcc print all lines.
// EXPECT: every line prints; direct alloca in an arg stays live across
// the call.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <alloca.h>

int use(int n) {
    char *p = alloca(16);
    memset(p, 0, 16);
    p[0] = (char)n;
    return p[0];
}

int sum3(int a, int b, int c) { return a + b + c; }

int main(void) {
    printf("arg %d\n", use(5));
    int t = use(7);
    printf("hoisted %d\n", t);
    printf("two %d %d\n", use(1), use(2));
    printf("mixed %d %d\n", sum3(use(1), use(2), use(3)), use(4));
    char *d = memcpy(alloca(6), "gucOS", 6);
    printf("direct %s %d\n", d, use(9));
    printf("after %s\n", d);
    return 0;
}
