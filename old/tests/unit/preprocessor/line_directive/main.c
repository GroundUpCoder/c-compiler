#include <stdio.h>

int main(void) {
  printf("before: %d\n", __LINE__);
#line 100
  printf("after: %d\n", __LINE__);
  printf("next: %d\n", __LINE__);
#line 200 "fake.c"
  printf("file: %d\n", __LINE__);
  return 0;
}
