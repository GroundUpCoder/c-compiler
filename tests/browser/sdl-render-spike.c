/* SDL_Renderer on WebGPU: clears dark blue, draws a pink texture sprite in the
   center and a green filled rect in the top-left. Callback model (no JSPI).
   Drives sdl-render-renders.mjs (Playwright pixel checks). */
#include <SDL.h>
#include <stdlib.h>

static SDL_Renderer *ren;
static SDL_Texture *tex;
static int ready = 0;

static void frame(void) {
    if (!ready) return;
    SDL_SetRenderDrawColor(ren, 26, 38, 89, 255);   /* dark blue clear */
    SDL_RenderClear(ren);

    SDL_FRect dst = { 220.0f, 140.0f, 200.0f, 200.0f };
    SDL_RenderTexture(ren, tex, NULL, &dst);         /* pink sprite, centered */

    SDL_SetRenderDrawColor(ren, 40, 220, 60, 255);   /* green */
    SDL_FRect g = { 40.0f, 40.0f, 80.0f, 80.0f };
    SDL_RenderFillRect(ren, &g);

    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-render", 640, 480, 0);
    ren = SDL_CreateRenderer(win, NULL);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 64, 64);

    /* fill the texture with pink (255, 51, 204) */
    unsigned char *px = (unsigned char *)malloc(64 * 64 * 4);
    for (int i = 0; i < 64 * 64; i++) {
        px[i * 4 + 0] = 255;
        px[i * 4 + 1] = 51;
        px[i * 4 + 2] = 204;
        px[i * 4 + 3] = 255;
    }
    SDL_UpdateTexture(tex, NULL, px, 64 * 4);
    free(px);

    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
