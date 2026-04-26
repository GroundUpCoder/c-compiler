/* Test: bitfields in unions
 * Bitfields in unions share storage. Writing one member and reading
 * through another tests the low-level bit layout.
 */
#include <stdio.h>

union U1 {
    struct {
        unsigned int lo : 16;
        unsigned int hi : 16;
    } parts;
    unsigned int whole;
};

union U2 {
    struct {
        unsigned int a : 8;
        unsigned int b : 8;
        unsigned int c : 8;
        unsigned int d : 8;
    } bytes;
    unsigned int word;
};

union U3 {
    struct {
        unsigned int x : 1;
        unsigned int y : 1;
        unsigned int z : 1;
        unsigned int pad : 29;
    } bits;
    unsigned int val;
};

int main() {
    /* Test 1: write whole, read parts */
    union U1 u1;
    u1.whole = 0x00010002;
    printf("lo=%u hi=%u\n", u1.parts.lo, u1.parts.hi);
    /* Little-endian wasm: lo should be low 16 bits */

    /* Test 2: write parts, read whole */
    u1.parts.lo = 0xAAAA;
    u1.parts.hi = 0x5555;
    printf("whole=0x%08x\n", u1.whole);

    /* Test 3: byte-level through bitfields */
    union U2 u2;
    u2.word = 0x04030201;
    printf("a=%d b=%d c=%d d=%d\n",
           u2.bytes.a, u2.bytes.b, u2.bytes.c, u2.bytes.d);

    u2.bytes.a = 0xFF;
    u2.bytes.b = 0x00;
    u2.bytes.c = 0xFF;
    u2.bytes.d = 0x00;
    printf("word=0x%08x\n", u2.word);

    /* Test 4: individual bits */
    union U3 u3;
    u3.val = 0;
    u3.bits.x = 1;
    printf("x=1: val=%u\n", u3.val);

    u3.val = 0;
    u3.bits.y = 1;
    printf("y=1: val=%u\n", u3.val);

    u3.val = 0;
    u3.bits.z = 1;
    printf("z=1: val=%u\n", u3.val);

    u3.bits.x = 1;
    u3.bits.y = 1;
    u3.bits.z = 1;
    printf("xyz=1: val=%u\n", u3.val);

    /* Test 5: sizeof union with bitfields */
    printf("sizeof(U1)=%d\n", (int)sizeof(union U1));
    printf("sizeof(U2)=%d\n", (int)sizeof(union U2));
    printf("sizeof(U3)=%d\n", (int)sizeof(union U3));

    return 0;
}
