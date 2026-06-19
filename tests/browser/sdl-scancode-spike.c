/* Scancode delivery: paints by the scancode of the last KEY_DOWN.
     W (SDL_SCANCODE_W = 26) → green
     S (SDL_SCANCODE_S = 22) → blue
     scancode 0 (the OLD bug: letters were unmapped) → red
     any other mapped key      → yellow
   sdl-scancode-check.mjs presses 'w' (expect green) then 's' (expect blue),
   proving letter scancodes are populated with the correct values. */
#include <SDL.h>

static SDL_Renderer *ren;
static int ready = 0;
static int color = 0;

static void frame(void) {
    if (!ready) return;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN) {
            if (e.key.scancode == 26) color = 1;       /* W */
            else if (e.key.scancode == 22) color = 2;  /* S */
            else if (e.key.scancode == 0) color = 3;   /* unmapped → bug */
            else color = 4;
        }
    }
    if (color == 1)      SDL_SetRenderDrawColor(ren, 0, 220, 0, 255);
    else if (color == 2) SDL_SetRenderDrawColor(ren, 0, 0, 220, 255);
    else if (color == 3) SDL_SetRenderDrawColor(ren, 220, 0, 0, 255);
    else if (color == 4) SDL_SetRenderDrawColor(ren, 220, 220, 0, 255);
    else                 SDL_SetRenderDrawColor(ren, 20, 20, 20, 255);
    SDL_RenderClear(ren);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-scancode", 320, 240, 0);
    ren = SDL_CreateRenderer(win, NULL);
    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
