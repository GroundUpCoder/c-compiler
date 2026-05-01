// Comprehensive malloc stress test
// Covers: data integrity, coalescing orders, realloc patterns,
// edge-case sizes, fragmentation, leak detection, alloc storms
#include <stdio.h>
#include <stdlib.h>

int main() {
  // === 1. Data integrity under heavy alloc/free ===
  // 50 blocks of varying sizes, fill with patterns, free odds,
  // verify evens, refill odds, verify all.
  {
    long ptrs[50];
    long sizes[50];
    int i = 0;
    while (i < 50) {
      long sz = 16 + (i * 7) % 128;
      sizes[i] = sz;
      ptrs[i] = (long)malloc(sz);
      if (!ptrs[i]) { printf("FAIL: integrity alloc %d\n", i); return 1; }
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < sz) { p[j] = (char)((i * 37 + j) & 0xFF); j = j + 1; }
      i = i + 1;
    }
    // Free odd-indexed
    i = 1;
    while (i < 50) { free((void *)ptrs[i]); ptrs[i] = 0; i = i + 2; }
    // Verify even-indexed
    i = 0;
    while (i < 50) {
      if (ptrs[i]) {
        char *p = (char *)ptrs[i];
        int j = 0;
        while (j < sizes[i]) {
          if (p[j] != (char)((i * 37 + j) & 0xFF)) {
            printf("FAIL: integrity block %d byte %d\n", i, j); return 1;
          }
          j = j + 1;
        }
      }
      i = i + 2;
    }
    // Refill odd slots with new pattern
    i = 1;
    while (i < 50) {
      long sz = 16 + (i * 13) % 64;
      sizes[i] = sz;
      ptrs[i] = (long)malloc(sz);
      if (!ptrs[i]) { printf("FAIL: integrity refill %d\n", i); return 1; }
      char *p = (char *)ptrs[i];
      int j = 0;
      while (j < sz) { p[j] = (char)((i * 53 + j) & 0xFF); j = j + 1; }
      i = i + 2;
    }
    // Verify all
    i = 0;
    while (i < 50) {
      char *p = (char *)ptrs[i];
      int key = (i % 2 == 0) ? (i * 37) : (i * 53);
      int j = 0;
      while (j < sizes[i]) {
        if (p[j] != (char)((key + j) & 0xFF)) {
          printf("FAIL: integrity final %d byte %d\n", i, j); return 1;
        }
        j = j + 1;
      }
      i = i + 1;
    }
    i = 0;
    while (i < 50) { free((void *)ptrs[i]); i = i + 1; }
    printf("data integrity: PASS\n");
  }

  // === 2. Interleaved coalescing ===
  // Free evens then odds - each odd free should merge with neighbors.
  {
    long ptrs[20];
    int i = 0;
    while (i < 20) {
      ptrs[i] = (long)malloc(32);
      if (!ptrs[i]) { printf("FAIL: coalesce alloc %d\n", i); return 1; }
      i = i + 1;
    }
    i = 0;
    while (i < 20) { free((void *)ptrs[i]); i = i + 2; }
    i = 1;
    while (i < 20) { free((void *)ptrs[i]); i = i + 2; }
    // All should coalesce into one big free region
    char *big = (char *)malloc(600);
    if (!big) { printf("FAIL: coalesce big alloc\n"); return 1; }
    i = 0;
    while (i < 600) { big[i] = (char)(i & 0xFF); i = i + 1; }
    free(big);
    printf("interleaved coalesce: PASS\n");
  }

  // === 3. Triple merge (free middle, then both sides) ===
  {
    char *a = (char *)malloc(64);
    char *b = (char *)malloc(64);
    char *c = (char *)malloc(64);
    char *guard = (char *)malloc(64);
    if (!a || !b || !c || !guard) { printf("FAIL: triple alloc\n"); return 1; }
    free(b);
    free(a);
    free(c);
    char *big = (char *)malloc(180);
    if (!big) { printf("FAIL: triple merge alloc\n"); return 1; }
    int i = 0;
    while (i < 180) { big[i] = (char)(i & 0xFF); i = i + 1; }
    free(big);
    free(guard);
    printf("triple merge: PASS\n");
  }

  // === 4. Realloc grow by 1 byte (1 -> 256) ===
  {
    char *p = (char *)malloc(1);
    if (!p) { printf("FAIL: realloc initial\n"); return 1; }
    p[0] = 'A';
    int i = 2;
    while (i <= 256) {
      p = (char *)realloc(p, i);
      if (!p) { printf("FAIL: realloc to %d\n", i); return 1; }
      int j = 0;
      while (j < i - 1) {
        if (p[j] != (char)('A' + (j % 26))) {
          printf("FAIL: realloc %d byte %d\n", i, j); return 1;
        }
        j = j + 1;
      }
      p[i - 1] = 'A' + ((i - 1) % 26);
      i = i + 1;
    }
    free(p);
    printf("realloc grow-by-1: PASS\n");
  }

  // === 5. Multi-object realloc ===
  {
    long ptrs[10];
    int i = 0;
    while (i < 10) {
      ptrs[i] = (long)malloc(8);
      if (!ptrs[i]) { printf("FAIL: multi alloc %d\n", i); return 1; }
      *(char *)ptrs[i] = 'A' + i;
      i = i + 1;
    }
    int round = 0;
    while (round < 5) {
      i = 0;
      while (i < 10) {
        long new_size = 8 + (round + 1) * 16;
        ptrs[i] = (long)realloc((void *)ptrs[i], new_size);
        if (!ptrs[i]) { printf("FAIL: multi realloc %d r%d\n", i, round); return 1; }
        if (*(char *)ptrs[i] != 'A' + i) {
          printf("FAIL: multi realloc data %d r%d\n", i, round); return 1;
        }
        i = i + 1;
      }
      round = round + 1;
    }
    i = 0;
    while (i < 10) { free((void *)ptrs[i]); i = i + 1; }
    printf("multi-object realloc: PASS\n");
  }

  // === 6. Edge-case sizes ===
  {
    // malloc(0) returns NULL
    if (malloc(0) != (void *)0) { printf("FAIL: malloc(0)\n"); return 1; }

    // Power-of-2 sizes up to 32768, check alignment and usability
    int shift = 0;
    while (shift < 16) {
      long sz = 1L << shift;
      char *p = (char *)malloc(sz);
      if (!p) { printf("FAIL: pow2 malloc(%ld)\n", sz); return 1; }
      if ((long)p % 8 != 0) { printf("FAIL: pow2 align(%ld)\n", sz); return 1; }
      p[0] = 'A';
      if (sz > 1) p[sz - 1] = 'Z';
      free(p);
      shift = shift + 1;
    }

    // Sizes 1-32: alignment + full read/write
    int sz = 1;
    while (sz <= 32) {
      char *p = (char *)malloc(sz);
      if (!p) { printf("FAIL: tiny malloc(%d)\n", sz); return 1; }
      if ((long)p % 8 != 0) { printf("FAIL: tiny align(%d)\n", sz); return 1; }
      int i = 0;
      while (i < sz) { p[i] = (char)(sz + i); i = i + 1; }
      i = 0;
      while (i < sz) {
        if (p[i] != (char)(sz + i)) { printf("FAIL: tiny data(%d)\n", sz); return 1; }
        i = i + 1;
      }
      free(p);
      sz = sz + 1;
    }
    printf("edge sizes: PASS\n");
  }

  // === 7. Checkerboard fragmentation ===
  {
    long ptrs[100];
    int i = 0;
    while (i < 100) {
      ptrs[i] = (long)malloc(32);
      if (!ptrs[i]) { printf("FAIL: checker alloc %d\n", i); return 1; }
      i = i + 1;
    }
    // Free even-indexed (non-adjacent free blocks)
    i = 0;
    while (i < 100) { free((void *)ptrs[i]); ptrs[i] = 0; i = i + 2; }
    // Refill same-size into freed slots
    int count = 0;
    i = 0;
    while (i < 100) {
      if (!ptrs[i]) {
        ptrs[i] = (long)malloc(32);
        if (ptrs[i]) count = count + 1;
      }
      i = i + 2;
    }
    if (count < 40) { printf("FAIL: checker refill %d/50\n", count); return 1; }
    i = 0;
    while (i < 100) { if (ptrs[i]) free((void *)ptrs[i]); i = i + 1; }
    printf("checkerboard: PASS\n");
  }

  // === 8. Worst-case fragmentation (small/large pairs) ===
  {
    long smalls[50];
    long larges[50];
    int i = 0;
    while (i < 50) {
      smalls[i] = (long)malloc(16);
      larges[i] = (long)malloc(128);
      if (!smalls[i] || !larges[i]) { printf("FAIL: pair alloc %d\n", i); return 1; }
      i = i + 1;
    }
    // Free all large blocks (small blocks act as barriers)
    i = 0;
    while (i < 50) { free((void *)larges[i]); i = i + 1; }
    // Allocate 256 bytes - must grow pool since no single gap is big enough
    char *big = (char *)malloc(256);
    if (!big) { printf("FAIL: fragmented big alloc\n"); return 1; }
    i = 0;
    while (i < 256) { big[i] = (char)(i & 0xFF); i = i + 1; }
    free(big);
    i = 0;
    while (i < 50) { free((void *)smalls[i]); i = i + 1; }
    printf("worst-case fragmentation: PASS\n");
  }

  // === 9. Leak detection: alloc/free cycles shouldn't grow heap ===
  {
    struct __heap_info h1;
    struct __heap_info h2;
    void *warm = malloc(64);
    free(warm);
    __inspect_heap(&h1);
    int round = 0;
    while (round < 500) {
      char *p = (char *)malloc(64);
      if (!p) { printf("FAIL: cycle alloc %d\n", round); return 1; }
      p[0] = (char)round;
      free(p);
      round = round + 1;
    }
    __inspect_heap(&h2);
    if (h2.total_bytes > h1.total_bytes + 1024) {
      printf("FAIL: heap leak: %ld -> %ld\n", h1.total_bytes, h2.total_bytes);
      return 1;
    }
    printf("leak detection: PASS\n");
  }

  // === 10. Small alloc storm (500 x 1 byte) ===
  {
    long ptrs[500];
    int i = 0;
    while (i < 500) {
      ptrs[i] = (long)malloc(1);
      if (!ptrs[i]) { printf("FAIL: storm alloc %d\n", i); return 1; }
      *(char *)ptrs[i] = (char)(i & 0xFF);
      i = i + 1;
    }
    i = 0;
    while (i < 500) {
      if (*(char *)ptrs[i] != (char)(i & 0xFF)) {
        printf("FAIL: storm verify %d\n", i); return 1;
      }
      i = i + 1;
    }
    i = 0;
    while (i < 500) { free((void *)ptrs[i]); i = i + 1; }
    printf("small alloc storm: PASS\n");
  }

  // === 11. Calloc zeros across repeated cycles ===
  {
    int round = 0;
    while (round < 100) {
      int *arr = (int *)calloc(10, sizeof(int));
      if (!arr) { printf("FAIL: calloc round %d\n", round); return 1; }
      int i = 0;
      while (i < 10) {
        if (arr[i] != 0) {
          printf("FAIL: calloc not zero r%d i%d val%d\n", round, i, arr[i]);
          return 1;
        }
        arr[i] = round + i;
        i = i + 1;
      }
      arr = (int *)realloc(arr, 20 * sizeof(int));
      if (!arr) { printf("FAIL: calloc realloc r%d\n", round); return 1; }
      i = 0;
      while (i < 10) {
        if (arr[i] != round + i) {
          printf("FAIL: calloc realloc data r%d i%d\n", round, i); return 1;
        }
        i = i + 1;
      }
      free(arr);
      round = round + 1;
    }
    printf("calloc cycles: PASS\n");
  }

  printf("ALL TESTS PASSED\n");
  return 0;
}
