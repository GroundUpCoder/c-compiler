// Token pasting (##) must work when macro arguments span multiple lines.
// This pattern is used heavily by FreeType's FT_FACE_LOOKUP_SERVICE macro.
#include <stdio.h>

typedef void* Ptr;

typedef struct {
    Ptr field_ALPHA;
    Ptr field_BETA;
} Cache;

#define LOOKUP(cache, ptr, id) \
  do {                         \
    ptr = (cache). field_ ## id; \
  } while (0)

int main() {
    Cache c;
    c.field_ALPHA = (Ptr)42;
    c.field_BETA = (Ptr)99;
    Ptr result;

    // Single-line call (baseline)
    LOOKUP(c, result, ALPHA);
    printf("%d\n", (int)result);

    // Multi-line call — the bug was that BETA on a new line
    // produced "field_\nBETA" instead of "field_BETA"
    LOOKUP(c,
           result,
           BETA);
    printf("%d\n", (int)result);

    return 0;
}
