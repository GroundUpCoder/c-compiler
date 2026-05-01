#include <stdio.h>

int main() {
  extern int shared_var;
  printf("%d\n", shared_var);
  shared_var = 99;
  printf("%d\n", shared_var);
  return 0;
}
