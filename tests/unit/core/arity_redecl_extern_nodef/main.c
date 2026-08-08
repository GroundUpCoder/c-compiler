// BUG: ticket #127 — an over-arity call through `extern int f();` followed by a
// prototyped re-declaration must use the ordinary arity wording, not blame an
// "unprototyped function". Table row 1: extern/extern, no definition (sema path).
extern int f();
extern int f(int x);
int main(void) { return f(1, 2, 3); }
