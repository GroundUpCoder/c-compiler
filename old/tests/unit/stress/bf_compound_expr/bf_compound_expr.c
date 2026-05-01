/* Test: compound assignment and complex expressions with bitfields
 * Tests +=, -=, *=, |=, &=, ^=, <<=, >>= on bitfields,
 * and bitfields in complex expressions (comma, cast, sizeof).
 */
#include <stdio.h>

struct S {
    unsigned int a : 4;  /* 0-15 */
    signed int b : 4;    /* -8 to 7 */
    unsigned int c : 8;  /* 0-255 */
};

int main() {
    struct S s;

    /* Compound assignment: += */
    s.a = 5;
    s.a += 3;
    printf("a+=3: %d\n", s.a);  /* 8 */

    /* Compound assignment: += with truncation */
    s.a = 14;
    s.a += 5;
    printf("a+=5(trunc): %d\n", s.a);  /* 19 & 0xF = 3 */

    /* Compound assignment: -= */
    s.a = 5;
    s.a -= 3;
    printf("a-=3: %d\n", s.a);  /* 2 */

    /* Compound assignment: *= */
    s.a = 3;
    s.a *= 4;
    printf("a*=4: %d\n", s.a);  /* 12 */

    /* Compound assignment: |= */
    s.a = 5;   /* 0101 */
    s.a |= 10; /* 1010 */
    printf("a|=10: %d\n", s.a); /* 15 */

    /* Compound assignment: &= */
    s.a = 15;  /* 1111 */
    s.a &= 6;  /* 0110 */
    printf("a&=6: %d\n", s.a);  /* 6 */

    /* Compound assignment: ^= */
    s.a = 15;  /* 1111 */
    s.a ^= 5;  /* 0101 */
    printf("a^=5: %d\n", s.a);  /* 10 */

    /* Compound assignment: <<= */
    s.a = 1;
    s.a <<= 3;
    printf("a<<=3: %d\n", s.a); /* 8 */

    /* Compound assignment: >>= */
    s.a = 12;
    s.a >>= 2;
    printf("a>>=2: %d\n", s.a); /* 3 */

    /* Signed compound: negative operations */
    s.b = 3;
    s.b -= 5;
    printf("b-=5: %d\n", s.b);  /* -2 */

    s.b = -1;
    s.b *= 2;
    printf("b*=2: %d\n", s.b);  /* -2 */

    /* Right shift signed bitfield */
    s.b = -4;
    s.b >>= 1;
    printf("b>>=1: %d\n", s.b); /* -2 (arithmetic shift) */

    /* Bitfield in comma expression */
    s.a = 5;
    int r = (s.a = 10, s.a);
    printf("comma: %d\n", r);   /* 10 */

    /* Cast bitfield */
    s.b = -3;
    unsigned int u = (unsigned int)s.b;
    /* After promotion to int: -3, then cast to unsigned */
    printf("cast: %u\n", u);    /* 4294967293 (0xFFFFFFFD) */

    /* Bitfield as array index */
    int arr[] = {100, 200, 300, 400};
    s.a = 2;
    printf("arr[a]=%d\n", arr[s.a]);  /* 300 */

    return 0;
}
