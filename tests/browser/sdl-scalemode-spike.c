/* SDL_SetTextureScaleMode end-to-end. Creates a sharp 8×8 checkerboard texture
   (alternating black/red pixels), then renders it at 200×200 twice side by side:
     left  — SDL_SCALEMODE_NEAREST (pixels remain crisp)
     right — SDL_SCALEMODE_LINEAR  (pixels blur together)
   sdl-scalemode-renders.mjs asserts the left shows pure red/black blocks and the
   right shows blended colours. Callback model (no JSPI). */
#include <SDL.h>
#include <stdlib.h>

static SDL_Renderer *ren;
static SDL_Texture *nearTex, *linTex;
static int ready = 0;

static void frame(void) {
    if (!ready) return;
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);

    /* left half: nearest — sharp 200×200 checkerboard */
    SDL_FRect dstNear = { 10.0f, 140.0f, 200.0f, 200.0f };
    SDL_RenderTexture(ren, nearTex, NULL, &dstNear);

    /* right half: linear — blurred 200×200 checkerboard */
    SDL_FRect dstLin = { 430.0f, 140.0f, 200.0f, 200.0f };
    SDL_RenderTexture(ren, linTex, NULL, &dstLin);

    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-scalemode", 640, 480, 0);
    ren = SDL_CreateRenderer(win, NULL);

    nearTex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 8, 8);
    linTex  = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 8, 8);

    /* 8×8 checkerboard: black (0,0,0) and red (255,0,0) */
    unsigned char px[8 * 8 * 4];
    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            int i = (y * 8 + x) * 4;
            int on = (x + y) & 1;   /* checkerboard */
            px[i + 0] = on ? 255 : 0;   /* R */
            px[i + 1] = 0;              /* G */
            px[i + 2] = 0;              /* B */
            px[i + 3] = 255;            /* A */
        }
    }
    SDL_UpdateTexture(nearTex, NULL, px, 8 * 4);
    SDL_UpdateTexture(linTex,  NULL, px, 8 * 4);

    SDL_SetTextureScaleMode(nearTex, SDL_SCALEMODE_NEAREST);  /* pixel art */
    SDL_SetTextureScaleMode(linTex,  SDL_SCALEMODE_LINEAR);    /* blurry */

    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
