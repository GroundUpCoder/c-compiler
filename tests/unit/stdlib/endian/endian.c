#include <stdio.h>
#include <endian.h>

int main(void) {
    printf("%d\n", __BYTE_ORDER == __LITTLE_ENDIAN);   /* 1 */
    printf("%d\n", BYTE_ORDER == LITTLE_ENDIAN);       /* 1 */
    printf("%04x\n", htole16(0x1234));                 /* 1234 */
    printf("%04x\n", htobe16(0x1234));                 /* 3412 */
    printf("%08x\n", htole32(0x12345678));             /* 12345678 */
    printf("%08x\n", htobe32(0x12345678));             /* 78563412 */
    unsigned long long v = 0x1122334455667788ULL;
    printf("%016llx\n", htole64(v));                   /* 1122334455667788 */
    printf("%016llx\n", htobe64(v));                   /* 8877665544332211 */
    printf("%d\n", be16toh(htobe16(0xABCD)) == 0xABCD); /* 1 roundtrip */
    printf("%d\n", be32toh(htobe32(0xDEADBEEF)) == 0xDEADBEEF); /* 1 */
    return 0;
}
