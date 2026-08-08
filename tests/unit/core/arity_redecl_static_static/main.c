// BUG: ticket #127 — table row 3: static unprototyped decl + static prototyped
// re-declaration (dropped from scope by the todos/0321 6.2.2p4 rule) + a
// definition. The call binds the first decl, but the chain carries a prototype,
// so the message must be the precise arity wording, not "unprototyped".
static int f();
static int f(int x);
static int f(int x) { return x; }
int main(void) { return f(1, 2, 3); }
