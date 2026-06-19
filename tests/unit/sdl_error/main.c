/* SDL3 error API: SDL_GetError / SDL_SetError / SDL_ClearError.
   - SDL_GetError never returns NULL (empty string when no error).
   - SDL_SetError formats (printf-style) and returns false (0).
   - SDL_ClearError empties the string and returns true (1).
   - A failing SDL call sets the error (here: NULL audio spec, which this
     runtime rejects loudly). */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("initial=[%s]\n", SDL_GetError());

    int r = (int)SDL_SetError("boom %d/%s", 42, "x");
    printf("set_ret=%d msg=[%s]\n", r, SDL_GetError());

    int c = (int)SDL_ClearError();
    printf("clear_ret=%d msg=[%s]\n", c, SDL_GetError());

    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(0, NULL, NULL, NULL);
    printf("stream_null=%d err=[%s]\n", s == NULL, SDL_GetError());
    return 0;
}
