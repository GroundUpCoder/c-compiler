#include <stdio.h>
#include <stdlib.h>

void cleanup1(void) {
  printf("cleanup1\n");
}

void cleanup2(void) {
  printf("cleanup2\n");
}

int main(void) {
  atexit(cleanup1);
  atexit(cleanup2);
  printf("before exit\n");
  exit(42);
  printf("after exit\n");
  return 0;
}
