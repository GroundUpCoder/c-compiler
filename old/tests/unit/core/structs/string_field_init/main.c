// Tests initializing char[] fields in structs with string literals.
// The string data must be stored inline (copied into the struct),
// NOT as a pointer to the string literal.
#include <stdio.h>

struct Entry {
    char name[9];
    int value;
};

struct Pair {
    char a[9];
    char b[9];
    short tag;
};

// Global struct with string literal field
struct Entry g_entry = {"hello", 42};

// Global array of structs with string literal fields
struct Pair g_pairs[] = {
    {"SW1BRCOM", "SW2BRCOM", 1},
    {"SW1BRN1",  "SW2BRN1",  2},
    {"\0",       "\0",       0},
};

int main() {
    // Check global struct
    printf("g_entry: name='%s' value=%d\n", g_entry.name, g_entry.value);

    // Check global array of structs
    int i;
    for (i = 0; i < 3; i++) {
        printf("g_pairs[%d]: a='%s' b='%s' tag=%d\n",
               i, g_pairs[i].a, g_pairs[i].b, g_pairs[i].tag);
    }

    // Check that the string data is inline (not a pointer)
    // by verifying the address is within the struct
    char *base = (char *)&g_pairs[0];
    char *name_addr = g_pairs[0].a;
    long offset = name_addr - base;
    printf("offset of a in Pair: %ld\n", offset);
    printf("sizeof(struct Pair): %ld\n", (long)sizeof(struct Pair));

    // Local struct with string literal field
    struct Entry local = {"world", 99};
    printf("local: name='%s' value=%d\n", local.name, local.value);

    // Verify mutation works (proves it's a copy, not a pointer to static data)
    local.name[0] = 'W';
    printf("mutated: name='%s'\n", local.name);

    return 0;
}
