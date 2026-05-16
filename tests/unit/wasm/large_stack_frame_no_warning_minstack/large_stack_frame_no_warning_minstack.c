// Same big-frame function as large_stack_frame_warning, but with
// __minstack(N) bumping the stack so the frame no longer exceeds it.
// Should compile with no warning, AND the function can now actually
// be called safely.
#include <stdio.h>
#include <string.h>

__minstack(256 * 1024);

char big_buffer_function(int x) {
    char huge[70000];
    huge[0] = (char)x;
    huge[69999] = (char)(x + 1);
    return huge[0] + huge[69999];
}

int main(void) {
    // Now safe to call — and we do, so the stack bump is also
    // exercised at runtime, not just at compile-time.
    char r = big_buffer_function(7);
    printf("%d\n", (int)r);
    return 0;
}
