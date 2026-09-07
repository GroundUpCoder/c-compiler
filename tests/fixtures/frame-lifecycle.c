/* #764: a real visible process traps only after its parent sees the window. */
#include <SDL3/SDL.h>
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static void frame(void) {
    if (access("/tmp/frame-go", F_OK) != 0) return;
#ifdef FRAME_EXIT
    exit(23);
#else
    *(volatile int *)0x7ffffff0 = 1;
#endif
}
int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) return 2;
    if (!SDL_CreateWindow("frame-lifecycle", 120, 80, 0)) return 3;
    puts("FRAME-STARTED");
    emscripten_set_main_loop(frame, 0, 1);
    return 0;
}
