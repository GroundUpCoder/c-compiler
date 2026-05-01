// Stress test pool growth: force multiple wasm memory.grow calls
// and verify allocator integrity across growth events.
//
// NOTE: Hits the TLSF mapping bug at malloc(16384) — adjusted=16392
// falls in the FL=10 dead zone where mapping_search and mapping_insert
// disagree on the SL bucket.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
  // === Force multiple pool growths with large allocations ===
  {
    // Each allocation is ~16KB, forcing pool growth
    long ptrs[32];
    int i = 0;
    while (i < 32) {
      ptrs[i] = (long)malloc(16384);
      if (!ptrs[i]) { printf("FAIL: large alloc %d\n", i); return 1; }
      // Fill with pattern
      memset((void *)ptrs[i], i + 1, 16384);
      i = i + 1;
    }

    // Verify all data
    i = 0;
    while (i < 32) {
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < 16384) {
        if ((unsigned char)p[j] != ((i + 1) & 0xFF)) {
          printf("FAIL: large verify block %d byte %d\n", i, j);
          return 1;
        }
        j = j + 1;
      }
      i = i + 1;
    }

    // Free all
    i = 0;
    while (i < 32) { free((void *)ptrs[i]); i = i + 1; }

    struct __heap_info info;
    __inspect_heap(&info);
    if (info.free_blocks != 1) {
      printf("FAIL: large alloc coalesce: expected 1, got %ld\n", info.free_blocks);
      return 1;
    }
    printf("large alloc pool growth: PASS\n");
  }

  // === Growth + fragmentation: large allocs interspersed with small ===
  {
    long large_ptrs[16];
    long small_ptrs[16];
    int i = 0;
    while (i < 16) {
      large_ptrs[i] = (long)malloc(8192);
      small_ptrs[i] = (long)malloc(32);
      if (!large_ptrs[i] || !small_ptrs[i]) {
        printf("FAIL: mixed growth alloc %d\n", i);
        return 1;
      }
      memset((void *)large_ptrs[i], 0xAA, 8192);
      memset((void *)small_ptrs[i], 0xBB, 32);
      i = i + 1;
    }

    // Free large blocks (small blocks remain as barriers)
    i = 0;
    while (i < 16) { free((void *)large_ptrs[i]); i = i + 1; }

    // Verify small blocks intact
    i = 0;
    while (i < 16) {
      char *p = (char *)small_ptrs[i];
      int j = 0;
      while (j < 32) {
        if ((unsigned char)p[j] != 0xBB) {
          printf("FAIL: small verify after large free: block %d byte %d\n", i, j);
          return 1;
        }
        j = j + 1;
      }
      i = i + 1;
    }

    // Allocate in the gaps (should reuse freed large blocks)
    i = 0;
    while (i < 16) {
      large_ptrs[i] = (long)malloc(8192);
      if (!large_ptrs[i]) { printf("FAIL: gap refill %d\n", i); return 1; }
      memset((void *)large_ptrs[i], 0xCC, 8192);
      i = i + 1;
    }

    // Free all
    i = 0;
    while (i < 16) { free((void *)large_ptrs[i]); free((void *)small_ptrs[i]); i = i + 1; }
    printf("growth + fragmentation: PASS\n");
  }

  // === Realloc across pool growth ===
  // Start small, realloc to increasingly large sizes, forcing growth
  {
    char *p = (char *)malloc(16);
    if (!p) { printf("FAIL: realloc growth initial\n"); return 1; }
    int i = 0;
    while (i < 16) { p[i] = (char)(i + 10); i = i + 1; }

    int sz = 32;
    while (sz <= 65536) {
      char *np = (char *)realloc(p, sz);
      if (!np) { printf("FAIL: realloc growth to %d\n", sz); return 1; }
      p = np;
      // Verify first 16 bytes
      i = 0;
      while (i < 16) {
        if (p[i] != (char)(i + 10)) {
          printf("FAIL: realloc growth data at %d (size %d)\n", i, sz);
          return 1;
        }
        i = i + 1;
      }
      // Fill new area
      while (i < sz) { p[i] = (char)(i & 0xFF); i = i + 1; }
      sz = sz * 2;
    }
    free(p);
    printf("realloc across growth: PASS\n");
  }

  printf("ALL TESTS PASSED\n");
  return 0;
}
