// -Wno-large-stack-frame silences the warning entirely. Same source
// as large_stack_frame_warning, different config.json.
#include <stdio.h>

char big_buffer_function(int x) {
    char huge[70000];
    huge[0] = (char)x;
    huge[69999] = (char)(x + 1);
    return huge[0] + huge[69999];
}

int main(void) {
    // Don't actually call — the function would still trap. The point
    // of the test is the warning's absence.
    printf("ok\n");
    return 0;
}
