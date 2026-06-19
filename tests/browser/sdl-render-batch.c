/* Renderer batch stress for the reused/grown vertex-buffer path. Draws a 16×16
   grid of solid fill-rects (256 quads = 1536 verts) every frame — enough to grow
   the per-renderer vertex scratch (starts at 512 verts) and the persistent GPU
   vertex buffer past their initial capacity. Each cell's colour encodes its
   coordinates so the driver can verify the per-quad data and the per-entry draw
   offsets survive the in-place NDC transform + single-buffer upload. */
#include <SDL.h>

#define N 16
#define CELL 18   /* window = 288×288 */

static SDL_Renderer *ren;

static void frame(void) {
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);
    for (int j = 0; j < N; j++) {
        for (int i = 0; i < N; i++) {
            SDL_SetRenderDrawColor(ren, (unsigned char)(i * 16), (unsigned char)(j * 16), 128, 255);
            SDL_FRect rect = { (float)(i * CELL + 1), (float)(j * CELL + 1), (float)(CELL - 2), (float)(CELL - 2) };
            SDL_RenderFillRect(ren, &rect);
        }
    }
    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("batch", N * CELL, N * CELL, 0);
    ren = SDL_CreateRenderer(win, NULL);
    __setAnimationFrameFunc(frame);
    return 0;
}
