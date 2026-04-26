#include <stdio.h>

/* Token pasting helpers (same as tinyemu's cutils.h) */
#define xglue(x, y) x ## y
#define glue(x, y) xglue(x, y)

/* Self-referential macro that uses glue to paste its own name with a suffix.
   E.g. F_QNAN expands to F_QNAN32 when F_SIZE is 32.
   This pattern is used heavily in tinyemu's softfp_template.h */
#define F_SIZE 32
#define F_QNAN glue(F_QNAN, F_SIZE)
#define clz glue(clz, F_SIZE)
#define add_sf glue(add_sf, F_SIZE)

int F_QNAN32 = 42;
int clz32 = 7;
int add_sf32 = 99;

int main(void) {
    printf("%d\n", F_QNAN);   /* should resolve to F_QNAN32 = 42 */
    printf("%d\n", clz);      /* should resolve to clz32 = 7 */
    printf("%d\n", add_sf);   /* should resolve to add_sf32 = 99 */
    return 0;
}
