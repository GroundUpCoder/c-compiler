/* #791: bounded source-derived metric fixture. Rejections must not allocate.
 * The allocator itself refuses large requests, so a regression cannot exhaust
 * memory while testing the pre-allocation contract. */
#include <stdlib.h>
static int allocations;
static void *bounded_calloc(size_t n, size_t size) {
    allocations++;
    if (size && n > 512 * 1024 / size) return NULL;
    return calloc(n, size);
}
#define calloc bounded_calloc
#include "../fontcore.h"
#undef calloc
int main(void) {
    FcGlyph g = {0};
    if (fc_tofu_checked(&g, 2051, 20, 0x10ffff, 2048, 512*1024)) return 1;
    if (fc_tofu_checked(&g, 20, 2050, 0x10ffff, 2048, 512*1024)) return 2;
    if (fc_tofu_checked(&g, 1026, 514, 0x10ffff, 2048, 512*1024)) return 3;
    if (fc_tofu_checked(&g, INT_MAX, 20, 0x4e00, 2048, 512*1024)) return 4;
    if (fc_tofu_checked(&g, 20, INT_MIN, 0x10ffff, 2048, 512*1024)) return 5;
    if (allocations || g.bmp) return 6;
    /* Exact product bound, including wide-codepoint dimensions. */
    if (!fc_tofu_checked(&g, 10, 9, 0x4e00, 18, 144)) return 7;
    if (allocations != 1 || g.w != 18 || g.h != 8 || g.advance != 20 ||
        g.left != 1 || g.top != 8) return 8;
    for (int y=0; y<g.h; y++) for (int x=0; x<g.w; x++)
        if (g.bmp[y*g.w+x] != ((x==0 || x==g.w-1 || y==0 || y==g.h-1)?255:0)) return 9;
    free(g.bmp); g.bmp=NULL;
    if (fc_tofu_checked(&g, 10, 9, 0x4e00, 18, 143) || allocations != 1) return 10;
    if (fc_tofu_checked(&g, 10, 9, 0x4e00, 17, 144) || allocations != 1) return 11;
    return 0;
}
