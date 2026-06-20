/* SDL3 conformance: events carry their full populated fields, not a zeroed shell.
   key.mod/repeat/which; motion xrel/yrel (relative deltas) + state mask + which;
   button clicks (double-click count) + which + float coords; wheel direction +
   mouse_x/mouse_y (the current mouse position) + which. (Drives the exported
   producers directly so the C-side derivations are exercised headlessly.) */
#include <SDL.h>
#include <stdio.h>

extern void __sdl_push_key_event(int, int, int, int, int, int);
extern void __sdl_push_mouse_button_event(int, int, int, double, double);
extern void __sdl_push_mouse_motion_event(int, double, double, int);
extern void __sdl_push_mouse_wheel_event(int, double, double, int);

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Event e;

    __sdl_push_key_event(1, SDL_EVENT_KEY_DOWN, 26, 'w', SDL_KMOD_LSHIFT | SDL_KMOD_LCTRL, 1);
    SDL_PollEvent(&e);
    printf("key type=%d down=%d repeat=%d scancode=%d key=%d mod=0x%X which=%d\n",
           e.type == SDL_EVENT_KEY_DOWN, e.key.down, e.key.repeat, e.key.scancode,
           e.key.key, (unsigned)e.key.mod, e.key.which);

    __sdl_push_mouse_motion_event(1, 100.5, 50.25, 1);
    SDL_PollEvent(&e);
    printf("motion x=%.2f y=%.2f xrel=%.2f yrel=%.2f state=%d which=%d\n",
           e.motion.x, e.motion.y, e.motion.xrel, e.motion.yrel, e.motion.state, e.motion.which);

    __sdl_push_mouse_motion_event(1, 110.5, 45.25, 0);
    SDL_PollEvent(&e);
    printf("motion2 xrel=%.2f yrel=%.2f\n", e.motion.xrel, e.motion.yrel);

    __sdl_push_mouse_button_event(1, SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT, 110.5, 45.25);
    SDL_PollEvent(&e);
    printf("btn1 button=%d down=%d clicks=%d x=%.2f which=%d\n",
           e.button.button, e.button.down, e.button.clicks, e.button.x, e.button.which);

    __sdl_push_mouse_button_event(1, SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT, 110.5, 45.25);
    SDL_PollEvent(&e);
    printf("btn2 clicks=%d\n", e.button.clicks);

    __sdl_push_mouse_wheel_event(1, 0.0, 1.0, SDL_MOUSEWHEEL_NORMAL);
    SDL_PollEvent(&e);
    printf("wheel x=%.2f y=%.2f dir=%d mouse_x=%.2f mouse_y=%.2f which=%d\n",
           e.wheel.x, e.wheel.y, e.wheel.direction, e.wheel.mouse_x, e.wheel.mouse_y, e.wheel.which);
    return 0;
}
