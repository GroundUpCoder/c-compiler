#include <SDL.h>
int main(void) {
    SDL_AudioSpec a = { SDL_AUDIO_S16, 2, 48000 };
    SDL_AudioSpec b = { SDL_AUDIO_F32, 2, 44100 };
    SDL_AudioStream *s = SDL_CreateAudioStream(&a, &b);          /* RED: absent */
    SDL_SetAudioStreamFormat(s, &a, &b);                         /* RED: absent */
    SDL_GetAudioStreamFormat(s, &a, &b);                         /* RED: absent */
    char buf[16];
    SDL_GetAudioStreamData(s, buf, (int)sizeof buf);             /* RED: absent */
    SDL_GetAudioStreamAvailable(s);                              /* RED: absent */
    SDL_FlushAudioStream(s);                                     /* RED: absent */
    SDL_MixAudio((Uint8 *)buf, (const Uint8 *)buf,
                 SDL_AUDIO_S16, 8, 0.5f);                        /* RED: absent */
    return 0;
}
