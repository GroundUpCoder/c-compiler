#include <stdio.h>

// Forward-declare struct via typedef
typedef struct Foo Foo;

// Use pointer to incomplete type (valid C)
const Foo *ptr;

// Now complete the struct definition
struct Foo {
    int x;
    int y;
};

// This should work — Foo is complete here — but the compiler
// still thinks it's incomplete if it was used via pointer before.
static const Foo f = {1, 2};

int main() {
    printf("%d %d\n", f.x, f.y);
    return 0;
}
