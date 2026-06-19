/* SDL_GetTicks returns a true Uint64 (ms since SDL_Init), not a 32-bit value:
   - sizeof must be 8 (the old impl truncated through Uint32).
   - successive reads are monotonic non-decreasing. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    Uint64 a = SDL_GetTicks();
    Uint64 b = SDL_GetTicks();
    printf("monotonic=%d\n", b >= a);
    printf("sizeof=%d\n", (int)sizeof(SDL_GetTicks()));
    return 0;
}
