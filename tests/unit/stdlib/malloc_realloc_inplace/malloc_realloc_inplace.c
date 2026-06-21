// In-place realloc growth: when the next physical block is free and big
// enough, realloc must extend the block in place (returning the SAME pointer)
// instead of malloc+copy+free. At program start the pool is pristine, so the
// first allocations are carved sequentially from the single free block and are
// therefore physically adjacent (same assumption the coalescing test relies on).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
  // === In-place grow absorbs a freed neighbor, splits remainder ===
  char *a = malloc(64);
  for (int i = 0; i < 64; i++) a[i] = (char)(i + 1);
  char *b = malloc(256);   // neighbor to be absorbed
  char *c = malloc(64);    // guard: b is not the last block
  free(b);                 // now: [a used][b free][c used]
  char *a2 = realloc(a, 200);   // 200 fits in a(64)+b(256)
  if (a2 != a) { printf("FAIL: realloc did not grow in place\n"); return 1; }
  for (int i = 0; i < 64; i++) {
    if (a2[i] != (char)(i + 1)) { printf("FAIL: payload not preserved\n"); return 1; }
  }
  printf("inplace grow: PASS\n");

  // Split remainder must be reusable and distinct from a2 and c.
  char *d = malloc(64);
  if (!d || d == a2 || d == c) { printf("FAIL: remainder not reusable\n"); return 1; }
  d[0] = 0x55;
  if (d[0] != 0x55 || a2[0] != 1) { printf("FAIL: remainder overlaps live data\n"); return 1; }
  printf("remainder reuse: PASS\n");
  free(a2); free(c); free(d);

  // === Next free but TOO SMALL => fallback copy (pointer moves) ===
  char *h = malloc(64);
  strcpy(h, "moveme");
  char *k = malloc(64);    // small neighbor
  char *l = malloc(64);    // guard
  free(k);
  char *h2 = realloc(h, 600);   // 600 > h+k combined => must move
  if (h2 == h) { printf("FAIL: expected move, grew in place\n"); return 1; }
  if (strcmp(h2, "moveme") != 0) { printf("FAIL: move lost data\n"); return 1; }
  printf("fallback move: PASS\n");
  free(h2); free(l);

  // === Next block USED => fallback copy ===
  char *m = malloc(64);
  strcpy(m, "used");
  char *n = malloc(64);    // stays allocated (used neighbor)
  char *m2 = realloc(m, 200);
  if (m2 == m) { printf("FAIL: expected move past used neighbor\n"); return 1; }
  if (strcmp(m2, "used") != 0) { printf("FAIL: move lost data (used)\n"); return 1; }
  printf("used neighbor move: PASS\n");
  free(m2); free(n);

  // === realloc chain: first byte survives every move ===
  char *p = malloc(16);
  p[0] = 42;
  long sz = 64;
  for (int it = 0; it < 50; it++) {
    p = realloc(p, sz);
    if (!p) { printf("FAIL: chain realloc returned NULL\n"); return 1; }
    if (p[0] != 42) { printf("FAIL: chain lost first byte\n"); return 1; }
    p[sz - 1] = (char)(sz & 0x7f);
    if (p[sz - 1] != (char)(sz & 0x7f)) { printf("FAIL: chain tail\n"); return 1; }
    sz += 40;
  }
  free(p);
  printf("realloc chain: PASS\n");

  // === Edge cases ===
  if (realloc(NULL, 0) != NULL) { printf("FAIL: realloc(NULL,0)\n"); return 1; }
  char *q = malloc(32);
  if (realloc(q, 0) != NULL) { printf("FAIL: realloc(p,0)\n"); return 1; }
  char *r = realloc(NULL, 48);
  if (!r) { printf("FAIL: realloc(NULL,n)\n"); return 1; }
  char *r2 = realloc(r, 16);   // shrink => same pointer
  if (r2 != r) { printf("FAIL: shrink should keep pointer\n"); return 1; }
  free(r2);
  printf("edge cases: PASS\n");

  printf("ALL TESTS PASSED\n");
  return 0;
}
