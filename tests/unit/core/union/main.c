#include <stdio.h>

union IntOrFloat {
  int i;
  float f;
};

int main() {
  union IntOrFloat u;
  u.i = 42;
  printf("i=%d\n", u.i);

  u.f = 3.14f;
  printf("f=%d\n", (int)(u.f * 100));

  // Union size should be max of members
  printf("size=%d\n", (int)sizeof(union IntOrFloat));

  // Union in struct
  struct Tagged {
    int tag;
    union IntOrFloat val;
  };
  struct Tagged t;
  t.tag = 1;
  t.val.i = 99;
  printf("tag=%d val=%d\n", t.tag, t.val.i);

  return 0;
}
