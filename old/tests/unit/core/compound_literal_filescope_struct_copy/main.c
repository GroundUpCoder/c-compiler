// Bug: file-scope compound literal used as value initializer for aggregate
// (struct) globals produces zero-initialized data. The global variable init
// path (MEMORY vars) checks for INIT_LIST, STRING, and !isAggregate() —
// a COMPOUND_LITERAL expression for an aggregate type matches none of these
// branches, so no initialization occurs.
//
// Root cause: the MEMORY global init code at ~line 16148 does not handle
// the case where initExpr.kind == COMPOUND_LITERAL and type.isAggregate().
// It would need to either:
// (a) copy from the compound literal's already-initialized static storage, or
// (b) treat the compound literal's init list as the variable's init list.

#include <stdio.h>

struct Point { int x, y; };
struct Inner { int a, b; };
struct Outer { struct Inner in; int c; };

// Direct struct copy from compound literal
struct Point p = (struct Point){10, 20};

// Nested struct copy from compound literal
struct Outer o = (struct Outer){{100, 200}, 300};

// Designated initializer struct copy
struct Point p2 = (struct Point){.y = 50, .x = 40};

int main(void) {
    printf("%d %d\n", p.x, p.y);
    printf("%d %d %d\n", o.in.a, o.in.b, o.c);
    printf("%d %d\n", p2.x, p2.y);
    return 0;
}
