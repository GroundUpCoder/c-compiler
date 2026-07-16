// BUG: assigning to a non-lvalue (constant, function call result, cast,
// enum constant, whole array) crashed the compiler with a raw
// "emitLValue: unsupported expression" throw instead of diagnosing
// (G10, todos/0217).
// C11: 6.5.16p2 (constraint) — assignment requires a modifiable lvalue.
// EXPECT: compile error (exit 1).
int f(void) { return 1; }
enum E { RED };
int b[3];
int main(void) {
    int x;
    int a[3];
    5 = 3;
    f() = 3;
    (int)x = 5;
    RED = 5;
    a = b;
    return 0;
}
