// BUG: ticket #127 — the under-arity side of the same defect must say
// "too few", sized by the definition's parameter list.
static int f();
static int f(int x, int y);
static int f(int x, int y) { return x + y; }
int main(void) { return f(1); }
