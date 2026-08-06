/* pollball — the GAMEDEV-EPIC render-loop demo, now the REFERENCE
 * SDL_MAIN_USE_CALLBACKS app (ticket #551; formerly the #484 poll-only
 * acceptance app).
 *
 * A bouncing ball over SDL_Renderer on SDL3's callback main loop —
 * SDL_AppInit / SDL_AppIterate / SDL_AppEvent / SDL_AppQuit, standard SDL3
 * (README-main-functions), portable to desktop SDL3 unchanged. This is THE
 * sanctioned loop model for GPU-presenting gucOS apps: main() returns, the
 * host paces SDL_AppIterate at the compositor's cadence, and the process
 * yields to its event loop between frames, so the browser can recycle every
 * presented GPU frame indefinitely.
 *
 * History (why this app is the reference): its original shape was the most
 * common SDL main loop in existence — while (running) { poll; update;
 * render; present; }, deliberately no SDL_Delay — and that shape is now
 * REFUSED at its first GPU present (#551): a worker blocked in main() never
 * returns to its event loop, the browser's headroom for GPU-frame ships out
 * of such a worker is finite, and exhausting it destroyed the WHOLE
 * desktop's compositor device (measured on #551; #484's producer clamp
 * bounded the rate but no rate outruns a lifetime budget). The refusal
 * regression tests keep the old blocking shape alive as test fixtures
 * (tests/browser/os-loopguard.mjs); this demo demonstrates the model every
 * agent and developer should write instead.
 *
 * Movement is wall-clock based (SDL_GetTicks), not per-frame, so the ball
 * crosses the window at the same speed however fast frames come.
 * ESC or the title-bar close quits; any other key re-colors the ball.
 */
#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
#include <stdio.h>

#define W 320
#define H 240
#define BALL 36

static SDL_Window *win;
static SDL_Renderer *ren;
static float x = 20.0f, y = 30.0f;          /* ball top-left */
static float vx = 140.0f, vy = 110.0f;      /* px/s */
static int color = 0;
static Uint64 last;

SDL_AppResult SDL_AppInit(void **appstate, int argc, char *argv[]) {
    (void)appstate; (void)argc; (void)argv;
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        fprintf(stderr, "pollball: SDL_Init failed\n");
        return SDL_APP_FAILURE;
    }
    win = SDL_CreateWindow("pollball", W, H, 0);
    if (!win) { fprintf(stderr, "pollball: no window\n"); return SDL_APP_FAILURE; }
    ren = SDL_CreateRenderer(win, NULL);
    if (!ren) { fprintf(stderr, "pollball: no renderer\n"); return SDL_APP_FAILURE; }
    last = SDL_GetTicks();
    return SDL_APP_CONTINUE;
}

SDL_AppResult SDL_AppEvent(void *appstate, SDL_Event *e) {
    (void)appstate;
    if (e->type == SDL_EVENT_QUIT) return SDL_APP_SUCCESS;
    if (e->type == SDL_EVENT_KEY_DOWN) {
        if (e->key.key == SDLK_ESCAPE) return SDL_APP_SUCCESS;
        color = (color + 1) % 3;
    }
    return SDL_APP_CONTINUE;
}

SDL_AppResult SDL_AppIterate(void *appstate) {
    (void)appstate;
    Uint64 now = SDL_GetTicks();
    float dt = (float)(now - last) / 1000.0f;
    last = now;
    if (dt > 0.1f) dt = 0.1f;        /* clamp a stall's first step */
    x += vx * dt; y += vy * dt;
    if (x < 0)        { x = 0;        vx = -vx; }
    if (x > W - BALL) { x = W - BALL; vx = -vx; }
    if (y < 0)        { y = 0;        vy = -vy; }
    if (y > H - BALL) { y = H - BALL; vy = -vy; }

    SDL_SetRenderDrawColor(ren, 12, 12, 48, 255);   /* midnight field */
    SDL_RenderClear(ren);
    SDL_SetRenderDrawColor(ren,
        color == 0 ? 255 : 40,
        color == 1 ? 255 : 40,
        color == 2 ? 255 : 40, 255);
    SDL_FRect r = { x, y, BALL, BALL };
    SDL_RenderFillRect(ren, &r);
    SDL_RenderPresent(ren);
    return SDL_APP_CONTINUE;
}

void SDL_AppQuit(void *appstate, SDL_AppResult result) {
    (void)appstate; (void)result;
    printf("pollball: quit\n");
}
