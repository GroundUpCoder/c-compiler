#include <stdio.h>

// Forward declarations of functions defined in helper.c
int add(int a, int b);
int get_counter();
void bump_counter();

// Extern declaration of global from helper.c
extern int shared_global;

int main() {
  // Call function from other file
  printf("%d\n", add(3, 4));

  // Access global from other file
  printf("%d\n", shared_global);
  shared_global = 100;
  printf("%d\n", shared_global);

  // State preserved across calls to other file
  printf("%d\n", get_counter());
  bump_counter();
  bump_counter();
  printf("%d\n", get_counter());

  return 0;
}
