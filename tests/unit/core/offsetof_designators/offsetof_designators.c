#include <stdio.h>
#include <stddef.h>

/* BUG: #687 — offsetof folded to an integer constant expression only for a
 * plain single-member designator. Nested named (inner.m), anonymous-union,
 * and anonymous-struct designators all failed to fold, so an array bound
 * using one was rejected as "variable-length arrays are not supported".
 * C11: 7.19p3 — offsetof(type, member-designator) expands to an integer
 * constant expression of type size_t; the member designator may be any form
 * for which &(t.member-designator) is an address constant (nested members,
 * anonymous members, and array-subscript designators included).
 * EXPECT: every bound below folds at compile time; sizeof(bN), the static
 * initializer sN, and the runtime offsetof print must all agree — that pins
 * the parse-time ICE evaluator (constEvalItem) and the static-initializer
 * address-constant evaluator (constEvalExpr/constEvalAddr) to each other. */

struct Inner { int x; int m; };
struct Nest { char a; struct Inner inner; };

struct AU { char a; union { int m; float f; }; };        /* anonymous union */
struct AS { char a; struct { int m; int n; }; };         /* anonymous struct */

/* An anonymous struct inside an anonymous union: the designator walks TWO
 * anonymous links before reaching the named member. */
struct Deep { char a; union { struct { char pad; int m; }; }; int tail; };

/* The GB_SECTION shape from SameBoy (the motivating consumer, #687): a
 * marker inside an anonymous union + an end marker after it; the section
 * size is an offsetof DIFFERENCE through the anonymous member. (Upstream's
 * end marker is a zero-length array — that needs --allow-zero-length-arrays,
 * which SameBoy's build passes; the anonymous-member walk under test here is
 * the same with a plain marker.) */
struct GB {
    int header;
    union { unsigned char rtc_start; struct { int hi; int lo; }; };
    unsigned char rtc_end;
    int unsaved;
};

/* Array bounds — each of these was rejected as a VLA before the fix. */
static unsigned char b1[offsetof(struct Nest, inner.m)];
static unsigned char b2[offsetof(struct AU, m)];
static unsigned char b3[offsetof(struct AS, m)];
static unsigned char b4[offsetof(struct Deep, m)];
static unsigned char b5[offsetof(struct GB, rtc_end) - offsetof(struct GB, rtc_start)];

/* Subscript designators composed with nesting (C11 7.19: the designator may
 * include array subscripts, e.g. t.member-array[index].field). */
struct WithArr { char a; struct Inner arr[4]; };
static unsigned char b6[offsetof(struct WithArr, arr[2].m)];

/* Static initializers — the second evaluator must agree with the first. */
static const int s1 = offsetof(struct Nest, inner.m);
static const int s2 = offsetof(struct AU, m);
static const int s3 = offsetof(struct AS, m);
static const int s4 = offsetof(struct Deep, m);
static const int s5 = offsetof(struct WithArr, arr[2].m);

int main(void) {
    /* sizeof(bN) proves the bound folded to the right constant at compile
     * time; sN proves the static-initializer path agrees; the bare
     * offsetof(...) print proves the runtime expression path agrees. */
    printf("%d %d %d\n", (int)sizeof(b1), s1, (int)offsetof(struct Nest, inner.m));
    printf("%d %d %d\n", (int)sizeof(b2), s2, (int)offsetof(struct AU, m));
    printf("%d %d %d\n", (int)sizeof(b3), s3, (int)offsetof(struct AS, m));
    printf("%d %d %d\n", (int)sizeof(b4), s4, (int)offsetof(struct Deep, m));
    printf("%d %d\n", (int)sizeof(b5),
           (int)(offsetof(struct GB, rtc_end) - offsetof(struct GB, rtc_start)));
    printf("%d %d %d\n", (int)sizeof(b6), s5, (int)offsetof(struct WithArr, arr[2].m));
    /* A case label is an ICE context too, not just an array bound. */
    switch ((int)sizeof(b2)) {
        case offsetof(struct AU, m): puts("case ok"); break;
        default: puts("case BAD"); break;
    }
    return 0;
}
