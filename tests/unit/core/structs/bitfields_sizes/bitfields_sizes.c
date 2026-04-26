#include <stdio.h>

/* Single bit-field in an int: should be 4 bytes (one int unit) */
struct S1 { unsigned int x : 1; };

/* Two fields fitting in one int: still 4 bytes */
struct S2 { unsigned int a : 16; unsigned int b : 16; };

/* Fields that overflow one int: needs two int units = 8 bytes */
struct S3 { unsigned int a : 17; unsigned int b : 17; };

/* Zero-width forces next into new unit = 8 bytes */
struct S4 { unsigned int a : 3; unsigned int : 0; unsigned int b : 3; };

/* Anonymous padding doesn't start a new unit, just occupies bits */
struct S5 { unsigned int a : 3; unsigned int : 5; unsigned int b : 8; };

/* Regular field + bit-fields: 4 (regular) + 4 (bf unit) = 8 */
struct S6 { int regular; unsigned int x : 4; unsigned int y : 4; };

/* Bit-fields + regular field: 4 (bf unit) + 4 (regular) = 8 */
struct S7 { unsigned int x : 4; unsigned int y : 4; int regular; };

/* Bit-fields sandwiching a regular field: 4 + 4 + 4 = 12 */
struct S8 { unsigned int a : 3; int mid; unsigned int b : 3; };

/* Only zero-width — no storage, just empty struct-ish, but the zero-width
   shouldn't contribute size. In C, an empty struct is implementation-defined.
   With no actual fields, the struct might be size 0 or might have minimal size.
   Let's just print whatever we get. */
struct S9 { unsigned int : 0; };

/* Multiple consecutive zero-widths */
struct S10 { unsigned int a : 3; unsigned int : 0; unsigned int : 0; unsigned int b : 5; };

/* 32 bits exactly fills one int */
struct S11 { unsigned int a : 10; unsigned int b : 10; unsigned int c : 12; };

/* 33 bits overflows into second int = 8 bytes */
struct S12 { unsigned int a : 10; unsigned int b : 10; unsigned int c : 13; };

int main() {
  printf("S1=%d\n", (int)sizeof(struct S1));   /* 4 */
  printf("S2=%d\n", (int)sizeof(struct S2));   /* 4 */
  printf("S3=%d\n", (int)sizeof(struct S3));   /* 8 */
  printf("S4=%d\n", (int)sizeof(struct S4));   /* 8 */
  printf("S5=%d\n", (int)sizeof(struct S5));   /* 4 */
  printf("S6=%d\n", (int)sizeof(struct S6));   /* 8 */
  printf("S7=%d\n", (int)sizeof(struct S7));   /* 8 */
  printf("S8=%d\n", (int)sizeof(struct S8));   /* 12 */
  printf("S9=%d\n", (int)sizeof(struct S9));   /* 0 or 4? */
  printf("S10=%d\n", (int)sizeof(struct S10)); /* 8 */
  printf("S11=%d\n", (int)sizeof(struct S11)); /* 4 */
  printf("S12=%d\n", (int)sizeof(struct S12)); /* 8 */
  return 0;
}
