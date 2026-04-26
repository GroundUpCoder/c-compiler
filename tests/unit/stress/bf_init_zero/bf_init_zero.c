/* Test: bitfield initialization and zeroing
 * Tests static/local initialization, partial initialization,
 * and interaction with memset.
 */
#include <stdio.h>
#include <string.h>

struct BF {
    unsigned int a : 4;
    unsigned int b : 4;
    unsigned int c : 4;
    signed int d : 4;
};

/* Static initialization */
struct BF global_zero;
struct BF global_partial = { 5, 10 };
struct BF global_full = { 15, 15, 15, -8 };

void print_bf(const char *label, struct BF *p) {
    printf("%s: a=%d b=%d c=%d d=%d\n", label, p->a, p->b, p->c, p->d);
}

int main() {
    /* Global zero-initialized */
    print_bf("global_zero", &global_zero);

    /* Global partially initialized (rest should be 0) */
    print_bf("global_partial", &global_partial);

    /* Global fully initialized */
    print_bf("global_full", &global_full);

    /* Local with initializer */
    struct BF local_full = { 3, 6, 9, -1 };
    print_bf("local_full", &local_full);

    /* Local partial init (rest should be 0) */
    struct BF local_partial = { 7 };
    print_bf("local_partial", &local_partial);

    /* Local zero init */
    struct BF local_zero = { 0 };
    print_bf("local_zero", &local_zero);

    /* memset to zero */
    struct BF ms;
    ms.a = 15; ms.b = 15; ms.c = 15; ms.d = -1;
    memset(&ms, 0, sizeof(ms));
    print_bf("memset_zero", &ms);

    /* memset to 0xFF: all bits set */
    memset(&ms, 0xFF, sizeof(ms));
    printf("0xFF: a=%d b=%d c=%d d=%d\n", ms.a, ms.b, ms.c, ms.d);
    /* unsigned 4-bit: 0xF = 15, signed 4-bit: 0xF = -1 */

    /* Assign struct to zero-init new struct */
    struct BF copy = global_full;
    print_bf("copy", &copy);

    /* Modify copy, original unchanged */
    copy.a = 0;
    print_bf("copy_mod", &copy);
    print_bf("orig", &global_full);

    return 0;
}
