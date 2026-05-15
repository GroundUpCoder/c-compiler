// Array of structs with 64-bit bit-fields. Each element independent.
#include <stdio.h>

struct S {
    unsigned long long a : 40;
    unsigned long long b : 24;
};

int main(void) {
    struct S arr[4];
    for (int i = 0; i < 4; i++) {
        arr[i].a = 0x1000000000ull + i;
        arr[i].b = i * 17;
    }
    for (int i = 0; i < 4; i++) {
        printf("[%d] a=0x%llx b=%llu\n", i,
               (unsigned long long)arr[i].a, (unsigned long long)arr[i].b);
    }

    // Modify mid; verify rest untouched.
    arr[2].a = 0xDEADBEEFull;
    arr[2].b = 0xFFFFFF;
    for (int i = 0; i < 4; i++) {
        printf("[%d] a=0x%llx b=0x%llx\n", i,
               (unsigned long long)arr[i].a, (unsigned long long)arr[i].b);
    }
    return 0;
}
