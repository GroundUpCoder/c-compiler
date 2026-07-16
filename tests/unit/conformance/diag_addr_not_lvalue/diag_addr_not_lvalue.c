// BUG: unary & on a non-lvalue crashed the compiler (raw
// "emitAddressOf: unsupported expression" throw) instead of diagnosing
// (G10, todos/0217).
// C11: 6.5.3.2p1 (constraint) — the operand of & shall be a function
// designator, a [] or unary * result, or an lvalue.
// EXPECT: compile error (exit 1).
int f(void) { return 1; }
int main(void) {
    int *p = &(f());
    int *q = &5;
    int x;
    int *r = &(x + 1);
    return 0;
}
