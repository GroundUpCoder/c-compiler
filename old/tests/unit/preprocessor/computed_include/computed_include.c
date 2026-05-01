#define MYHEADER <stdio.h>
#include MYHEADER

#define MYHEADER2 "stdlib.h"
#include MYHEADER2

int main() {
  printf("hello from computed include\n");
  void *p = malloc(4);
  if (p) {
    printf("malloc works too\n");
    free(p);
  }
  return 0;
}
