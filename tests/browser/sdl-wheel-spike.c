/* Mouse-wheel sign: SDL_MouseWheelEvent.y is positive when scrolling AWAY from
   the user (up). Paints green on a +y (scroll up) wheel event, red on -y (down).
   sdl-wheel-check.mjs scrolls UP (DOM deltaY < 0) and expects green; the old
   code passed deltaY straight through, so up produced y<0 (red) — inverted. */
#include <SDL.h>

static SDL_Renderer *ren;
static int ready = 0;
static int color = 0;

static void frame(void) {
    if (!ready) return;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_MOUSE_WHEEL) {
            if (e.wheel.y > 0) color = 1;        /* up   */
            else if (e.wheel.y < 0) color = 2;   /* down */
        }
    }
    if (color == 1)      SDL_SetRenderDrawColor(ren, 0, 220, 0, 255);
    else if (color == 2) SDL_SetRenderDrawColor(ren, 220, 0, 0, 255);
    else                 SDL_SetRenderDrawColor(ren, 20, 20, 20, 255);
    SDL_RenderClear(ren);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-wheel", 320, 240, 0);
    ren = SDL_CreateRenderer(win, NULL);
    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
