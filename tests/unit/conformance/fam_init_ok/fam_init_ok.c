// BUG: companion to diag_local_fam_init (todos/0205) — pins the FAM-init
// forms that must KEEP working while automatic-storage FAM init is
// rejected: file-scope, block-scope static (both sized with the FAM extra
// via computeInitAllocSize, adjacent statics must not overlap), and an
// automatic struct whose init list leaves the FAM alone.
// C11: 6.7.2.1 + the gcc/clang static-storage FAM-init extension.
// EXPECT: matches gcc/clang.
#include <stdio.h>

struct FAM { int n; int data[]; };
struct SFAM { int n; char s[]; };
struct FAM g = {3, {2, 4, 6}};
int guard1 = 111;
struct SFAM h = {2, "hi"};

int main(void) {
    static struct FAM sf = {2, {7, 9}};
    static int guard2 = 222;
    struct FAM autoNoFam = {5};
    printf("g: %d %d %d %d %d\n", g.n, g.data[0], g.data[2], guard1, g.data[1]);
    printf("h: %d %s\n", h.n, h.s);
    printf("sf: %d %d %d %d\n", sf.n, sf.data[0], sf.data[1], guard2);
    printf("auto: %d\n", autoNoFam.n);
    return 0;
}
