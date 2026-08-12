// BUG: `int g = 1 << 32;` at file scope FOLDED, to 0, under
// constEvalExpr's hardcoded 64-bit shift-count bound (#645) — a
// defined-looking value that the runtime shift (count masked, wasm
// semantics) contradicts. The fold now declines counts >= the promoted
// left operand's width, so a static initializer built on one is
// diagnosed instead of silently miscompiled — the same behavior a
// count >= 64 always had.
// C11: 6.5.7p3 — shift counts >= the width of the promoted left operand
// are undefined; 6.6p4 — a static initializer must be a constant
// expression the implementation can evaluate.
// EXPECT: compile error (exit 1).
int g = 1 << 32;
int main(void) { return g; }
