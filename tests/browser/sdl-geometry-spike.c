/* SDL_RenderGeometry end-to-end: on a black clear, draw
   (1) a NON-textured triangle with per-vertex colors red/green/blue — proving
       gouraud color interpolation across the triangle, and
   (2) an INDEXED, TEXTURED quad (4 verts, 6 indices) sampling a pink texture —
       proving the index path + textured geometry.
   Callback model (no JSPI). Driven by sdl-geometry-renders.mjs. */
#include <SDL.h>
#include <stdlib.h>

static SDL_Renderer *ren;
static SDL_Texture *tex;
static int ready = 0;

static void frame(void) {
    if (!ready) return;
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren);

    /* interpolated RGB triangle (no texture) */
    SDL_Vertex tri[3];
    tri[0].position.x = 320; tri[0].position.y = 80;
    tri[0].color.r = 1; tri[0].color.g = 0; tri[0].color.b = 0; tri[0].color.a = 1;
    tri[0].tex_coord.x = 0; tri[0].tex_coord.y = 0;
    tri[1].position.x = 120; tri[1].position.y = 400;
    tri[1].color.r = 0; tri[1].color.g = 1; tri[1].color.b = 0; tri[1].color.a = 1;
    tri[1].tex_coord.x = 0; tri[1].tex_coord.y = 0;
    tri[2].position.x = 520; tri[2].position.y = 400;
    tri[2].color.r = 0; tri[2].color.g = 0; tri[2].color.b = 1; tri[2].color.a = 1;
    tri[2].tex_coord.x = 0; tri[2].tex_coord.y = 0;
    SDL_RenderGeometry(ren, NULL, tri, 3, NULL, 0);

    /* indexed textured quad (pink), top-left, white vertex color */
    SDL_Vertex q[4];
    float qx[4] = { 30, 150, 150, 30 };
    float qy[4] = { 30, 30, 150, 150 };
    float qu[4] = { 0, 1, 1, 0 };
    float qv[4] = { 0, 0, 1, 1 };
    for (int i = 0; i < 4; i++) {
        q[i].position.x = qx[i]; q[i].position.y = qy[i];
        q[i].tex_coord.x = qu[i]; q[i].tex_coord.y = qv[i];
        q[i].color.r = 1; q[i].color.g = 1; q[i].color.b = 1; q[i].color.a = 1;
    }
    int idx[6] = { 0, 1, 2, 0, 2, 3 };
    SDL_RenderGeometry(ren, tex, q, 4, idx, 6);

    SDL_RenderPresent(ren);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window *win = SDL_CreateWindow("sdl-geometry", 640, 480, 0);
    ren = SDL_CreateRenderer(win, NULL);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 16, 16);

    unsigned char *px = (unsigned char *)malloc(16 * 16 * 4);
    for (int i = 0; i < 16 * 16; i++) {
        px[i * 4 + 0] = 255; px[i * 4 + 1] = 51; px[i * 4 + 2] = 204; px[i * 4 + 3] = 255;
    }
    SDL_UpdateTexture(tex, NULL, px, 16 * 4);
    free(px);

    __setAnimationFrameFunc(frame);
    ready = 1;
    return 0;
}
