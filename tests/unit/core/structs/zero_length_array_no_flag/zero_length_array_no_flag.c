// Without --allow-zero-length-arrays, the legacy GCC `arr[0]` form is
// rejected by the same checks that reject C99 FAM-in-union.
#include <stdint.h>

union u {
    uint8_t  a[0];
    uint16_t b[0];
};

int main(void) { return 0; }
