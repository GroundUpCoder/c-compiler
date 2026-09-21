#include <SDL.h>
#include <assert.h>

int main(void) {
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window *w = SDL_CreateWindow("batch", 32, 8, SDL_WINDOW_HIDDEN);
    SDL_Renderer *r = SDL_CreateRenderer(w, "software");
    assert(r);
    SDL_SetRenderDrawColor(r, 0, 0, 0, 255);
    SDL_RenderClear(r);
    SDL_Texture *t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 1, 1);
    unsigned char white[] = {255,255,255,255}, blue[] = {0,0,255,255};
    SDL_UpdateTexture(t, NULL, white, 4);
    SDL_SetTextureColorMod(t, 255, 0, 0);
    SDL_FRect rect = {0,0,4,8};
    for (int i = 0; i < 40; i++) SDL_RenderTexture(r, t, NULL, &rect);
    SDL_SetTextureColorMod(t, 0, 255, 0);
    rect.x = 4; SDL_RenderTexture(r, t, NULL, &rect);
    SDL_UpdateTexture(t, NULL, blue, 4);
    SDL_SetTextureColorMod(t, 255, 255, 255);
    rect.x = 8; SDL_RenderTexture(r, t, NULL, &rect);

    SDL_Texture *target = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, 4, 8);
    SDL_SetRenderTarget(r, target);
    SDL_SetRenderDrawColor(r, 0, 255, 255, 255);
    SDL_FRect full = {0,0,4,8}; SDL_RenderFillRect(r, &full);
    SDL_SetRenderTarget(r, NULL);
    rect.x = 12; SDL_RenderTexture(r, target, NULL, &rect);
    SDL_Rect clip = {16,0,2,8}; SDL_SetRenderClipRect(r, &clip);
    SDL_SetRenderDrawColor(r, 255,255,255,255);
    rect.x = 16; SDL_RenderFillRect(r, &rect);
    SDL_SetRenderClipRect(r, NULL);

    SDL_UpdateTexture(t, NULL, white, 4);
    SDL_SetTextureColorMod(t, 255,0,0);
    rect.x = 20; SDL_RenderTexture(r, t, NULL, &rect);
    /* Explicit geometry colors must not receive texture modulation. */
    SDL_Vertex v[6] = {
        {{24,0},{0,0,1,1},{0,0}}, {{28,0},{0,0,1,1},{1,0}}, {{28,8},{0,0,1,1},{1,1}},
        {{24,0},{0,0,1,1},{0,0}}, {{28,8},{0,0,1,1},{1,1}}, {{24,8},{0,0,1,1},{0,1}}
    };
    assert(SDL_RenderGeometry(r,t,v,6,NULL,0));
    SDL_SetTextureColorMod(t,255,255,0);
    rect.x = 28; SDL_RenderTexture(r,t,NULL,&rect);
    SDL_DestroyTexture(t); /* Flush before releasing the source. */
    SDL_RenderPresent(r);
    SDL_DestroyTexture(target);
    SDL_DestroyRenderer(r);
    SDL_DestroyWindow(w);
    SDL_Quit();
    return 0;
}
