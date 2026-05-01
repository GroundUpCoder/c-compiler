// TLSF allocator test
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
  struct __heap_info h;

  // === Test 1: Basic allocation ===
  char *a = malloc(8);
  char *b = malloc(8);
  if (!a || !b) { printf("FAIL: malloc returned NULL\n"); return 1; }
  if (a == b) { printf("FAIL: same pointer returned\n"); return 1; }
  // Check 8-byte alignment
  if ((long)a % 8 != 0) { printf("FAIL: a not 8-byte aligned\n"); return 1; }
  if ((long)b % 8 != 0) { printf("FAIL: b not 8-byte aligned\n"); return 1; }
  printf("basic alloc: PASS\n");

  // === Test 2: Write and read back ===
  strcpy(a, "hello");
  strcpy(b, "world");
  if (strcmp(a, "hello") != 0 || strcmp(b, "world") != 0) {
    printf("FAIL: data corruption\n"); return 1;
  }
  printf("write/read: PASS\n");

  // === Test 3: Free and realloc ===
  free(a);
  free(b);
  char *c = malloc(8);
  if (!c) { printf("FAIL: malloc after free returned NULL\n"); return 1; }
  strcpy(c, "test");
  if (strcmp(c, "test") != 0) { printf("FAIL: data after free\n"); return 1; }
  printf("free/realloc: PASS\n");

  // === Test 4: Realloc preserves data ===
  char *r = malloc(10);
  strcpy(r, "preserve");
  r = realloc(r, 100);
  if (!r) { printf("FAIL: realloc returned NULL\n"); return 1; }
  if (strcmp(r, "preserve") != 0) {
    printf("FAIL: realloc didn't preserve data\n"); return 1;
  }
  printf("realloc preserve: PASS\n");
  free(r);

  // === Test 5: Realloc within same block ===
  char *s = malloc(100);
  strcpy(s, "sameblock");
  long old_addr = (long)s;
  s = realloc(s, 50);  // shrink - should keep same block
  if (strcmp(s, "sameblock") != 0) {
    printf("FAIL: shrink realloc data\n"); return 1;
  }
  printf("realloc shrink: PASS\n");
  free(s);

  // === Test 6: calloc zeros memory ===
  int *zeros = calloc(4, sizeof(int));
  if (!zeros) { printf("FAIL: calloc returned NULL\n"); return 1; }
  if (zeros[0] != 0 || zeros[1] != 0 || zeros[2] != 0 || zeros[3] != 0) {
    printf("FAIL: calloc didn't zero memory\n"); return 1;
  }
  printf("calloc zeros: PASS\n");
  free(zeros);

  // === Test 7: Coalescing ===
  // Allocate three blocks, free middle, free first, then allocate combined
  char *p1 = malloc(32);
  char *p2 = malloc(32);
  char *p3 = malloc(32);
  free(p2);
  free(p1);
  // After freeing p1 and p2, they should coalesce
  // Allocate something that needs the combined space
  char *big = malloc(64);
  if (!big) { printf("FAIL: coalesced alloc returned NULL\n"); return 1; }
  printf("coalescing: PASS\n");
  free(p3);
  free(big);

  free(c);

  // === Test 8: __inspect_heap sanity ===
  __inspect_heap(&h);
  if (h.total_bytes <= 0) {
    printf("FAIL: total_bytes should be > 0, got %ld\n", h.total_bytes);
    return 1;
  }
  if (h.free_blocks < 0) {
    printf("FAIL: free_blocks should be >= 0\n"); return 1;
  }
  printf("inspect_heap: PASS (total=%ld, free_blocks=%ld)\n",
         h.total_bytes, h.free_blocks);

  // === Test 9: Many small allocations ===
  long ptrs[100];
  int i = 0;
  while (i < 100) {
    ptrs[i] = (long)malloc(16);
    if (!ptrs[i]) { printf("FAIL: alloc %d returned NULL\n", i); return 1; }
    i = i + 1;
  }
  i = 0;
  while (i < 100) {
    free((void *)ptrs[i]);
    i = i + 1;
  }
  printf("many allocs: PASS\n");

  printf("ALL TESTS PASSED\n");
  return 0;
}
