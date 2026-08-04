/* SDL_AudioStream get-callback (pull) mode can't be honoured here: there's no SDL
   audio thread to invoke the callback (Web Audio is driven from the main thread).
   SDL3 defines this function's failure contract — return NULL with the error
   string set — and that is what the veneer does (#491). It must NOT silently fall
   back to push mode and play silence, and it must NOT kill the process (the old
   veneer threw host-side; the unwind surfaced as exit 1 standalone and as a SEGV
   / exit 139 under the OS kernel). The graceful-degradation shape a real game
   writes — `if (!au) { silent = 1; }` — must keep running. */
#include <SDL.h>
#include <stdio.h>

static void pull_cb(void *userdata, SDL_AudioStream *stream, int additional, int total) {
    (void)userdata; (void)stream; (void)additional; (void)total;
}

int main(void) {
    SDL_Init(SDL_INIT_AUDIO);
    SDL_AudioSpec spec;
    spec.format = SDL_AUDIO_S16;
    spec.channels = 2;
    spec.freq = 48000;
    printf("before open\n");
    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(0, &spec, pull_cb, NULL);
    printf("after open: %d\n", s != NULL);
    printf("error set: %d\n", SDL_GetError()[0] != '\0');
    return 0;
}
