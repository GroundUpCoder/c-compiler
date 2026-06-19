/* SDL_AudioStream get-callback (pull) mode can't be honoured here: there's no SDL
   audio thread to invoke the callback (Web Audio is driven from the main thread).
   Passing a non-NULL callback to SDL_OpenAudioDeviceStream FAILS LOUD (throws,
   like SDL_Delay) rather than silently falling back to push mode and playing
   silence. "before open" prints; "after open" is never reached (the throw unwinds
   out of main → non-zero exit). stderr carries the guidance message; pin only
   stdout + the exit code. */
#include <SDL.h>
#include <stdio.h>

static void pull_cb(void *userdata, SDL_AudioStream *stream, int additional, int total) {
    (void)userdata; (void)stream; (void)additional; (void)total;
}

int main(void) {
    SDL_Init(SDL_INIT_AUDIO);
    SDL_AudioSpec spec;
    spec.format = 0;        /* unused on this path — the callback check comes first */
    spec.channels = 2;
    spec.freq = 48000;
    printf("before open\n");
    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(0, &spec, pull_cb, NULL);
    printf("after open: %d\n", s != NULL);   /* unreachable */
    return 0;
}
