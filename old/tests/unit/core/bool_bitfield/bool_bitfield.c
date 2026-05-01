#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

/* bool bitfields must be unsigned: a 1-bit bool holds 0 or 1, never -1 */

struct flags {
    bool a : 1;
    bool b : 1;
    bool c : 1;
};

/* union of bool bitfield struct and uint8_t, like peanut_gb's joypad */
union flag_byte {
    struct {
        bool bit0 : 1;
        bool bit1 : 1;
        bool bit2 : 1;
        bool bit3 : 1;
        bool bit4 : 1;
        bool bit5 : 1;
        bool bit6 : 1;
        bool bit7 : 1;
    } bits;
    uint8_t val;
};

int main(void) {
    /* Test 1: bool bitfield reads back as 1, not -1 */
    struct flags f;
    memset(&f, 0, sizeof(f));
    f.a = 1;
    f.b = 0;
    f.c = 1;
    printf("%d %d %d\n", (int)f.a, (int)f.b, (int)f.c);

    /* Test 2: bool bitfield toggle with ! */
    f.a = !f.a;
    f.c = !f.c;
    printf("%d %d\n", (int)f.a, (int)f.c);

    /* Test 3: union of bool bitfield struct and byte */
    union flag_byte u;
    u.val = 0;
    u.bits.bit0 = 1;
    u.bits.bit7 = 1;
    printf("0x%02X\n", u.val);

    /* Test 4: arithmetic with bool bitfield value */
    f.a = 1;
    int x = f.a + 10;
    printf("%d\n", x);

    return 0;
}
