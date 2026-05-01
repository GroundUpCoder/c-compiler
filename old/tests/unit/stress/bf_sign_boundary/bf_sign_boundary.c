/* Test: signed bitfield boundary values
 * A signed bitfield of width N holds values from -2^(N-1) to 2^(N-1)-1.
 * Writing the max+1 or min-1 should wrap.
 */
#include <stdio.h>

struct S1 { signed int x : 1; };  /* range: -1 to 0 */
struct S2 { signed int x : 2; };  /* range: -2 to 1 */
struct S3 { signed int x : 3; };  /* range: -4 to 3 */
struct S8 { signed int x : 8; };  /* range: -128 to 127 */
struct S16 { signed int x : 16; }; /* range: -32768 to 32767 */

int main() {
    /* 1-bit signed: only -1 and 0 */
    struct S1 s1;
    s1.x = 0; printf("s1(0)=%d\n", s1.x);    /* 0 */
    s1.x = 1; printf("s1(1)=%d\n", s1.x);    /* -1 (wraps) */
    s1.x = -1; printf("s1(-1)=%d\n", s1.x);  /* -1 */

    /* 2-bit signed: -2 to 1 */
    struct S2 s2;
    s2.x = 1; printf("s2(1)=%d\n", s2.x);    /* 1 */
    s2.x = -2; printf("s2(-2)=%d\n", s2.x);  /* -2 */
    s2.x = 2; printf("s2(2)=%d\n", s2.x);    /* -2 (wraps) */
    s2.x = 3; printf("s2(3)=%d\n", s2.x);    /* -1 (wraps) */

    /* 3-bit signed: -4 to 3 */
    struct S3 s3;
    s3.x = 3; printf("s3(3)=%d\n", s3.x);    /* 3 */
    s3.x = -4; printf("s3(-4)=%d\n", s3.x);  /* -4 */
    s3.x = 4; printf("s3(4)=%d\n", s3.x);    /* -4 (wraps) */
    s3.x = 7; printf("s3(7)=%d\n", s3.x);    /* -1 (wraps) */
    s3.x = -5; printf("s3(-5)=%d\n", s3.x);  /* 3 (wraps) */

    /* 8-bit signed: -128 to 127 */
    struct S8 s8;
    s8.x = 127; printf("s8(127)=%d\n", s8.x);     /* 127 */
    s8.x = -128; printf("s8(-128)=%d\n", s8.x);   /* -128 */
    s8.x = 128; printf("s8(128)=%d\n", s8.x);     /* -128 (wraps) */
    s8.x = 255; printf("s8(255)=%d\n", s8.x);     /* -1 (wraps) */

    /* 16-bit signed: -32768 to 32767 */
    struct S16 s16;
    s16.x = 32767; printf("s16(32767)=%d\n", s16.x);    /* 32767 */
    s16.x = -32768; printf("s16(-32768)=%d\n", s16.x);  /* -32768 */
    s16.x = 32768; printf("s16(32768)=%d\n", s16.x);    /* -32768 (wraps) */

    return 0;
}
