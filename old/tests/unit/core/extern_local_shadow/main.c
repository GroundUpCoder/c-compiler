#include <stdio.h>

// static 'x' with internal linkage
static int x = 10;

void set_x(int val);

// Uses the file-scope static x
void print_static_x() {
  printf("%d\n", x);
}

// Uses extern to refer to the external-linkage x from helper.c
void print_extern_x() {
  extern int x;
  printf("%d\n", x);
}

int main() {
  // static x is 10, extern x is 20
  print_static_x();
  print_extern_x();

  // Mutate the extern x through helper.c's set_x
  set_x(77);
  print_static_x();
  print_extern_x();

  // Mutate the static x directly
  x = 55;
  print_static_x();
  print_extern_x();

  return 0;
}
