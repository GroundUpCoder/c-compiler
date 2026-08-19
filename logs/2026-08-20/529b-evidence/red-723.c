#include <SDL.h>
#include <stdio.h>
int main(void) {
    SDL_AudioSpec spec;
    Uint8 *buf = 0;
    Uint32 len = 0;
    if (!SDL_LoadWAV("/tmp/x.wav", &spec, &buf, &len)) {
        printf("load failed: %s\n", SDL_GetError());
        return 1;
    }
    SDL_free(buf);
    return 0;
}
