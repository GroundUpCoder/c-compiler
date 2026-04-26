/* Bug: unsigned int → unsigned long long sign-extends instead of zero-extends.
 * 0xFFFFFFFF (unsigned int) should become 0x00000000FFFFFFFF (unsigned long long),
 * not 0xFFFFFFFFFFFFFFFF. */
#include <stdio.h>

int main(void) {
    unsigned int u32 = 0xFFFFFFFF;
    unsigned long long u64 = u32;

    /* Cast should zero-extend */
    if (u64 != 0x00000000FFFFFFFFULL) {
        printf("FAIL: (ull)0xFFFFFFFF = 0x%llx, expected 0xFFFFFFFF\n", u64);
        return 1;
    }

    /* Binary op should promote with zero-extend */
    unsigned long long big = 0xDEADBEEFCAFEBABEULL;
    unsigned long long masked = big & u32;
    if (masked != 0xCAFEBABEULL) {
        printf("FAIL: big & u32 = 0x%llx, expected 0xCAFEBABE\n", masked);
        return 1;
    }

    /* Literal 0xFFFFFFFF has type unsigned int (32-bit); same issue */
    unsigned long long from_lit = 0xFFFFFFFF;
    if (from_lit != 0x00000000FFFFFFFFULL) {
        printf("FAIL: ull = 0xFFFFFFFF -> 0x%llx\n", from_lit);
        return 1;
    }

    /* Explicit cast */
    unsigned long long casted = (unsigned long long)0xFFFFFFFF;
    if (casted != 0x00000000FFFFFFFFULL) {
        printf("FAIL: (ull)0xFFFFFFFF = 0x%llx\n", casted);
        return 1;
    }

    /* Signed int -1 SHOULD sign-extend to 0xFFFFFFFFFFFFFFFF */
    int si = -1;
    unsigned long long from_signed = (unsigned long long)si;
    if (from_signed != 0xFFFFFFFFFFFFFFFFULL) {
        printf("FAIL: (ull)(int)-1 = 0x%llx\n", from_signed);
        return 1;
    }

    printf("PASS\n");
    return 0;
}
