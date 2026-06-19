/* SDL blend modes end-to-end. Four vertical strips; each draws an opaque base
   (204,102,51) with BLENDMODE_NONE, then the SAME semi-transparent overlay
   (102,153,204, a=128) on top with a different blend mode:
     strip 0  NONE  → overlay replaces base      → (102,153,204)
     strip 1  BLEND → src*a + dst*(1-a)          → (153,128,128)
     strip 2  ADD   → src*a + dst                → (255,179,153)  (clamped)
     strip 3  MOD   → src*dst                    → ( 82, 61, 41)
   The four results are far apart, so sdl-blend-renders.mjs can assert each one.
   Callback model (no JSPI). */
#include <SDL.h>

static SDL_Renderer *ren;
static int ready = 0;

static void strip(int i, SDL_BlendMode mode) {
    SDL_FRect rect = { (float)(i * 160), 0.0f, 160.0f, 480.0f };
    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_NONE);
    SDL_SetRenderDrawColor(ren, 204, 102, 51, 255);     /* opaque base */
    SDL_RenderFillRect(ren, &rect);
    SDL_SetRenderDrawBlendMode(ren, mode);
    SDL_SetRenderDrawColor(ren, 102, 153, 204, 128);    /* overlay, a≈0.5 */
    SDL_RenderFillRect(ren, &rect);
}

static void frame(void) {
    if (!ready) return;
    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_NONE);
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);
    strip(0, SDL_BLENDMODE_NONE);
    strip(1, SDL_BLENDMODE_BLEND);
    strip(2, SDL_BLENDMODE_ADD);
    strip(3, SDL_BLENDMODE_MOD);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-blend", 640, 480, 0);
    ren = SDL_CreateRenderer(win, NULL);
    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
