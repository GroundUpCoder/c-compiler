/* SDL3 texture scale mode: SDL_SetTextureScaleMode / SDL_GetTextureScaleMode.
   Headless contract (no GPU): the per-texture scale mode round-trips through the
   host, defaults to SDL_SCALEMODE_LINEAR (SDL3's default), is independent per
   texture, and the setters return true. The actual sampler behaviour (pixel-art
   crispness vs. blur, incl. changing the mode AFTER first present) is covered by
   the Chromium + real-Safari pixel tests in tests/browser/. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("scale", 64, 64, 0);
    SDL_Renderer *ren = SDL_CreateRenderer(win, NULL);
    SDL_Texture *a = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 4, 4);
    SDL_Texture *b = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 4, 4);

    SDL_ScaleMode m;
    SDL_GetTextureScaleMode(a, &m);
    printf("a_default=%d\n", (int)m);                 /* LINEAR=1 */

    int set_ret = (int)SDL_SetTextureScaleMode(a, SDL_SCALEMODE_NEAREST);
    SDL_GetTextureScaleMode(a, &m);
    printf("set_ret=%d a_nearest=%d\n", set_ret, (int)m);

    SDL_GetTextureScaleMode(b, &m);                   /* b is independent of a */
    printf("b_default=%d\n", (int)m);

    SDL_SetTextureScaleMode(a, SDL_SCALEMODE_LINEAR); /* toggle a back */
    SDL_GetTextureScaleMode(a, &m);
    printf("a_linear=%d\n", (int)m);

    SDL_SetTextureScaleMode(b, SDL_SCALEMODE_NEAREST);
    SDL_GetTextureScaleMode(b, &m);
    printf("b_nearest=%d\n", (int)m);

    return 0;
}
