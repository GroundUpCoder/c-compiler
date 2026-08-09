// BUG: __builtin_trap() was rejected (undeclared identifier) — GNU builtin
// that real-world ports call unconditionally or behind __GNUC__ guards.
// Maps to wasm `unreachable` (same lowering as __builtin_abort). #587.
// EXPECT: prints "before trap" then terminates abnormally at the trap
// (never reaches the line after it); a not-taken branch must not fire.
// clang exits 133 (SIGTRAP) natively; here the wasm trap surfaces as
// exit 1 from the runner — expected.exitcode pins that.
#include <stdio.h>

int main(void) {
    if (0) __builtin_trap();
    printf("before trap\n");
    fflush(stdout);
    __builtin_trap();
    printf("after trap\n");
    return 0;
}
