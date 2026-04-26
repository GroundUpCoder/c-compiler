// Test that corrupting a free block's free-list pointers is detected
// by the safe unlinking check in remove_free_block.
//
// Strategy:
//   1. Allocate blocks with guards between them to prevent merging
//   2. Free two non-adjacent blocks so they sit in the same size-class free list
//   3. Corrupt one block's next_free pointer
//   4. malloc triggers remove_free_block on the corrupted block
//   5. Safe unlinking detects the inconsistency and traps

#include <stdlib.h>
#include <stdio.h>

int main() {
    // Allocate with guards to prevent physical merging on free
    long *a = (long *)malloc(16);
    long *guard1 = (long *)malloc(16);
    long *b = (long *)malloc(16);
    long *guard2 = (long *)malloc(16);

    // Suppress unused warnings
    (void)guard1;
    (void)guard2;

    // Zero out guard2's payload so the prev_free read returns 0
    guard2[0] = 0;
    guard2[1] = 0;
    guard2[2] = 0;
    guard2[3] = 0;

    free(a);
    free(b);
    // Free list for this size class: b -> a
    // b->next_free = a_block, a->prev_free = b_block

    // Corrupt b's next_free pointer. For a free block, next_free is stored
    // at the payload start (block + 8 = the address malloc returned).
    // Point it to guard2 instead of a_block.
    *b = (long)guard2;

    // malloc(16) finds b (the head) and calls remove_free_block(b).
    // The safe unlinking check reads prev_free from the corrupted next
    // pointer target and finds it doesn't point back to b. Trap.
    long *d = (long *)malloc(16);

    // Should never reach here.
    printf("ERROR: corruption was not detected (d=%p)\n", d);
    return 0;
}
