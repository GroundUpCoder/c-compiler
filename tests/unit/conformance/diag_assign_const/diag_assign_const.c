// BUG: assignment (and ++/--/compound assignment) to a const-qualified
// lvalue was silently accepted and compiled as a plain write — including
// through pointer-to-const, to a const member, to a member of a const
// struct (C11 6.5.2.3p3 qualifier propagation), and whole-struct
// assignment onto a struct with a const member. Deferred from 0217/G10,
// closed as bug-hunt G22 (todos/0227).
// C11: 6.5.16p2 / 6.5.3.1p1 / 6.5.2.4p1 (constraints) — the target shall
// be a MODIFIABLE lvalue; 6.3.2.1p1 excludes const-qualified types and
// aggregates with const members.
// EXPECT: compile error (exit 1).
struct S { const int m; int n; };
struct P { int x; };

int main(void) {
    const int c = 3;
    c = 4;                     /* plain assignment */
    c += 1;                    /* compound assignment */
    c++;                       /* increment */
    --c;                       /* decrement */
    const int *p = &c;
    *p = 5;                    /* through pointer-to-const */
    struct S s = {1, 2};
    struct S t = {3, 4};
    s = t;                     /* struct with const member */
    s.m = 7;                   /* const member directly */
    const struct P cp = {1};
    cp.x = 2;                  /* member of const struct */
    const struct P *pp = &cp;
    pp->x = 3;                 /* member via pointer-to-const struct */
    struct A { int a[2]; };
    const struct A ca = {{1, 2}};
    ca.a[0] = 5;               /* array member of const struct */
    typedef int Arr[2];
    const Arr ta = {1, 2};
    ta[0] = 5;                 /* typedef'd const array element */
    return c;
}
