#include <stdio.h>
#include <stddef.h>

typedef struct {
    unsigned long format_tag;
    unsigned short num_tables;
    unsigned short search_range;
    unsigned short entry_selector;
    unsigned short range_shift;
    unsigned long offset;
} Header;

/* offsetof in static initializer - must be evaluated at compile time */
static const int offsets[] = {
    offsetof(Header, format_tag),
    offsetof(Header, num_tables),
    offsetof(Header, search_range),
    offsetof(Header, entry_selector),
    offsetof(Header, range_shift),
    offsetof(Header, offset),
};

/* Test offsetof with array member elements (e.g. panose[3]) */
typedef struct {
    unsigned long tag;
    unsigned char data[8];
    unsigned short tail;
} ArrayStruct;

static const int array_offsets[] = {
    offsetof(ArrayStruct, tag),
    offsetof(ArrayStruct, data[0]),
    offsetof(ArrayStruct, data[3]),
    offsetof(ArrayStruct, data[7]),
    offsetof(ArrayStruct, tail),
};

int main(void) {
    for (int i = 0; i < 6; i++)
        printf("%d\n", offsets[i]);
    for (int i = 0; i < 5; i++)
        printf("%d\n", array_offsets[i]);
    return 0;
}
