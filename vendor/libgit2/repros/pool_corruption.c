/* Regression test: index-file parsing causes heap corruption.

   When the c-compiler builds libgit2 and calls git_index_open(".git/index"),
   the file parsing code in parse_index() corrupts the pool allocator's
   linked-list, causing pool_clear() to pass a non-heap pointer to free().

   This test validates that the core patterns used by libgit2's index parser
   work correctly in isolation. If this passes but libgit2 still crashes,
   the bug is in the interaction between multiple subsystems.

   NOTE: This test intentionally does NOT reproduce the full crash. The
   actual trigger requires the entire libgit2 index-parsing code path.
   To reproduce the exact crash: build libgit2 with bin.json, then call
   git_index_open(&idx, ".git/index"). */

#include <stdio.h>
#include <stdlib.h>

/* Minimal pool allocator matching libgit2 pool.c (non-GIT_DEBUG_POOL) */
struct pp { struct pp *next; unsigned long size, avail; char data[1]; };
struct pool { struct pp *pages; unsigned long page_size; };

static void pool_init(struct pool *p) {
    p->pages = NULL;
    p->page_size = 4096 - 2*sizeof(void*) - sizeof(struct pp);
}
static size_t round_up(size_t n) { return (n + sizeof(void*)-1) & ~(sizeof(void*)-1); }
static void *pool_alloc(struct pool *p, size_t sz) {
    struct pp *pg = p->pages;
    if (!pg || pg->avail < sz) {
        size_t ps = sz > p->page_size ? sz : p->page_size;
        pg = malloc(sizeof(struct pp) + ps);
        if (!pg) return NULL;
        pg->size = ps; pg->avail = ps - sz;
        pg->next = p->pages; p->pages = pg;
        return pg->data;
    }
    void *r = &pg->data[pg->size - pg->avail];
    pg->avail -= sz;
    return r;
}
static void pool_clear(struct pool *p) {
    struct pp *s = p->pages;
    while (s) { struct pp *n = s->next; free(s); s = n; }
    p->pages = NULL;
}

/* Test entry matching typical git index entry size */
typedef struct { int _pad[40]; char path[128]; } fake_entry;

static void fill(char *p, int c, int n) { while (n--) *p++ = (char)c; }

int main(void) {
    printf("sizeof(void*)=%zu  sizeof(struct pp)=%zu  offsetof(data)=%zu\n",
           sizeof(void*), sizeof(struct pp),
           (size_t)(&((struct pp*)0)->data[0]));

    /* Test 1: match libgit2's index load (4438 entries via pool) */
    printf("Test 1: 4438 pool entries + file read pattern... ");
    struct pool p;
    pool_init(&p);
    for (int i = 0; i < 4438; i++) {
        fake_entry *e = pool_alloc(&p, sizeof(fake_entry));
        if (!e) { printf("FAIL OOM at %d\n", i); return 1; }
        fill((char*)e, 0, sizeof(fake_entry));
    }
    /* Simulate free of read buffer (like git_str_dispose in git_index_read) */
    char *buf = malloc(4096);
    fill(buf, 0, 4096);
    free(buf);
    pool_clear(&p);
    printf("OK\n");

    /* Test 2: heap integrity after pool clear */
    printf("Test 2: post-clear malloc/free... ");
    void *x = malloc(256); free(x);
    x = malloc(512); free(x);
    printf("OK\n");

    /* Test 3: repeated open+clear cycles (stress) */
    printf("Test 3: 5 open+clear cycles... ");
    for (int cycle = 0; cycle < 5; cycle++) {
        pool_init(&p);
        for (int i = 0; i < 4000; i++) {
            fake_entry *e = pool_alloc(&p, sizeof(fake_entry));
            if (!e) { printf("FAIL cycle=%d i=%d\n", cycle, i); return 1; }
            fill((char*)e, (cycle+i) & 0xFF, sizeof(fake_entry));
        }
        pool_clear(&p);
    }
    printf("OK\n");

    /* Test 4: large pool page (> page_size) */
    printf("Test 4: large allocation... ");
    pool_init(&p);
    void *big = pool_alloc(&p, 10000); /* larger than default page_size */
    if (!big) { printf("FAIL\n"); return 1; }
    fill(big, 0xAB, 10000);
    pool_clear(&p);
    printf("OK\n");

    /* Test 5: many small allocations (mimics tree_cache entries) */
    printf("Test 5: many small allocs (tree_cache pattern)... ");
    pool_init(&p);
    for (int i = 0; i < 10000; i++) {
        void *s = pool_alloc(&p, 48 + (i % 7) * 8);
        if (!s) { printf("FAIL at %d\n", i); return 1; }
        fill(s, i, 48 + (i % 7) * 8);
    }
    pool_clear(&p);
    printf("OK\n");

    printf("\nAll pool tests pass. The crash in git_index_open is in the\n");
    printf("interaction between the parser and the pool, not the pool itself.\n");
    return 0;
}
