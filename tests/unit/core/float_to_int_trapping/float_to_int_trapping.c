// Opt-in trapping behavior: --trapping-float-conversions makes out-of-
// range float→int conversions trap at runtime (UB-as-crash, matching
// WASM 1.0 spec semantics). Exits non-zero on the trap.
#include <stdio.h>

int main(void) {
    // In-range — succeeds.
    printf("ok %d\n", (int)42.5);
    fflush(stdout);

    // Out-of-range — traps with --trapping-float-conversions.
    int bad = (int)1e16;
    printf("not_reached %d\n", bad);
    return 0;
}
