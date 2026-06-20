/* SDL3 conformance: SDL_AudioStream is an unbounded queue — SDL_PutAudioStreamData
   never drops data and always succeeds; SDL_GetAudioStreamQueued reports the total
   queued (ring + overflow backlog); SDL_ClearAudioStream empties it.
   (Headless: the null host ring accepts nothing, so every Put lands in the C-side
   backlog — which is exactly the path that used to silently drop + return true.) */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Init(SDL_INIT_AUDIO);
    SDL_AudioSpec spec = { SDL_AUDIO_F32, 2, 48000 };
    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);

    char buf[2048];
    for (int i = 0; i < 2048; i++) buf[i] = 0;

    printf("put1=%d\n", (int)SDL_PutAudioStreamData(s, buf, 1000));
    printf("queued1=%d\n", SDL_GetAudioStreamQueued(s));
    printf("put2=%d\n", (int)SDL_PutAudioStreamData(s, buf, 500));
    printf("queued2=%d\n", SDL_GetAudioStreamQueued(s));
    printf("put3=%d\n", (int)SDL_PutAudioStreamData(s, buf, 1));   /* not dropped */
    printf("queued3=%d\n", SDL_GetAudioStreamQueued(s));
    SDL_ClearAudioStream(s);
    printf("after_clear=%d\n", SDL_GetAudioStreamQueued(s));
    SDL_DestroyAudioStream(s);
    return 0;
}
