// SDL input spike: fills the screen BLUE until it receives any SDL_KEYDOWN,
// then RED forever. graphical-run.spec.ts screenshots before/after a keypress
// and asserts the dominant color flips blue→red — proving DOM input reached the
// program through: window keydown → event port → onSdl → sdl.pushKeyEvent →
// SDL event queue → SDL_PollEvent.
#include <SDL.h>
#include <stdint.h>

#define W 320
#define H 200

static SDL_Window  *win;
static SDL_Surface *surf;
static int got_key;

static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

static void frame_cb(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_KEYDOWN) got_key = 1;
    }
    uint32_t color = got_key ? rgb(230, 40, 40) : rgb(30, 60, 180);
    uint32_t *px = (uint32_t *)surf->pixels;
    for (int i = 0; i < surf->w * surf->h; i++) px[i] = color;
    SDL_UpdateWindowSurface(win);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    win  = SDL_CreateWindow("sdl-input-spike", 0, 0, W, H, 0);
    surf = SDL_GetWindowSurface(win);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
