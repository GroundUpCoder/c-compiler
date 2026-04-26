// Test that double-free is detected and causes a crash
#include <stdio.h>
#include <stdlib.h>

int main() {
  char *a = malloc(8);
  printf("allocated a\n");

  free(a);
  printf("first free done\n");

  // This should crash with "free: double free detected"
  free(a);

  // Should never reach here
  printf("ERROR: double free was not detected!\n");
  return 0;
}
