/* Keycode delivery for shifted letters — pins SDL3 semantics. SDL3 keycodes
   are MODIFIER-APPLIED (SDL_GetKeyFromScancode(scancode, modstate, true)):
   Shift+A must deliver key = SDLK_A ('A' = 65) with SDL_KMOD_SHIFT set, and
   plain a delivers SDLK_A's lowercase sibling 'a' (97). This differs from
   SDL2 (which delivered the unshifted keysym) — a past review "fixed" this
   host to SDL2 semantics; todos/SDL3.md documents why that was a false
   positive. Paints by the last KEY_DOWN:
     key 'A' + shift → green   (correct SDL3 shifted delivery)
     key 'a' + shift → red     (SDL2 semantics — the wrong "fix")
     key 'a' no shift → blue   (plain baseline)
     any other key    → yellow
   sdl-shifted-keysym-check.mjs presses 'a' (expect blue) then Shift+A
   (expect green). */
#include <SDL.h>

static SDL_Renderer *ren;
static int ready = 0;
static int color = 0;

static void frame(void) {
    if (!ready) return;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN) {
            int shift = (e.key.mod & SDL_KMOD_SHIFT) != 0;
            if (e.key.key == 'A' && shift)      color = 1;  /* SDL3-correct */
            else if (e.key.key == 'a' && shift) color = 2;  /* SDL2 semantics: wrong */
            else if (e.key.key == 'a')          color = 3;  /* plain baseline */
            else                                color = 4;
        }
    }
    if (color == 1)      SDL_SetRenderDrawColor(ren, 0, 220, 0, 255);
    else if (color == 2) SDL_SetRenderDrawColor(ren, 220, 0, 0, 255);
    else if (color == 3) SDL_SetRenderDrawColor(ren, 0, 0, 220, 255);
    else if (color == 4) SDL_SetRenderDrawColor(ren, 220, 220, 0, 255);
    else                 SDL_SetRenderDrawColor(ren, 20, 20, 20, 255);
    SDL_RenderClear(ren);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-shifted-keysym", 320, 240, 0);
    ren = SDL_CreateRenderer(win, NULL);
    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
