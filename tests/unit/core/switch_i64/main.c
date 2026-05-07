#include <stdio.h>
#include <stdint.h>

uint32_t switch_mismatch(uint64_t type) {
    switch (type) {
        case 1ULL: return 1;
        case 0xFFFFFFFF00000000ULL: return 2;
        default: return 0;
    }
}

int main() {
    printf("%u\n", switch_mismatch(1ULL));
    printf("%u\n", switch_mismatch(0xFFFFFFFF00000000ULL));
    printf("%u\n", switch_mismatch(42ULL));
    return 0;
}
