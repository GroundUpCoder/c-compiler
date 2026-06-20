/* SDL3 conformance: pixel-format constants + public SDL_Surface layout.
   - SDL_PIXELFORMAT_RGBA32 has a single canonical value == ABGR8888 on
     little-endian (no conflicting redefinition).
   - SDL_GetWindowSurface returns a surface with SDL3's public fields populated
     (flags/format/w/h/pitch/refcount/pixels). */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("rgba8888=0x%08X\n", (unsigned)SDL_PIXELFORMAT_RGBA8888);
    printf("abgr8888=0x%08X\n", (unsigned)SDL_PIXELFORMAT_ABGR8888);
    printf("rgba32=0x%08X\n", (unsigned)SDL_PIXELFORMAT_RGBA32);
    printf("xrgb8888=0x%08X\n", (unsigned)SDL_PIXELFORMAT_XRGB8888);
    printf("rgba32_is_abgr=%d\n", SDL_PIXELFORMAT_RGBA32 == SDL_PIXELFORMAT_ABGR8888);

    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *w = SDL_CreateWindow("t", 320, 240, 0);
    SDL_Surface *s = SDL_GetWindowSurface(w);
    printf("surf w=%d h=%d pitch=%d\n", s->w, s->h, s->pitch);
    printf("surf flags=%u format_is_rgba32=%d refcount=%d pixels_nonnull=%d\n",
           (unsigned)s->flags, s->format == SDL_PIXELFORMAT_RGBA32, s->refcount, s->pixels != NULL);
    return 0;
}
