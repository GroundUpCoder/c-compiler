#include <stdio.h>

// Basic bit-field packing
struct Flags {
  unsigned int a : 3;
  unsigned int b : 5;
  unsigned int c : 1;
};

// Signed bit-fields
struct Signed {
  int x : 4;  // range: -8 to 7
  int y : 3;  // range: -4 to 3
};

// Bit-field with regular members
struct Mixed {
  int regular;
  unsigned int bf1 : 4;
  unsigned int bf2 : 4;
  int another;
};

// Zero-width bit-field forces alignment
struct ZeroWidth {
  unsigned int a : 3;
  unsigned int : 0;  // force next to new unit
  unsigned int b : 3;
};

// Anonymous bit-field for padding
struct Anon {
  unsigned int a : 3;
  unsigned int : 5;  // padding
  unsigned int b : 3;
};

int main() {
  // Test basic read/write
  struct Flags f;
  f.a = 5;
  f.b = 17;
  f.c = 1;
  printf("a=%d b=%d c=%d\n", f.a, f.b, f.c);

  // Test overflow: 3-bit field can hold 0-7
  f.a = 15;  // should truncate to 7
  printf("a_overflow=%d\n", f.a);

  // Test signed bit-fields
  struct Signed s;
  s.x = -3;
  s.y = -1;
  printf("x=%d y=%d\n", s.x, s.y);

  // Test positive values in signed fields
  s.x = 7;
  s.y = 3;
  printf("x=%d y=%d\n", s.x, s.y);

  // Test mixed struct
  struct Mixed m;
  m.regular = 42;
  m.bf1 = 9;
  m.bf2 = 6;
  m.another = 100;
  printf("regular=%d bf1=%d bf2=%d another=%d\n", m.regular, m.bf1, m.bf2, m.another);

  // Test sizeof with zero-width bit-field
  printf("sizeof_ZeroWidth=%d\n", (int)sizeof(struct ZeroWidth));

  // Test zero-width forces new unit
  struct ZeroWidth zw;
  zw.a = 5;
  zw.b = 3;
  printf("zw_a=%d zw_b=%d\n", zw.a, zw.b);

  // Test compound assignment
  f.a = 3;
  f.a += 2;
  printf("compound_add=%d\n", f.a);

  f.b = 10;
  f.b |= 1;
  printf("compound_or=%d\n", f.b);

  // Test anonymous bit-field
  struct Anon an;
  an.a = 7;
  an.b = 5;
  printf("anon_a=%d anon_b=%d\n", an.a, an.b);

  // Test arrow access
  struct Flags *pf = &f;
  pf->a = 6;
  pf->b = 20;
  printf("arrow_a=%d arrow_b=%d\n", pf->a, pf->b);

  return 0;
}
