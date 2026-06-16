#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

int main(void) {
    size_t n = 4096;
    char *p = mmap(0, n, PROT_READ | PROT_WRITE, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
    printf("ok=%d\n", p != MAP_FAILED);
    printf("zeroed=%d\n", p[0] == 0 && p[n - 1] == 0);   /* calloc-backed */
    strcpy(p, "hello mmap");
    printf("rw=%s\n", p);
    printf("munmap=%d\n", munmap(p, n));

    /* file-backed mmap is unsupported */
    char *q = mmap(0, n, PROT_READ, MAP_PRIVATE, 3, 0);
    printf("filebacked_failed=%d\n", q == MAP_FAILED);

    /* zero length is invalid */
    char *z = mmap(0, 0, PROT_READ, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
    printf("zerolen_failed=%d\n", z == MAP_FAILED);

    printf("mprotect=%d msync=%d\n", mprotect(0, 0, 0), msync(0, 0, 0));
    return 0;
}
