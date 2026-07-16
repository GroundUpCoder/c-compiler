// BUG: the sizeof OPERATOR read raw type.size, so sizeof(void),
// sizeof(*voidp) and sizeof(function) all evaluated to 0 — even though
// pointer arithmetic already used the GNU stride-1 clamp (G1/todos/0203),
// so `p += sizeof(*p)` on void* silently stayed put. Bug-hunt G21
// (todos/0227).
// C11: 6.5.3.4 (sizeof) + the GNU extension: sizeof(void) == 1 and
// sizeof applied to a function type == 1 (gcc/clang -std=gnu11).
// EXPECT: matches gcc/clang: void/function yield 1; a GNU empty struct
// genuinely yields 0; layout math (struct with void* member) unperturbed.
#include <stdio.h>

int func(int x) { return x; }
struct Empty {};
struct WithPtr { void *p; int i; };

int main(void) {
    void *vp = 0;
    const void *cvp = 0;
    printf("void: %d\n", (int)sizeof(void));
    printf("deref: %d\n", (int)sizeof(*vp));
    printf("cderef: %d\n", (int)sizeof(*cvp));
    printf("func: %d\n", (int)sizeof(func));
    printf("empty: %d\n", (int)sizeof(struct Empty));
    printf("layout: %d\n", (int)(sizeof(struct WithPtr) == 2 * sizeof(void *)));
    /* sizeof result usable as a constant expression */
    char pad[sizeof(void) + sizeof(func)];
    printf("arr: %d\n", (int)sizeof(pad));
    return 0;
}
