/* SDL_SetTextureScaleMode changed AFTER the texture's first present — the
   regression test for the bind-group invalidation bug (host.js texBindGroup
   gated rebuild on !t.view, so a mode change once a texture had presented left
   it with a null bind group and it stopped rendering).

   One 8×8 black/red checkerboard texture rendered at 200×200 (25×). The mode is
   flipped LINEAR↔NEAREST every 60 frames (~1s) so a driver sampling on any phase
   catches both states. The driver samples two points per frame:
     - a red-texel CENTRE (must stay red in either mode → proves the texture is
       still drawing at all; pre-fix it went BLACK after the first toggle)
     - a texel BOUNDARY (LINEAR blends → mid red; NEAREST snaps → pure)
   PASS requires observing BOTH a clean LINEAR frame and a clean NEAREST frame.
   Callback model (no JSPI). */
#include <SDL.h>
#include <stdio.h>

static SDL_Renderer *ren;
static SDL_Texture *tex;
static int ready = 0;
static int frames = 0;
static int curMode = 1;   /* LINEAR (SDL3 default) */

static void frame(void) {
    if (!ready) return;
    int want = ((frames / 60) % 2 == 0) ? 1 : 0;   /* LINEAR for 60, NEAREST for 60, … */
    if (want != curMode) {
        SDL_SetTextureScaleMode(tex, want ? SDL_SCALEMODE_LINEAR : SDL_SCALEMODE_NEAREST);
        curMode = want;
        printf("mode=%s\n", want ? "LINEAR" : "NEAREST");
        fflush(stdout);
    }
    frames++;

    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);
    SDL_FRect dst = { 10.0f, 10.0f, 200.0f, 200.0f };
    SDL_RenderTexture(ren, tex, NULL, &dst);
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-scalemode-toggle", 220, 220, 0);
    ren = SDL_CreateRenderer(win, NULL);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 8, 8);

    unsigned char px[8 * 8 * 4];
    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            int i = (y * 8 + x) * 4;
            int on = (x + y) & 1;        /* checkerboard: red where odd */
            px[i + 0] = on ? 255 : 0;    /* R */
            px[i + 1] = 0;               /* G */
            px[i + 2] = 0;               /* B */
            px[i + 3] = 255;             /* A */
        }
    }
    SDL_UpdateTexture(tex, NULL, px, 8 * 4);

    /* First present happens in frame() with the default LINEAR mode; the toggle
       to NEAREST therefore happens AFTER the texture has been materialized —
       exactly the path the bug broke. */
    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
