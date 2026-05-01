// Test that free(NULL) is safe (no crash)
#include <stdio.h>
#include <stdlib.h>

int main() {
  // free(NULL) should be a no-op
  free(NULL);
  printf("free(NULL) succeeded\n");

  // Multiple free(NULL) calls should also be safe
  free(NULL);
  free(NULL);
  printf("multiple free(NULL) succeeded\n");

  // Normal allocation/free should still work after
  char *p = malloc(16);
  if (!p) {
    printf("ERROR: malloc failed\n");
    return 1;
  }
  free(p);
  printf("normal malloc/free succeeded\n");

  printf("ALL TESTS PASSED\n");
  return 0;
}
