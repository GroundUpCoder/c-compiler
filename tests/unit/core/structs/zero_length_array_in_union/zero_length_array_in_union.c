// QuickJS's JSString pattern: a trailing union of zero-length arrays
// used as type aliases for the same overallocated buffer. Requires
// --allow-zero-length-arrays.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

struct JSString {
    int len;
    int is_wide;
    union {
        uint8_t  str8[0];
        uint16_t str16[0];
    } u;
};

int main(void) {
    // sizeof must NOT count the zero-length arrays
    printf("sizeof=%d\n", (int)sizeof(struct JSString));

    // Narrow string: overallocate sizeof(struct) + len * sizeof(uint8_t)
    struct JSString *s8 = malloc(sizeof(struct JSString) + 5);
    s8->len = 5; s8->is_wide = 0;
    s8->u.str8[0] = 'h'; s8->u.str8[1] = 'e'; s8->u.str8[2] = 'l';
    s8->u.str8[3] = 'l'; s8->u.str8[4] = 'o';
    printf("s8: len=%d wide=%d data=%c%c%c%c%c\n",
        s8->len, s8->is_wide,
        s8->u.str8[0], s8->u.str8[1], s8->u.str8[2], s8->u.str8[3], s8->u.str8[4]);
    free(s8);

    // Wide string: overallocate sizeof(struct) + len * sizeof(uint16_t)
    struct JSString *s16 = malloc(sizeof(struct JSString) + 3 * 2);
    s16->len = 3; s16->is_wide = 1;
    s16->u.str16[0] = 0x0041; // 'A'
    s16->u.str16[1] = 0x0042; // 'B'
    s16->u.str16[2] = 0x0043; // 'C'
    printf("s16: len=%d wide=%d data=%x,%x,%x\n",
        s16->len, s16->is_wide,
        s16->u.str16[0], s16->u.str16[1], s16->u.str16[2]);

    // Both members of the union must alias the same memory.
    printf("alias: str8==str16? %d\n", (void*)s16->u.str8 == (void*)s16->u.str16);
    free(s16);

    return 0;
}
