/* SDL_Init subsystem flags: this runtime backs VIDEO | AUDIO | EVENTS | GAMEPAD
   (#607) and FAILS LOUD on anything else (joystick-level API/haptic/sensor/
   camera have no backend), rather than silently pretending it initialized.
   Also covers SDL_WasInit / SDL_InitSubSystem / SDL_QuitSubSystem subsystem
   tracking, and pins the DECLARED divergence: unlike upstream,
   SDL_INIT_GAMEPAD does not imply SDL_INIT_JOYSTICK — there is no joystick
   subsystem here to imply (PRINCIPLES.md honest shape; header gamepad note). */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("video=%d\n", (int)SDL_Init(SDL_INIT_VIDEO));
    /* EVENTS is implicitly initialized alongside VIDEO. */
    printf("wasinit_video=%d events=%d\n",
           SDL_WasInit(SDL_INIT_VIDEO) != 0, SDL_WasInit(SDL_INIT_EVENTS) != 0);

    printf("audio_add=%d wasinit_audio=%d\n",
           (int)SDL_InitSubSystem(SDL_INIT_AUDIO), SDL_WasInit(SDL_INIT_AUDIO) != 0);

    /* GAMEPAD is a real subsystem since #607 (no pads in this headless
       runtime — the registry is just empty). */
    printf("gamepad=%d\n", (int)SDL_Init(SDL_INIT_GAMEPAD));
    printf("wasinit_gamepad=%d has_gamepad=%d\n",
           SDL_WasInit(SDL_INIT_GAMEPAD) != 0, (int)SDL_HasGamepad());

    /* Unsupported subsystem fails loud (returns false, sets the error, no
       state change) — and GAMEPAD does NOT raise the JOYSTICK bit. */
    printf("joystick=%d\n", (int)SDL_Init(SDL_INIT_JOYSTICK));
    printf("err=[%s]\n", SDL_GetError());
    printf("wasinit_joystick=%d\n", SDL_WasInit(SDL_INIT_JOYSTICK) != 0);

    SDL_QuitSubSystem(SDL_INIT_AUDIO);
    printf("after_quit_audio=%d\n", SDL_WasInit(SDL_INIT_AUDIO) != 0);
    printf("mask_has_video=%d mask_has_events=%d\n",
           (SDL_WasInit(0) & SDL_INIT_VIDEO) != 0, (SDL_WasInit(0) & SDL_INIT_EVENTS) != 0);

    SDL_Quit();
    printf("after_quit_all=%u\n", (unsigned)SDL_WasInit(0));
    return 0;
}
