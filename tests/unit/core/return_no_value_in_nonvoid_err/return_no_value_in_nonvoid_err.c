// `return;` (no value) in a non-void function is a constraint
// violation (C99 §6.8.6.4).
int foo(void) { return; }
int main(void) { return 0; }
