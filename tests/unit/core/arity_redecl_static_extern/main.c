// BUG: ticket #127 — table row 4: static unprototyped decl + extern prototyped
// re-declaration (dropped, inherits internal linkage per C11 6.2.2p4) + a
// definition. Same precise wording required.
static int f();
extern int f(int x);
static int f(int x) { return x; }
int main(void) { return f(1, 2, 3); }
