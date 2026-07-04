// BUG: redefinition of a struct tag with a new member list in the same scope is silently accepted.
// C11: 6.7.2.3p1 -- a specific type shall have its content defined at most once (same scope, same tag).
// EXPECT: constraint violation -> compiler exits 1 with a diagnostic.
struct S { int a; };
struct S { int b; };
int main(void) { return 0; }
