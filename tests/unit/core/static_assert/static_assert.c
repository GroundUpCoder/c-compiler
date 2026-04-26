#include <stdio.h>
#include <assert.h>

// File scope _Static_assert
_Static_assert(1, "one should be true");
_Static_assert(sizeof(int) == 4, "int should be 4 bytes");
_Static_assert(sizeof(long) == 4, "long should be 4 bytes (wasm32)");
_Static_assert(sizeof(void*) == 4, "pointer should be 4 bytes (wasm32)");

// Test with expressions
_Static_assert(2 + 2 == 4, "arithmetic should work");
_Static_assert((1 << 3) == 8, "bitwise should work");

// Test in struct scope
struct Foo {
    int x;
    int y;
};
_Static_assert(sizeof(struct Foo) == 8, "struct Foo should be 8 bytes");

// static_assert macro from <assert.h>
static_assert(1, "macro from assert.h");

int main(void) {
    // _Static_assert inside function body
    _Static_assert(1, "inside function");
    _Static_assert(sizeof(char) == 1, "char should be 1 byte");

    // static_assert macro inside function
    static_assert(sizeof(short) == 2, "short should be 2 bytes");

    printf("All static assertions passed!\n");
    return 0;
}
