/* Regression: exact parse_index structure - static, goto done, macro, etc. */

#include <stdio.h>
#include <stdlib.h>

typedef struct { char *ptr; size_t asize; size_t size; } gstr;

struct header { unsigned int a,b,c; };

static int parse(const char *buffer, size_t buffer_size) {
    int error = 0;
    unsigned int i;
    struct header hdr = { 0 };
    unsigned char csum[32];
    unsigned char zero[32] = { 0 };
    size_t cs_size = 20;
    const char *last = (void*)0;
    const char *empty = "";

#define seek_forward(n) { \
    if ((n) >= buffer_size) { error = -1; goto done; } \
    buffer += (n); buffer_size -= (n); }

    seek_forward(12);
    (void)i; (void)hdr; (void)csum; (void)zero; (void)cs_size;
    (void)last; (void)empty;

#undef seek_forward
done:
    return error;
}

int main(void) {
    gstr buffer = { (void*)0, 0, 0 };
    buffer.ptr = (char*)malloc(128);
    buffer.asize = 128;
    buffer.size = 32;
    char *saved = buffer.ptr;

    printf("before: buffer.ptr=%p asize=%zu size=%zu\n",
           (void*)buffer.ptr, buffer.asize, buffer.size);
    int r = parse(buffer.ptr, buffer.size);
    printf("parse -> %d\n", r);
    printf("after:  buffer.ptr=%p asize=%zu size=%zu\n",
           (void*)buffer.ptr, buffer.asize, buffer.size);

    if (buffer.ptr != saved) {
        printf("FAIL: buffer.ptr corrupted %p -> %p\n",
               (void*)saved, (void*)buffer.ptr);
        return 1;
    }
    free(buffer.ptr);
    printf("PASS\n");
    return 0;
}
