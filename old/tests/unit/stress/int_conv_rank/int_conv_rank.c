/* Test: integer conversion, promotion, and truncation edge cases
 * Tests the "usual arithmetic conversions" and integer promotion
 * rules that are core to C computation correctness.
 */
#include <stdio.h>

int main() {
    /* char promotion: char is promoted to int in expressions */
    char c1 = 127;
    char c2 = 1;
    /* c1 + c2 is computed as int, result 128 doesn't fit back in signed char */
    printf("char 127+1 as int: %d\n", c1 + c2);  /* 128 */
    char c3 = c1 + c2;
    printf("char 127+1 stored: %d\n", c3);        /* -128 (overflow) */

    /* unsigned char: 0-255 */
    unsigned char uc = 255;
    printf("uchar 255+1 as int: %d\n", uc + 1);   /* 256 */
    unsigned char uc2 = uc + 1;
    printf("uchar 255+1 stored: %d\n", uc2);      /* 0 (wraps) */

    /* short promotion */
    short s1 = 32767;
    short s2 = 1;
    printf("short max+1 as int: %d\n", s1 + s2);  /* 32768 */
    short s3 = s1 + s2;
    printf("short max+1 stored: %d\n", s3);        /* -32768 */

    /* Signed/unsigned comparison with small types */
    /* After promotion, both become int, comparison is straightforward */
    signed char sc = -1;
    unsigned char usc = 255;
    /* Both promote to int: sc=-1, usc=255 */
    printf("schar(-1) < uchar(255): %d\n", sc < usc);  /* 1 */

    /* Integer division truncation toward zero (C99+) */
    printf("7/2=%d\n", 7 / 2);          /* 3 */
    printf("-7/2=%d\n", -7 / 2);        /* -3 */
    printf("7/-2=%d\n", 7 / -2);        /* -3 */
    printf("-7/-2=%d\n", -7 / -2);      /* 3 */

    /* Modulo follows division (C99+: result has same sign as dividend) */
    printf("7%%2=%d\n", 7 % 2);         /* 1 */
    printf("-7%%2=%d\n", -7 % 2);       /* -1 */
    printf("7%%-2=%d\n", 7 % -2);       /* 1 */
    printf("-7%%-2=%d\n", -7 % -2);     /* -1 */

    /* Unsigned wraparound */
    unsigned int u = 0;
    u = u - 1;
    printf("uint 0-1: %u\n", u);        /* 4294967295 */

    /* Signed to unsigned conversion */
    int neg = -1;
    unsigned int uneg = neg;
    printf("int -1 as uint: %u\n", uneg);  /* 4294967295 */

    /* Narrowing casts */
    int big = 0x12345678;
    short sh = (short)big;
    printf("0x12345678 as short: %d\n", sh);  /* 0x5678 = 22136 */
    char ch = (char)big;
    printf("0x12345678 as char: %d\n", ch);   /* 0x78 = 120 */

    /* Widening with sign extension */
    signed char sc2 = -100;
    int wi = sc2;
    printf("schar -100 as int: %d\n", wi);    /* -100 */
    unsigned int wu = (unsigned int)sc2;
    /* -100 sign-extends to int (-100), then reinterprets as unsigned */
    printf("schar -100 as uint: %u\n", wu);   /* 4294967196 */

    return 0;
}
