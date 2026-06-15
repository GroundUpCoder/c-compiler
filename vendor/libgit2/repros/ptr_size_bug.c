/* Regression test: 32-bit pointer size causes struct layout mismatch
   when compiling code written for 64-bit targets.

   The c-compiler produces 32-bit WASM where sizeof(void*) = 4.
   Code written for 64-bit assumes sizeof(void*) = 8, sizeof(long) = 8.
   This causes struct layouts to diverge, corrupting linked lists.

   In libgit2's pool allocator (pool.c), the struct git_pool_page has:
     struct git_pool_page *next;  // pointer
     size_t size;                  // pointer-sized
     size_t avail;                 // pointer-sized
     char data[GIT_FLEX_ARRAY];   // flexible array

   On 64-bit: header = 24 bytes (8+8+8), data starts at offset 24
   On 32-bit: header = 12 bytes (4+4+4), data starts at offset 12

   When 64-bit-targeted code writes pool entry data starting at offset 24,
   it overflows the 32-bit allocation by 12 bytes, corrupting the next
   pool page's 'next' pointer. pool_clear() then follows the corrupted
   pointer and passes garbage to free(), triggering the bounds check. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Simulated page header — what the c-compiler actually lays out (32-bit) */
struct page {
    struct page *next;   /* 4 bytes (32-bit pointer) */
    unsigned long size;   /* 4 bytes (32-bit long) */
    unsigned long avail;  /* 4 bytes (32-bit long) */
    char data[1];         /* 1 byte  (GIT_FLEX_ARRAY fallback) */
};

/* Hardcoded sizes matching the two architectures */
#define HEADER_SZ_32  ((size_t)(&((struct page *)0)->data))
#define HEADER_SZ_64  24   /* what 64-bit-targeted code expects */
#define PAGE_DATA_SZ  128  /* small page for demonstration */

int main(void) {
    printf("sizeof(void*) = %zu (expect 4 for this compiler)\n", sizeof(void*));
    printf("sizeof(long)  = %zu (expect 4 for this compiler)\n", sizeof(long));
    printf("struct page header: compiler says %zu, 64-bit code says %zu\n",
           HEADER_SZ_32, HEADER_SZ_64);

    if (HEADER_SZ_32 >= HEADER_SZ_64) {
        printf("PASS: no mismatch (32-bit header >= 64-bit header)\n");
        return 0;
    }
    printf("MISMATCH: 64-bit header is %zu bytes larger\n", HEADER_SZ_64 - HEADER_SZ_32);
    printf("This bug causes heap corruption in pool allocators.\n");

    /* Demonstrate the corruption:
       - Allocate two pages using 32-bit sizes (what the compiler actually does)
       - But write data at the 64-bit offset (what 64-bit-targeted code does)
       - This overwrites the next page's header, corrupting its 'next' pointer */

    printf("\n=== Reproducing the corruption ===\n");

    /* Allocate two consecutive pages using the compiler's 32-bit sizes */
    size_t alloc_sz = HEADER_SZ_32 + PAGE_DATA_SZ;
    struct page *page1 = (struct page *)malloc(alloc_sz);
    struct page *page2 = (struct page *)malloc(alloc_sz);

    if (!page1 || !page2) {
        printf("FAIL: malloc returned NULL\n");
        return 1;
    }

    memset(page1, 0, alloc_sz);
    memset(page2, 0, alloc_sz);

    /* Set up the linked list the way 32-bit code would */
    page1->next = page2;
    page2->next = NULL;
    page1->size = PAGE_DATA_SZ;
    page2->size = PAGE_DATA_SZ;

    printf("page1=%p  page1->next=%p\n", (void*)page1, (void*)page1->next);
    printf("page2=%p  page2->next=%p\n", (void*)page2, (void*)page2->next);

    /* Now simulate what 64-bit-targeted code does:
       It writes PAGE_DATA_SZ bytes of payload data starting at
       page1 + HEADER_SZ_64 (offset 24).
       But the actual 'data' starts at page1 + HEADER_SZ_32 (offset 12).
       The 64-bit write overflows by 12 bytes into page2's header! */
    size_t overflow = HEADER_SZ_64 - HEADER_SZ_32;
    printf("Writing at 64-bit data offset (%zu) overflows by %zu bytes\n",
           HEADER_SZ_64, overflow);

    char *where_64bit_writes = (char*)page1 + HEADER_SZ_64;
    char *where_data_actually_is = (char*)page1 + HEADER_SZ_32;

    printf("64-bit code writes to:  %p\n", (void*)where_64bit_writes);
    printf("Actual data is at:      %p\n", (void*)where_data_actually_is);
    printf("page2 header starts at: %p\n", (void*)page2);
    printf("Overflow reaches into page2: +%zu bytes\n",
           (size_t)(where_64bit_writes - (char*)page2));

    /* Do the overflowing write (simulating 64-bit pool entry writes) */
    memset(where_64bit_writes, 0x42, PAGE_DATA_SZ);

    /* page2's 'next' pointer has now been corrupted */
    printf("page2->next after corruption: %p (was %p)\n",
           (void*)page2->next, (void*)page2);

    /* When pool_clear() follows page1->next to free page2,
       it reads the corrupted pointer. The next iteration tries to
       free() the garbage value, which triggers the BAD POINTER check. */

    /* Verify corruption happened */
    if (page2->next != NULL) {
        printf("CORRUPTION CONFIRMED: page2->next is no longer NULL\n");
        printf("pool_clear() would follow this garbage pointer to free()\n");
        printf("-> free() would detect an out-of-bounds pointer\n");
    } else {
        printf("No corruption detected (overflow may not have reached 'next')\n");
    }

    free(page1);
    free(page2);

    printf("\nDONE: This demonstrates the 32/64-bit struct layout mismatch.\n");
    return 0;
}
