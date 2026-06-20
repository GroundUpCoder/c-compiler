/* SDL3 conformance: SDL_CreateTexture default blend mode is alpha-aware.
   An alpha-format texture (e.g. RGBA32) defaults to SDL_BLENDMODE_BLEND; a
   non-alpha format (XRGB8888) defaults to SDL_BLENDMODE_NONE. Also exercises the
   SDL_GetTextureBlendMode round-trip. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("alpha_rgba32=%d\n", SDL_ISPIXELFORMAT_ALPHA(SDL_PIXELFORMAT_RGBA32) != 0);
    printf("alpha_rgba8888=%d\n", SDL_ISPIXELFORMAT_ALPHA(SDL_PIXELFORMAT_RGBA8888) != 0);
    printf("alpha_xrgb8888=%d\n", SDL_ISPIXELFORMAT_ALPHA(SDL_PIXELFORMAT_XRGB8888) != 0);

    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *w = SDL_CreateWindow("t", 64, 64, 0);
    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);
    SDL_Texture *ta = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, 8, 8);
    SDL_Texture *tx = SDL_CreateTexture(r, SDL_PIXELFORMAT_XRGB8888, SDL_TEXTUREACCESS_STREAMING, 8, 8);

    SDL_BlendMode bm = (SDL_BlendMode)999;
    SDL_GetTextureBlendMode(ta, &bm); printf("rgba32_default_blend=%d\n", (int)bm);
    SDL_GetTextureBlendMode(tx, &bm); printf("xrgb_default_blend=%d\n", (int)bm);

    SDL_SetTextureBlendMode(ta, SDL_BLENDMODE_ADD);
    SDL_GetTextureBlendMode(ta, &bm); printf("after_set_add=%d\n", (int)bm);
    return 0;
}
