/* pollball — the GAMEDEV-EPIC poll-only render loop, as a permanent demo
 * (ticket #484; todos/GAMEDEV-EPIC.md "the first thing every naive game
 * does is a poll-only render loop").
 *
 * A bouncing ball over SDL_Renderer in the most common SDL3 main loop in
 * existence: while (running) { while (SDL_PollEvent) ...; update; render;
 * present; } — DELIBERATELY no SDL_Delay and no SDL_WaitEvent anywhere.
 * This exact shape used to (a) receive no input at all (fixed by #485,
 * SDL_PollEvent pumps the ring) and (b) flood the browser gpu transport
 * with unbounded per-present ImageBitmaps until the tab died (fixed by
 * #484, producer-side present clamp). It stays in the Demos menu as the
 * living acceptance app for both: it must animate, stay responsive, and
 * quit cleanly — indefinitely.
 *
 * Movement is wall-clock based (SDL_GetTicks), not per-frame, so the ball
 * crosses the window at the same speed however fast the loop spins.
 * ESC or the title-bar close quits; any other key re-colors the ball.
 */
#include <SDL.h>
#include <stdio.h>

#define W 320
#define H 240
#define BALL 36

int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        fprintf(stderr, "pollball: SDL_Init failed\n");
        return 1;
    }
    SDL_Window *win = SDL_CreateWindow("pollball", W, H, 0);
    if (!win) { fprintf(stderr, "pollball: no window\n"); return 1; }
    SDL_Renderer *ren = SDL_CreateRenderer(win, NULL);
    if (!ren) { fprintf(stderr, "pollball: no renderer\n"); return 1; }

    float x = 20.0f, y = 30.0f;          /* ball top-left */
    float vx = 140.0f, vy = 110.0f;      /* px/s */
    int color = 0;
    Uint64 last = SDL_GetTicks();
    int running = 1;
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_EVENT_QUIT) running = 0;
            else if (e.type == SDL_EVENT_KEY_DOWN) {
                if (e.key.key == SDLK_ESCAPE) running = 0;
                else color = (color + 1) % 3;
            }
        }
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
    }
    printf("pollball: quit\n");
    SDL_Quit();
    return 0;
}
