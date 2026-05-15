// Bit-field access through pointers (->).
#include <stdio.h>

struct S {
    unsigned long long a : 40;
    unsigned long long b : 20;
};

static void set_via_ptr(struct S *p, unsigned long long va, unsigned long long vb) {
    p->a = va;
    p->b = vb;
}

static void show_via_ptr(const struct S *p) {
    printf("a=0x%llx b=0x%llx\n",
           (unsigned long long)p->a, (unsigned long long)p->b);
}

int main(void) {
    struct S s;
    set_via_ptr(&s, 0x1234567890ull, 0xABCDE);
    show_via_ptr(&s);

    // Compound op via ->
    struct S *p = &s;
    p->a += 1;
    p->b <<= 4;
    show_via_ptr(p);
    return 0;
}
