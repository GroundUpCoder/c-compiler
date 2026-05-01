/* Union type-punning: read double as bytes, verify round-trip */
#include <stdio.h>
#include <string.h>

int main(void) {
    union { double d; unsigned char b[sizeof(double)]; } u;
    u.d = 1.0;
    /* IEEE 754 double 1.0 = 0x3FF0000000000000 */
    int found_3f = 0, found_f0 = 0;
    for (int i = 0; i < (int)sizeof(double); i++) {
        if (u.b[i] == 0x3F) found_3f = 1;
        if (u.b[i] == 0xF0) found_f0 = 1;
    }
    if (!found_3f && !found_f0) { printf("FAIL: expected byte in 1.0\n"); return 1; }

    /* Round-trip */
    union { double d; unsigned char b[sizeof(double)]; } v;
    memcpy(v.b, u.b, sizeof(double));
    if (v.d != 1.0) { printf("FAIL: round-trip\n"); return 1; }

    /* Zero */
    union { double d; unsigned char b[sizeof(double)]; } z;
    z.d = 0.0;
    int all_zero = 1;
    for (int i = 0; i < (int)sizeof(double); i++) {
        if (z.b[i] != 0) all_zero = 0;
    }
    if (!all_zero) { printf("FAIL: 0.0 not all zero bytes\n"); return 1; }

    printf("PASS\n");
    return 0;
}
