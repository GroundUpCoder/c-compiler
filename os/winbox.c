/* winbox.c — the seeded windowed demo (todos/WM.md): a real SDL program
 * whose window is a kernel surface. Run it from the shell:  winbox &
 *
 * Visuals are deliberately deterministic for the browser test
 * (tests/browser/os-wm.mjs) and any agent:
 *   - orange fill, white 4px border
 *   - any KEYDOWN toggles the fill green (and back)
 *   - MOUSE_BUTTON_DOWN paints a black 8x8 square at the click point
 *   - SDL_EVENT_QUIT (the title-bar close box) exits 0
 *   - SDL_EVENT_WINDOW_RESIZED re-fetches the surface and redraws at the
 *     new size (the todos/0019 client-resize acceptance app)
 */
#include <SDL.h>
#include <stdint.h>
#include <stdlib.h>

#define W 240
#define H 160

static SDL_Window *win;
static SDL_Surface *surf;
static int green = 0;
static uint32_t marks[64][2];   /* click points (persistent paint) */
static int nmarks = 0;

static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

static void frame_cb(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN) green = !green;
        else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && nmarks < 64) {
            marks[nmarks][0] = (uint32_t)e.button.x;
            marks[nmarks][1] = (uint32_t)e.button.y;
            nmarks++;
        } else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            surf = SDL_GetWindowSurface(win);   /* re-derive (SDL3 contract) */
        } else if (e.type == SDL_EVENT_QUIT) exit(0);
    }
    int w = surf->w, h = surf->h;
    uint32_t fill = green ? rgb(0, 200, 80) : rgb(255, 140, 0);
    uint32_t border = rgb(255, 255, 255);
    uint32_t *px = (uint32_t *)surf->pixels;
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
            px[y * w + x] = (x < 4 || y < 4 || x >= w - 4 || y >= h - 4) ? border : fill;
    for (int i = 0; i < nmarks; i++) {
        for (int dy = 0; dy < 8; dy++) {
            for (int dx = 0; dx < 8; dx++) {
                int x = (int)marks[i][0] - 4 + dx, y = (int)marks[i][1] - 4 + dy;
                if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = rgb(0, 0, 0);
            }
        }
    }
    SDL_UpdateWindowSurface(win);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("winbox", W, H, 0);
    if (!win) return 3;
    surf = SDL_GetWindowSurface(win);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
