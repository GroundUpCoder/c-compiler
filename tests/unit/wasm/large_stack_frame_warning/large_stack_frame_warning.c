// A function with a stack frame larger than the default WASM stack
// (1 page = 65536 bytes) must produce a -Wlarge-stack-frame warning.
// This is the warning that would have saved an hour debugging the
// Quake port (COM_LoadPackFile's dpackfile_t info[2048] = 128 KB).
//
// The test verifies the warning message format and confirms compilation
// still produces a working binary — the warning is advisory, not fatal.
#include <stdio.h>

// 64 KB + a bit, so the aligned frame is just over a page.
char big_buffer_function(int x) {
    char huge[70000];
    huge[0] = (char)x;
    huge[69999] = (char)(x + 1);
    return huge[0] + huge[69999];
}

int main(void) {
    // We never actually call big_buffer_function — the warning fires at
    // compile time, and the warning's whole point is that calling it
    // *would* trap. Just print so the test has stdout to match.
    printf("ok\n");
    return 0;
}
