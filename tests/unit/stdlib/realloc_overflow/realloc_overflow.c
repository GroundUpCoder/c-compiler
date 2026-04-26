// Test: realloc with size >= 0x80000000 should return NULL, not the old pointer.
// Bug: (long)new_size wraps negative, so the "fits in current block" check
// incorrectly returns the original small buffer.
#include <stdio.h>
#include <stdlib.h>

int main() {
  char *p = malloc(16);
  if (!p) { printf("FAIL: initial malloc returned NULL\n"); return 1; }

  // 0x80000000 as size_t is 2147483648, which cast to signed long is negative.
  // realloc should fail (return NULL) since we can't allocate 2GB.
  // Due to the bug, it returns p instead.
  char *q = realloc(p, (size_t)0x80000000);
  if (q != (void *)0) {
    printf("FAIL: realloc(p, 0x80000000) should return NULL, got original ptr\n");
    free(q);
    return 1;
  }

  // Original pointer should still be valid after failed realloc
  printf("realloc overflow: PASS\n");
  free(p);
  return 0;
}
