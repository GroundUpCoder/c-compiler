// BUG: a declaration between `switch (...) {` and the first case label
// lost its storage — codegen crashed with "emitLValue: variable not
// found" when a case body used it. busybox awk.c's parse_expr does
// exactly this (`switch (tc) { var *v; case TC_VARIABLE: ... v = ...`).
// Found porting the spawn-capable applets (todos/0035).
// C11: 6.8.4.2 — the switch body is a compound statement like any other;
// a declaration before the first case label is never "executed" (its
// initializer, if any, is skipped) but IS in scope for the whole body.
// EXPECT: matches clang: v is usable in every case; the skipped
// initializer leaves it indeterminate, so cases assign before use.
#include <stdio.h>

static int pick(int x) {
    switch (x) {
        int v;          /* declaration before the first case: legal C */
    case 1:
        v = 10;
        return v;
    case 2:
        v = 20;
        v += x;
        return v;
    default:
        v = -1;
        return v;
    }
}

int main(void) {
    printf("%d %d %d\n", pick(1), pick(2), pick(9));
    return 0;
}
