#include <stdio.h>

struct Inner { int x, y; };
struct Outer { struct Inner a; int b; };

struct Anon { struct { int x, y; }; int z; };

int main() {
    // Chained designators
    struct Outer s1 = { .a.x = 1, .a.y = 2, .b = 3 };
    printf("s1: %d %d %d\n", s1.a.x, s1.a.y, s1.b);

    // Positional after chained designator (advances at inner level)
    struct Outer s2 = { .a.x = 10, 20 };
    printf("s2: %d %d %d\n", s2.a.x, s2.a.y, s2.b);

    // Anonymous member designator
    struct Anon s3 = { .x = 5, .z = 9 };
    printf("s3: %d %d %d\n", s3.x, s3.y, s3.z);

    // Brace elision after designator
    struct Outer s4 = { .a = 1, 2, .b = 3 };
    printf("s4: %d %d %d\n", s4.a.x, s4.a.y, s4.b);

    return 0;
}
