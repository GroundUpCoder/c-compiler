// BUG: a call through an unprototyped decl whose argument count disagrees with the definition emitted invalid wasm (stack imbalance) instead of a diagnostic
// C11: C89 6.5.2.2p6 — if the number of arguments does not agree with the number of parameters, the behavior is undefined; a diagnostic is required here because the wasm call ABI cannot express the mismatch
// EXPECT: compiler exits non-zero with an arg-count diagnostic; never an invalid module
int f2();
int main(void) { return f2(1); }
int f2(int a, int b) { return a + b; }
