/* #790 installed browser fixture: configure identities and frame ownership
   as an SDL app sees them. One RESIZABLE window whose every frame encodes its
   OWN geometry in its fill color (R = w & 255, G = h & 255, B = 0x5A), so a
   screenshot can prove that what is on screen is a whole frame of the
   committed geometry — never a torn or stale one — after resize storms driven
   by wmctl and by frame drags. The same source runs on the software renderer
   (shm transport) and the WebGPU renderer (gpu transport) via argv[1]. */
#define SDL_MAIN_USE_CALLBACKS
#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>
static SDL_Window *win;
static SDL_Renderer *rdr;
static const char *driver;
static int frames, lastW = -1, lastH = -1;
SDL_AppResult SDL_AppInit(void **state, int argc, char **argv) {
    driver = argc > 1 && !strcmp(argv[1], "software") ? "software" : "gucos";
    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("UI frames target", 240, 160, SDL_WINDOW_RESIZABLE);
    if (!win) return SDL_APP_FAILURE;
    rdr = SDL_CreateRenderer(win, driver);
    if (!rdr) return SDL_APP_FAILURE;
    int w, h, pw, ph;
    SDL_GetWindowSize(win, &w, &h);
    SDL_GetWindowSizeInPixels(win, &pw, &ph);
    printf("RENDER-DRIVER %s\n", driver);
    printf("PIXEL-GEOMETRY %d %d %d %d density %.3f scale %.3f\n", w, h, pw, ph,
           SDL_GetWindowPixelDensity(win), SDL_GetWindowDisplayScale(win));
    printf("UI-FRAMES-READY\n"); fflush(stdout);
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *state, SDL_Event *e) {
    if (e->type == SDL_EVENT_QUIT) return SDL_APP_SUCCESS;
    if (e->type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) return SDL_APP_SUCCESS;
    if (e->type == SDL_EVENT_WINDOW_RESIZED) {
        int w, h, pw, ph;
        SDL_GetWindowSize(win, &w, &h);
        SDL_GetWindowSizeInPixels(win, &pw, &ph);
        /* the event and the queries must agree: one geometry, one identity */
        printf("RESIZED %d %d %s\n", e->window.data1, e->window.data2,
               (w == e->window.data1 && h == e->window.data2 && pw == w && ph == h) ? "consistent" : "INCONSISTENT");
        fflush(stdout);
    }
    if (e->type == SDL_EVENT_KEY_DOWN && e->key.key == 'q') return SDL_APP_SUCCESS;
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *state) {
    int w, h;
    SDL_GetWindowSize(win, &w, &h);
    SDL_SetRenderDrawColor(rdr, (Uint8)(w & 255), (Uint8)(h & 255), 0x5A, 255);
    SDL_RenderClear(rdr);
    SDL_RenderPresent(rdr);
    frames++;
    if (w != lastW || h != lastH) {
        lastW = w; lastH = h;
        printf("FRAME-GEOMETRY %d %d frame %d\n", w, h, frames); fflush(stdout);
    }
    return SDL_APP_CONTINUE;
}
void SDL_AppQuit(void *state, SDL_AppResult result) {
    printf("UI-FRAMES-EXIT frames %d\n", frames); fflush(stdout);
}
