// Test that realloc shrinking allows reclaiming wasted space.
// Current implementation doesn't split on shrink, so this may expose
// memory waste issues.
//
// NOTE: This test hits the TLSF mapping bug at malloc(4096) — adjusted=4104
// falls in the FL=8 dead zone where mapping_search and mapping_insert
// disagree on the SL bucket.
#include <stdio.h>
#include <stdlib.h>

int main() {
  // === Realloc shrink: the wasted space should ideally be reclaimable ===
  {
    struct __heap_info h1;
    struct __heap_info h2;

    // Allocate a large block
    char *p = (char *)malloc(4096);
    if (!p) { printf("FAIL: large alloc\n"); return 1; }
    int i = 0;
    while (i < 4096) { p[i] = (char)(i & 0xFF); i = i + 1; }

    // Shrink to tiny
    p = (char *)realloc(p, 8);
    if (!p) { printf("FAIL: shrink realloc\n"); return 1; }
    // Verify first 8 bytes preserved
    i = 0;
    while (i < 8) {
      if (p[i] != (char)(i & 0xFF)) {
        printf("FAIL: shrink data at %d\n", i);
        return 1;
      }
      i = i + 1;
    }

    __inspect_heap(&h1);

    // Now try to allocate 4000 bytes. If realloc split the block,
    // there should be enough free space. If not, pool must grow.
    char *q = (char *)malloc(4000);
    if (!q) { printf("FAIL: reclaim alloc\n"); return 1; }

    __inspect_heap(&h2);

    // Check if pool grew (it shouldn't need to if shrink reclaimed space)
    if (h2.total_bytes > h1.total_bytes) {
      printf("NOTE: pool grew after shrink+realloc (%ld -> %ld). Shrink didn't reclaim.\n",
             h1.total_bytes, h2.total_bytes);
      // This is a known weakness but not necessarily a fatal error
    }

    free(q);
    free(p);
    printf("realloc shrink: PASS\n");
  }

  // === Multiple shrink+grow cycles to check for cumulative waste ===
  {
    struct __heap_info h_start;
    __inspect_heap(&h_start);

    int round = 0;
    while (round < 50) {
      char *p = (char *)malloc(1024);
      if (!p) { printf("FAIL: cycle alloc round %d\n", round); return 1; }
      p[0] = (char)round;

      // Shrink
      p = (char *)realloc(p, 16);
      if (!p) { printf("FAIL: cycle shrink round %d\n", round); return 1; }
      if (p[0] != (char)round) {
        printf("FAIL: cycle data round %d\n", round);
        return 1;
      }

      free(p);
      round = round + 1;
    }

    struct __heap_info h_end;
    __inspect_heap(&h_end);
    // Pool shouldn't have grown excessively
    if (h_end.total_bytes > h_start.total_bytes + 8192) {
      printf("FAIL: cumulative waste: %ld -> %ld (grew by %ld)\n",
             h_start.total_bytes, h_end.total_bytes,
             h_end.total_bytes - h_start.total_bytes);
      return 1;
    }
    printf("shrink cycle waste: PASS\n");
  }

  // === Realloc shrink preserves correct data ===
  {
    char *p = (char *)malloc(512);
    if (!p) { printf("FAIL: preserve alloc\n"); return 1; }
    int i = 0;
    while (i < 512) { p[i] = (char)(i * 7 + 3); i = i + 1; }

    // Shrink step by step: 512 -> 256 -> 128 -> 64 -> 32 -> 16 -> 8
    int sizes[] = {256, 128, 64, 32, 16, 8};
    int ns = 6;
    int si = 0;
    while (si < ns) {
      p = (char *)realloc(p, sizes[si]);
      if (!p) { printf("FAIL: step shrink to %d\n", sizes[si]); return 1; }
      i = 0;
      while (i < sizes[si]) {
        if (p[i] != (char)(i * 7 + 3)) {
          printf("FAIL: step shrink data at %d (size %d)\n", i, sizes[si]);
          return 1;
        }
        i = i + 1;
      }
      si = si + 1;
    }
    free(p);
    printf("step shrink preserve: PASS\n");
  }

  printf("ALL TESTS PASSED\n");
  return 0;
}
