/* #493: SDL_GetKeyboardState / SDL_GetModState / SDL_GetMouseState — the
   idiomatic per-frame game input read. The snapshots update where host-pumped
   events are synthesised (the __sdl_push_* exports, this runtime's
   SDL_PumpEvents equivalent), so the test drives those directly — no window
   system needed. SDL_GetGlobalMouseState is declared but always FAILS (0 mask,
   0,0, error set): desktop-global cursor position is not knowable from a
   process that only sees pointer events routed to its own windows. */
#include <SDL.h>
#include <stdio.h>

void __sdl_push_key_event(int window_id, int type, int scancode, int sym, int mod, int repeat);
void __sdl_push_mouse_button_event(int window_id, int type, int button, double x, double y);
void __sdl_push_mouse_motion_event(int window_id, double x, double y, int state);

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    int numkeys = 0;
    const bool *keys = SDL_GetKeyboardState(&numkeys);
    printf("numkeys: %d\n", numkeys);
    printf("initial up: %d mod: %d buttons: %u\n",
           keys[SDL_SCANCODE_UP] ? 1 : 0, (int)SDL_GetModState(),
           (unsigned)SDL_GetMouseState(0, 0));

    __sdl_push_key_event(1, SDL_EVENT_KEY_DOWN, SDL_SCANCODE_UP, 0, SDL_KMOD_LSHIFT, 0);
    printf("held up: %d shift: %d\n",
           keys[SDL_SCANCODE_UP] ? 1 : 0, SDL_GetModState() == SDL_KMOD_LSHIFT);
    __sdl_push_key_event(1, SDL_EVENT_KEY_UP, SDL_SCANCODE_UP, 0, 0, 0);
    printf("released up: %d mod: %d\n",
           keys[SDL_SCANCODE_UP] ? 1 : 0, (int)SDL_GetModState());

    float mx = -1, my = -1;
    __sdl_push_mouse_button_event(1, SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT, 10, 20);
    SDL_MouseButtonFlags b = SDL_GetMouseState(&mx, &my);
    printf("down mask: %u pos: %.0f %.0f\n", (unsigned)b, mx, my);

    /* Motion latches the host's full mask — a release delivered outside our
       windows self-heals on the next motion event. */
    __sdl_push_mouse_motion_event(1, 30, 40, 0);
    b = SDL_GetMouseState(&mx, &my);
    printf("after motion mask: %u pos: %.0f %.0f\n", (unsigned)b, mx, my);

    SDL_ClearError();
    float gx = -1, gy = -1;
    SDL_MouseButtonFlags g = SDL_GetGlobalMouseState(&gx, &gy);
    printf("global: %u %.0f %.0f err: %d\n",
           (unsigned)g, gx, gy, SDL_GetError()[0] != '\0');
    return 0;
}
