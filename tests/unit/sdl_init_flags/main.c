/* SDL_Init subsystem flags: this runtime backs VIDEO | AUDIO | EVENTS and FAILS
   LOUD on anything else (joystick/gamepad/haptic/sensor/camera have no backend),
   rather than silently pretending it initialized. Also covers SDL_WasInit /
   SDL_InitSubSystem / SDL_QuitSubSystem subsystem tracking. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("video=%d\n", (int)SDL_Init(SDL_INIT_VIDEO));
    /* EVENTS is implicitly initialized alongside VIDEO. */
    printf("wasinit_video=%d events=%d\n",
           SDL_WasInit(SDL_INIT_VIDEO) != 0, SDL_WasInit(SDL_INIT_EVENTS) != 0);

    printf("audio_add=%d wasinit_audio=%d\n",
           (int)SDL_InitSubSystem(SDL_INIT_AUDIO), SDL_WasInit(SDL_INIT_AUDIO) != 0);

    /* Unsupported subsystem fails loud (returns false, sets the error, no state change). */
    printf("gamepad=%d\n", (int)SDL_Init(SDL_INIT_GAMEPAD));
    printf("err=[%s]\n", SDL_GetError());
    printf("wasinit_gamepad=%d\n", SDL_WasInit(SDL_INIT_GAMEPAD) != 0);

    SDL_QuitSubSystem(SDL_INIT_AUDIO);
    printf("after_quit_audio=%d\n", SDL_WasInit(SDL_INIT_AUDIO) != 0);
    printf("mask_has_video=%d mask_has_events=%d\n",
           (SDL_WasInit(0) & SDL_INIT_VIDEO) != 0, (SDL_WasInit(0) & SDL_INIT_EVENTS) != 0);

    SDL_Quit();
    printf("after_quit_all=%u\n", (unsigned)SDL_WasInit(0));
    return 0;
}
