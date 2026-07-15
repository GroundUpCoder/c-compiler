// BUG: in IRREDUCIBLE_LOWERING'd functions the decl-hoist rewrite
// (emitAggregateInitAssigns) mishandled string-literal initializers:
// a brace-wrapped string (`char B[] = {"brace"}`) fell to the scalar-leaf
// fallback as B[0] = <literal address low byte>, and wide-string
// per-element stores indexed the literal's little-endian BYTES by element
// index (u"XY" -> {88,0,89}). Found in the 2026-07 fresh-eyes hunt
// (todos/0206); the config's --force-dispatch-loop forces the lowering.
// C11: 6.7.9p14/p15 (string-literal array init, optionally braced).
// EXPECT: matches gcc/clang; identical output with and without lowering.
#include <stdio.h>
typedef unsigned short c16; typedef unsigned int c32;

struct Named { int id; char name[8]; };

int main(void) {
    char plain[] = "plain";
    char braced[] = { "brace" };
    char padded[10] = { "pad" };
    c16 w16[] = u"XY";
    c16 w16b[] = { u"AB" };
    c32 w32[] = U"Zé";
    struct Named nm = { 7, "gucOS" };
    char twod[2][6] = { "ab", "cdef" };
    printf("plain: %s\n", plain);
    printf("braced: %d %s\n", (int)sizeof braced, braced);
    printf("padded: %s %d %d\n", padded, padded[4], padded[9]);
    printf("w16: %d %d %d %d\n", (int)(sizeof w16 / sizeof w16[0]), w16[0], w16[1], w16[2]);
    printf("w16b: %d %d %d\n", w16b[0], w16b[1], w16b[2]);
    printf("w32: %d %d %d\n", (int)w32[0], (int)w32[1], (int)w32[2]);
    printf("nm: %d %s %d\n", nm.id, nm.name, nm.name[7]);
    printf("twod: %s %s\n", twod[0], twod[1]);
    return 0;
}
