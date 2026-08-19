#include <SDL.h>
#include <stdio.h>
int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) return 1;
    printf("ticks=%d\n", (int)SDL_GetTicks());
    SDL_Quit();
    return 0;
}
