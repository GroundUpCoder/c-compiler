// BUG: a static-initializer address constant using MEMBER-ARRAY DECAY plus
// pointer arithmetic — `int *pb = s.b + 2;` at file scope — was rejected
// ("initializer element is not a compile-time constant") while the same
// address spelled `&s.b[2]` was accepted. The const-eval EDecay case only
// resolved a bare identifier operand (plain `arr + 1` worked); a decayed
// MEMBER (or nested member / subscripted row) had no EMember path and
// evaluated to null. Zero-offset `int *p = s.b;` failed the same way.
// C11: 6.6p9 — an address constant may be formed from an array lvalue via
// array-to-pointer conversion and modified by integer +/-; `s.b + k` and
// `&s.b[k]` are the same address constant.
// EXPECT: matches clang: every decay spelling equals its &[] twin, and all
// pointers dereference to the values stored at runtime.
#include <stdio.h>

struct S { int a; int b[4]; } s;
struct T { struct { int m[4]; } inner; } t;
struct R { int pad; int rows[2][3]; } r;
int arr[4];

int *pb = s.b + 2;            /* member decay + offset */
int *pb_amp = &s.b[2];        /* the accepted twin */
int *pz = s.b;                /* zero offset */
int *pz_amp = &s.b[0];
int *pm = t.inner.m + 3;      /* nested member decay */
int *pm_amp = &t.inner.m[3];
int *pa = arr + 1;            /* plain top-level decay (regression guard) */
int *pa_amp = &arr[1];
int *pr = r.rows[1] + 1;      /* subscripted row decay */
int *pr_amp = &r.rows[1][1];
int *pneg = s.b + 3 - 2;      /* net offset via +/-, still a constant */
int *pboth[2] = { s.b + 1, s.b };  /* aggregate (data-section) init path */

int main(void) {
    static int *sp = s.b + 2; /* static local, same const-eval path */
    int *rq = s.b + 2;        /* runtime block-scope decay must not regress */

    printf("twins: %d %d %d %d %d\n",
           pb == pb_amp, pz == pz_amp, pm == pm_amp, pa == pa_amp, pr == pr_amp);
    printf("neg: %d\n", pneg == &s.b[1]);
    printf("agg: %d %d\n", pboth[0] == &s.b[1], pboth[1] == &s.b[0]);
    printf("static_local: %d  runtime: %d\n", sp == &s.b[2], rq == &s.b[2]);

    for (int i = 0; i < 4; i++) { s.b[i] = 10 + i; t.inner.m[i] = 20 + i; arr[i] = 30 + i; }
    r.rows[1][1] = 41;
    printf("deref: %d %d %d %d %d %d %d\n", *pb, *pz, *pm, *pa, *pr, *pneg, *sp);
    return 0;
}
