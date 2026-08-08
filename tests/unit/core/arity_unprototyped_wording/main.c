// BUG: ticket #127 negative control — when NO declaration in the chain carries
// a prototype (the definition's empty parens are not one), the "unprototyped"
// wording is honest and must be kept.
static int f();
static int f() { return 0; }
int main(void) { return f(1, 2, 3); }
