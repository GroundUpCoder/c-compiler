// BUG: ++/-- on a non-lvalue crashed the compiler with a raw
// "emitLValue: unsupported expression" throw instead of diagnosing
// (G10, todos/0217).
// C11: 6.5.3.1p1 / 6.5.2.4p1 (constraints) — the operand of ++/--
// shall be a modifiable lvalue.
// EXPECT: compile error (exit 1).
int f(void) { return 1; }
int main(void) {
    ++1;
    --f();
    f()++;
    return 0;
}
