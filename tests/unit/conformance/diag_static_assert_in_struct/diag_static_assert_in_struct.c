// BUG: _Static_assert among struct members is ignored (a failing assertion compiles cleanly).
// C11: 6.7.2.1p1 -- a static_assert-declaration may appear in a struct-declaration-list; 6.7.10p2 -- if the constant expression is 0, a diagnostic is required.
// EXPECT: 1 == 2 is false -> compiler exits 1 with a diagnostic.
struct S { int a; _Static_assert(1 == 2, "must fire"); };
int main(void) { return 0; }
