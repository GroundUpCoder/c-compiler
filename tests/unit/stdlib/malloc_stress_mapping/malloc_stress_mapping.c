// TLSF mapping_search vs mapping_insert mismatch bug.
//
// Bug: grow_pool(N) creates a block of size N, placed in bucket (fl, sl)
// via mapping_insert. But mapping_search(N) rounds up and searches from
// bucket (fl, sl+1), missing the newly created block. malloc returns NULL.
//
// This affects sizes where the adjusted block size falls in the upper
// portion of a TLSF SL bucket. For FL=k (block sizes 2^(k+4) to
// 2^(k+5)-1), the SL step is 2^k. Sizes where (size mod 2^(k+1))
// is in the range [2^k+1, 2^(k+1)-1] are in the "dead zone".
//
// Concrete examples of affected user-facing malloc sizes:
//   malloc(256)  → adjusted=264  → FL=4, dead zone (SL step=16)
//   malloc(512)  → adjusted=520  → FL=5, dead zone (SL step=32)
//   malloc(4096) → adjusted=4104 → FL=8, dead zone (SL step=256)
//   malloc(16384)→ adjusted=16392→ FL=10, dead zone (SL step=1024)
//
// The bug only manifests when grow_pool is needed (no existing free
// blocks of suitable size). Once an orphaned block exists, subsequent
// grow_pool calls merge with it, often landing in a findable bucket.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
  int fail = 0;

  // === Test 1: malloc(256) on fresh pool ===
  // adjusted=264 is in FL=4 dead zone.
  // mapping_insert(264) → bucket (4, 0)
  // mapping_search(264) → bucket (4, 1)
  // Block created by grow_pool is never found.
  {
    void *p = malloc(256);
    if (!p) {
      printf("FAIL: malloc(256) returned NULL [adj=264, FL=4 dead zone]\n");
      fail = 1;
    } else {
      // Verify it's usable
      memset(p, 0xAA, 256);
      free(p);
    }
  }

  // === Test 2: safe size (start of SL bucket) should work ===
  // malloc(248) → adjusted=256 → at SL boundary, NOT in dead zone
  {
    void *p = malloc(248);
    if (!p) {
      printf("FAIL: malloc(248) returned NULL [adj=256, should be safe]\n");
      fail = 1;
    } else {
      memset(p, 0xBB, 248);
      free(p);
      printf("malloc(248) [safe size]: PASS\n");
    }
  }

  // === Test 3: pattern of increasing allocations ===
  // Allocate blocks without freeing. Sizes that fall in dead zones will fail.
  {
    int sizes[] = {120, 248, 256, 504, 512, 1016, 1024, 2040, 2048, 4088, 4096};
    //             safe  safe  BUG  safe  BUG  safe   BUG  safe   BUG  safe   BUG
    int num = 11;
    long ptrs[11];
    int i = 0;
    while (i < num) {
      ptrs[i] = (long)malloc(sizes[i]);
      if (!ptrs[i]) {
        printf("FAIL: malloc(%d) returned NULL\n", sizes[i]);
        fail = 1;
      } else {
        memset((void *)ptrs[i], i + 1, sizes[i]);
      }
      i = i + 1;
    }
    // Free all that succeeded
    i = 0;
    while (i < num) {
      if (ptrs[i]) free((void *)ptrs[i]);
      i = i + 1;
    }
  }

  // === Test 4: sequential same-dead-zone allocations ===
  // After the first one fails, grow_pool creates an orphaned block.
  // The second alloc merges with it and should succeed.
  {
    void *p1 = malloc(256);
    void *p2 = malloc(256);
    if (!p1 && p2) {
      // First fails, second succeeds (due to orphan merge) — demonstrates the bug
      printf("NOTE: malloc(256) #1=NULL, #2=%ld (orphan merge rescued #2)\n", (long)p2);
    }
    if (p1) free(p1);
    if (p2) free(p2);
  }

  if (fail) {
    printf("SOME TESTS FAILED — TLSF mapping bug confirmed\n");
    return 1;
  }
  printf("ALL TESTS PASSED\n");
  return 0;
}
