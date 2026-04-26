/* Bug: initializing a struct member from a struct variable in an
 * initializer list copies wrong data.
 *
 * `struct A a = { 30, b };` where b is a struct B variable should
 * copy b's fields into a.b. Instead, the compiler copies garbage.
 *
 * From GCC torture test: 20020920-1.c
 */
#include <stdio.h>

struct B { int x; int y; };
struct A { int z; struct B b; };

struct A make_a(void) {
    struct B b = { 10, 20 };
    struct A a = { 30, b };
    return a;
}

int main(void) {
    struct A a = make_a();
    printf("z=%d b.x=%d b.y=%d\n", a.z, a.b.x, a.b.y);
    if (a.z != 30 || a.b.x != 10 || a.b.y != 20) {
        return 1;
    }

    /* Also test direct local init */
    struct B b2 = { 100, 200 };
    struct A a2 = { 300, b2 };
    printf("z=%d b.x=%d b.y=%d\n", a2.z, a2.b.x, a2.b.y);
    if (a2.z != 300 || a2.b.x != 100 || a2.b.y != 200) {
        return 1;
    }

    return 0;
}
