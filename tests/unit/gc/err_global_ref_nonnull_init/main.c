// File-scope ref-typed globals can only be init to null/0:
// WASM constant init expressions can't perform allocation.
__eqref g_eq = 42;
int main(void) { return 0; }
