// BUG: a source file ending inside an unterminated #if group is accepted
//      silently (compiler exits 0).
// C11: 6.10.1 (if-section grammar requires a matching #endif) — a violation
//      of the syntax rule requires a diagnostic (5.1.1.3).
// EXPECT: the compiler must diagnose the unmatched #if and exit nonzero.
int main(void) { return 0; }
#if 1
