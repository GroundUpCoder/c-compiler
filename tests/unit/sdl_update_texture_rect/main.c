/* SDL3 conformance: SDL_UpdateTexture honours the rect.
   - rect==NULL updates the whole texture (success).
   - a valid sub-rect succeeds.
   - a rect outside the texture bounds fails with an error set (instead of the
     old behaviour: reading texture->h full rows from a sub-rect buffer = OOB).
   - NULL pixels fails. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *w = SDL_CreateWindow("t", 64, 64, 0);
    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);
    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, 8, 8);

    unsigned char px[8 * 8 * 4];
    for (int i = 0; i < 8 * 8 * 4; i++) px[i] = 0;

    printf("full=%d\n", (int)SDL_UpdateTexture(t, NULL, px, 8 * 4));

    SDL_Rect sub = { 2, 2, 4, 4 };
    printf("sub=%d\n", (int)SDL_UpdateTexture(t, &sub, px, 4 * 4));

    SDL_Rect oob = { 6, 6, 4, 4 };
    SDL_ClearError();
    printf("oob=%d err_nonempty=%d\n", (int)SDL_UpdateTexture(t, &oob, px, 4 * 4), SDL_GetError()[0] != 0);

    SDL_ClearError();
    printf("nullpix=%d\n", (int)SDL_UpdateTexture(t, NULL, NULL, 0));
    return 0;
}
