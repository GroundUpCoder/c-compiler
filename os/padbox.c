/* padbox — the #607 gamepad acceptance app (the winbox shape, for pads).
 *
 * A live view of every connected gamepad: buttons light up as filled
 * squares, sticks draw as crosshair dots, triggers as fill bars. Every
 * gamepad event also prints one line to stdout ("padbox: added id=1",
 * "padbox: button a down id=1", ...) so the same binary is the headless
 * test instrument — a kernel e2e launches it, injects `wmctl pad ...`, and
 * asserts the lines; jku verifies the real-pad leg by launching it in a
 * browser session and pressing buttons on a physical controller.
 *
 * SDL_MAIN_USE_CALLBACKS per the sanctioned GPU-present loop model (#551;
 * pollball is the reference). ESC or title-bar close quits.
 */
#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
#include <stdio.h>

#define W 360
#define H 220
#define MAXPADS 4

static SDL_Window *win;
static SDL_Renderer *ren;
static SDL_Gamepad *pads[MAXPADS];

static void pad_line(const char *what, SDL_JoystickID id, const char *detail,
                     int value) {
    if (detail) printf("padbox: %s %s %d id=%u\n", what, detail, value, (unsigned)id);
    else printf("padbox: %s id=%u\n", what, (unsigned)id);
    fflush(stdout);   /* the e2e reads these through a pipe — no batching */
}

SDL_AppResult SDL_AppInit(void **appstate, int argc, char *argv[]) {
    (void)appstate; (void)argc; (void)argv;
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) {
        fprintf(stderr, "padbox: SDL_Init failed: %s\n", SDL_GetError());
        return SDL_APP_FAILURE;
    }
    win = SDL_CreateWindow("padbox", W, H, 0);
    if (!win) { fprintf(stderr, "padbox: no window\n"); return SDL_APP_FAILURE; }
    ren = SDL_CreateRenderer(win, NULL);
    if (!ren) { fprintf(stderr, "padbox: no renderer\n"); return SDL_APP_FAILURE; }
    printf("padbox: ready\n");
    fflush(stdout);
    return SDL_APP_CONTINUE;
}

SDL_AppResult SDL_AppEvent(void *appstate, SDL_Event *e) {
    (void)appstate;
    switch (e->type) {
    case SDL_EVENT_QUIT:
        return SDL_APP_SUCCESS;
    case SDL_EVENT_KEY_DOWN:
        if (e->key.key == SDLK_ESCAPE) return SDL_APP_SUCCESS;
        break;
    case SDL_EVENT_GAMEPAD_ADDED: {
        SDL_Gamepad *g = SDL_OpenGamepad(e->gdevice.which);
        if (g) {
            for (int i = 0; i < MAXPADS; i++)
                if (!pads[i]) { pads[i] = g; g = NULL; break; }
            if (g) SDL_CloseGamepad(g);     /* view full — fifth pad unshown */
        }
        pad_line("added", e->gdevice.which, NULL, 0);
        break;
    }
    case SDL_EVENT_GAMEPAD_REMOVED:
        for (int i = 0; i < MAXPADS; i++) {
            if (pads[i] && SDL_GetGamepadID(pads[i]) == e->gdevice.which) {
                SDL_CloseGamepad(pads[i]);
                pads[i] = NULL;
            }
        }
        pad_line("removed", e->gdevice.which, NULL, 0);
        break;
    case SDL_EVENT_GAMEPAD_BUTTON_DOWN:
    case SDL_EVENT_GAMEPAD_BUTTON_UP:
        pad_line("button", e->gbutton.which,
                 SDL_GetGamepadStringForButton((SDL_GamepadButton)e->gbutton.button),
                 e->gbutton.down);
        break;
    case SDL_EVENT_GAMEPAD_AXIS_MOTION:
        pad_line("axis", e->gaxis.which,
                 SDL_GetGamepadStringForAxis((SDL_GamepadAxis)e->gaxis.axis),
                 e->gaxis.value);
        break;
    }
    return SDL_APP_CONTINUE;
}

/* One pad's panel: 15 button squares (the standard-mapping set), two stick
 * boxes with position dots, two trigger bars. */
static void draw_pad(SDL_Gamepad *g, float ox, float oy) {
    SDL_FRect r;
    for (int b = 0; b <= SDL_GAMEPAD_BUTTON_DPAD_RIGHT; b++) {
        r.x = ox + (b % 8) * 20.0f;
        r.y = oy + (b / 8) * 20.0f;
        r.w = r.h = 16.0f;
        if (SDL_GetGamepadButton(g, (SDL_GamepadButton)b))
            SDL_SetRenderDrawColor(ren, 80, 220, 80, 255);
        else
            SDL_SetRenderDrawColor(ren, 60, 60, 70, 255);
        SDL_RenderFillRect(ren, &r);
    }
    for (int s = 0; s < 2; s++) {       /* stick boxes */
        float bx = ox + s * 56.0f, by = oy + 44.0f;
        SDL_SetRenderDrawColor(ren, 60, 60, 70, 255);
        r.x = bx; r.y = by; r.w = 48.0f; r.h = 48.0f;
        SDL_RenderFillRect(ren, &r);
        float ax = SDL_GetGamepadAxis(g, s ? SDL_GAMEPAD_AXIS_RIGHTX : SDL_GAMEPAD_AXIS_LEFTX) / 32767.0f;
        float ay = SDL_GetGamepadAxis(g, s ? SDL_GAMEPAD_AXIS_RIGHTY : SDL_GAMEPAD_AXIS_LEFTY) / 32767.0f;
        SDL_SetRenderDrawColor(ren, 240, 240, 90, 255);
        r.x = bx + 21.0f + ax * 20.0f; r.y = by + 21.0f + ay * 20.0f;
        r.w = 6.0f; r.h = 6.0f;
        SDL_RenderFillRect(ren, &r);
    }
    for (int t = 0; t < 2; t++) {       /* trigger bars */
        float bx = ox + 120.0f, by = oy + 44.0f + t * 26.0f;
        SDL_SetRenderDrawColor(ren, 60, 60, 70, 255);
        r.x = bx; r.y = by; r.w = 100.0f; r.h = 18.0f;
        SDL_RenderFillRect(ren, &r);
        float tv = SDL_GetGamepadAxis(g, t ? SDL_GAMEPAD_AXIS_RIGHT_TRIGGER
                                           : SDL_GAMEPAD_AXIS_LEFT_TRIGGER) / 32767.0f;
        SDL_SetRenderDrawColor(ren, 90, 160, 240, 255);
        r.w = 100.0f * (tv < 0 ? 0 : tv);
        SDL_RenderFillRect(ren, &r);
    }
}

SDL_AppResult SDL_AppIterate(void *appstate) {
    (void)appstate;
    SDL_SetRenderDrawColor(ren, 24, 24, 32, 255);
    SDL_RenderClear(ren);
    int shown = 0;
    for (int i = 0; i < MAXPADS; i++) {
        if (!pads[i]) continue;
        draw_pad(pads[i], 10.0f, 10.0f + shown * 100.0f);
        shown++;
        if (shown >= 2) break;          /* panel space for two */
    }
    if (!shown) {
        SDL_SetRenderDrawColor(ren, 200, 200, 200, 255);
        SDL_RenderDebugText(ren, 10.0f, 10.0f,
                            "no gamepad - connect one (or: wmctl pad connect)");
    }
    SDL_RenderPresent(ren);
    return SDL_APP_CONTINUE;
}

void SDL_AppQuit(void *appstate, SDL_AppResult result) {
    (void)appstate; (void)result;
    for (int i = 0; i < MAXPADS; i++)
        if (pads[i]) SDL_CloseGamepad(pads[i]);
    SDL_Quit();
}
