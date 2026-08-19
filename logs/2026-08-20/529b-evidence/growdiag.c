#include <stdio.h>
#include <stdlib.h>
static long heap_used(void) { struct __heap_info h; __inspect_heap(&h); return h.total_bytes - h.free_bytes; }
static long heap_total(void) { struct __heap_info h; __inspect_heap(&h); return h.total_bytes; }
int main(void) {
    long b = heap_used(), bt = heap_total();
    void *p = malloc(3 * 1024 * 1024);   /* force pool growth, no SDL at all */
    free(p);
    printf("pure-malloc growth: used-delta=%ld total-delta=%ld\n", heap_used() - b, heap_total() - bt);
    return 0;
}
