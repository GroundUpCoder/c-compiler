/* SDL_SetWindowTitle (and the SDL_CreateWindow title) drive document.title.
   Creates a window titled "sdl-title-init", then renames it to
   "sdl-title-changed"; the driver asserts document.title follows. */
#include <SDL.h>

static SDL_Renderer *ren;

static void frame(void) {
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-title-init", 120, 120, 0);
    ren = SDL_CreateRenderer(win, NULL);
    SDL_SetWindowTitle(win, "sdl-title-changed");
    __setAnimationFrameFunc(frame);
    return 0;
}
