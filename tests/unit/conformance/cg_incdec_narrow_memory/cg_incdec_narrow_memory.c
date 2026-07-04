// BUG: ++/-- through a pointer to a sub-int type skips the narrowing store conversion, producing un-wrapped values
// C11: 6.5.3.1p2 (++E is E+=1: the sum is converted to the type of E on assignment), 6.5.2.4p2 (postfix forms), 6.3.1.3p3 (conversion to narrower type)
// EXPECT: char 127+1 wraps to -128, unsigned char 255+1 to 0, short 32767+1 to -32768 (and the mirrored decrements); matches native clang
#include <stdio.h>
int main(void) {
  char c = 127;
  int x = ++*(&c);
  printf("A %d %d\n", x, (int)c);
  unsigned char u = 255;
  int y = ++*(&u);
  printf("B %d %d\n", y, (int)u);
  short s = 32767;
  int z = ++*(&s);
  printf("C %d %d\n", z, (int)s);
  char c2 = 127;
  int px = (*(&c2))++;
  printf("D %d %d\n", px, (int)c2);
  unsigned char u2 = 0;
  int py = (*(&u2))--;
  printf("E %d %d\n", py, (int)u2);
  short s2 = -32768;
  int pz = (*(&s2))--;
  printf("F %d %d\n", pz, (int)s2);
  return 0;
}
