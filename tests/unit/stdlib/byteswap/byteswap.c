#include <stdio.h>
#include <byteswap.h>

int main(void) {
    printf("%04x\n", bswap_16(0x1234));             /* 3412 */
    printf("%08x\n", bswap_32(0x12345678));         /* 78563412 */
    printf("%08x\n", bswap_32(0xAABBCCDD));         /* ddccbbaa */
    printf("%08x\n", bswap_32(0x00000001));         /* 01000000 */
    printf("%08x\n", bswap_32(bswap_32(0xDEADBEEF))); /* deadbeef (roundtrip) */

    /* Verify argument is evaluated exactly once */
    int count;
    int vals[] = {0x1234, 0x5678};
    unsigned short r16;
    unsigned int r32;
    unsigned long long r64;

    count = 0;
    r16 = bswap_16(vals[count++]);
    printf("count16: %d\n", count);  /* 1 */
    (void)r16;

    count = 0;
    r32 = bswap_32(vals[count++]);
    printf("count32: %d\n", count);  /* 1 */
    (void)r32;

    count = 0;
    long long vals64[] = {0x123456789ABCDEF0LL};
    r64 = bswap_64(vals64[count++]);
    printf("count64: %d\n", count);  /* 1 */
    (void)r64;

    return 0;
}
