// Test chains of realloc: grow, shrink, grow again, with data integrity.
//
// NOTE: The growing chain hits the TLSF mapping bug when realloc internally
// calls malloc(256) — adjusted=264 falls in the FL=4 dead zone.
#include <stdio.h>
#include <stdlib.h>

int main() {
  // === Chain of growing reallocs with full data verification ===
  {
    int sizes[] = {1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048};
    int num_sizes = 12;
    char *p = (char *)malloc(1);
    if (!p) { printf("FAIL: initial alloc\n"); return 1; }
    p[0] = 42;

    int si = 1;
    while (si < num_sizes) {
      int new_sz = sizes[si];
      int old_sz = sizes[si - 1];
      p = (char *)realloc(p, new_sz);
      if (!p) { printf("FAIL: grow realloc to %d\n", new_sz); return 1; }
      // Verify old data
      int i = 0;
      while (i < old_sz) {
        char expected = (char)(42 + i);
        if (p[i] != expected) {
          printf("FAIL: grow realloc data at %d (size %d->%d): got %d, expected %d\n",
                 i, old_sz, new_sz, p[i], expected);
          return 1;
        }
        i = i + 1;
      }
      // Fill new area
      while (i < new_sz) {
        p[i] = (char)(42 + i);
        i = i + 1;
      }
      si = si + 1;
    }
    // Final verification
    int i = 0;
    while (i < 2048) {
      if (p[i] != (char)(42 + i)) {
        printf("FAIL: final verify at %d\n", i);
        return 1;
      }
      i = i + 1;
    }
    free(p);
    printf("growing realloc chain: PASS\n");
  }

  // === Shrinking realloc chain - data should be preserved ===
  {
    char *p = (char *)malloc(1024);
    if (!p) { printf("FAIL: shrink initial\n"); return 1; }
    int i = 0;
    while (i < 1024) { p[i] = (char)(i * 3); i = i + 1; }

    int sizes[] = {512, 256, 128, 64, 32, 16, 8, 1};
    int num_sizes = 8;
    int si = 0;
    while (si < num_sizes) {
      int new_sz = sizes[si];
      p = (char *)realloc(p, new_sz);
      if (!p) { printf("FAIL: shrink realloc to %d\n", new_sz); return 1; }
      // Verify data within new size
      i = 0;
      while (i < new_sz) {
        if (p[i] != (char)(i * 3)) {
          printf("FAIL: shrink realloc data at %d (size %d)\n", i, new_sz);
          return 1;
        }
        i = i + 1;
      }
      si = si + 1;
    }
    free(p);
    printf("shrinking realloc chain: PASS\n");
  }

  // === Oscillating realloc: grow then shrink repeatedly ===
  {
    char *p = (char *)malloc(16);
    if (!p) { printf("FAIL: oscillate initial\n"); return 1; }
    int i = 0;
    while (i < 16) { p[i] = (char)(i + 100); i = i + 1; }

    int round = 0;
    while (round < 20) {
      // Grow to 256
      p = (char *)realloc(p, 256);
      if (!p) { printf("FAIL: oscillate grow round %d\n", round); return 1; }
      // Verify first 16 bytes
      i = 0;
      while (i < 16) {
        if (p[i] != (char)(i + 100)) {
          printf("FAIL: oscillate grow data round %d byte %d\n", round, i);
          return 1;
        }
        i = i + 1;
      }
      // Fill rest
      while (i < 256) { p[i] = (char)(i + round); i = i + 1; }

      // Shrink back to 16
      p = (char *)realloc(p, 16);
      if (!p) { printf("FAIL: oscillate shrink round %d\n", round); return 1; }
      // Verify first 16 bytes (should still be original pattern)
      i = 0;
      while (i < 16) {
        if (p[i] != (char)(i + 100)) {
          printf("FAIL: oscillate shrink data round %d byte %d\n", round, i);
          return 1;
        }
        i = i + 1;
      }
      round = round + 1;
    }
    free(p);
    printf("oscillating realloc: PASS\n");
  }

  // === Realloc with many live pointers ===
  // Realloc one pointer while others are live, verify no corruption
  {
    long ptrs[20];
    int i = 0;
    while (i < 20) {
      ptrs[i] = (long)malloc(32);
      if (!ptrs[i]) { printf("FAIL: multi-live alloc %d\n", i); return 1; }
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < 32) { p[j] = (char)(i * 11 + j); j = j + 1; }
      i = i + 1;
    }

    // Realloc every other pointer to a larger size
    i = 0;
    while (i < 20) {
      ptrs[i] = (long)realloc((void *)ptrs[i], 128);
      if (!ptrs[i]) { printf("FAIL: multi-live realloc %d\n", i); return 1; }
      // Verify original data
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < 32) {
        if (p[j] != (char)(i * 11 + j)) {
          printf("FAIL: multi-live realloc data %d byte %d\n", i, j);
          return 1;
        }
        j = j + 1;
      }
      i = i + 2;
    }

    // Verify non-realloced pointers are intact
    i = 1;
    while (i < 20) {
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < 32) {
        if (p[j] != (char)(i * 11 + j)) {
          printf("FAIL: multi-live intact %d byte %d\n", i, j);
          return 1;
        }
        j = j + 1;
      }
      i = i + 2;
    }

    i = 0;
    while (i < 20) { free((void *)ptrs[i]); i = i + 1; }
    printf("realloc with live pointers: PASS\n");
  }

  printf("ALL TESTS PASSED\n");
  return 0;
}
