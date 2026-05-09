// `return EXPR;` in a void function is a constraint violation
// (C99 §6.8.6.4).
void foo(void) { return 5; }
int main(void) { return 0; }
