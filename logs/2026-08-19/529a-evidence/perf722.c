#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ITERS 300
#define FRAMES 4096

static Uint64 lat[ITERS];
static int cmp64(const void *a, const void *b) {
    Uint64 x = *(const Uint64 *)a, y = *(const Uint64 *)b;
    return x < y ? -1 : x > y ? 1 : 0;
}
static void report(const char *name, double bytes_per_iter) {
    qsort(lat, ITERS, sizeof lat[0], cmp64);
    Uint64 p50 = lat[ITERS / 2], p95 = lat[(int)(ITERS * 0.95)], p99 = lat[(int)(ITERS * 0.99)];
    printf("%s: p50 %lluus p95 %lluus p99 %lluus (%.1f MB/s at p50)\n",
           name, (unsigned long long)p50 / 1000, (unsigned long long)p95 / 1000,
           (unsigned long long)p99 / 1000,
           bytes_per_iter / ((double)p50 / 1e9) / 1e6);
}

int main(void) {
    static short in[FRAMES * 2];
    static unsigned char out[FRAMES * 4 * 8];
    static float fa[FRAMES * 2], fb[FRAMES * 2];
    int i, it;
    SDL_Init(SDL_INIT_AUDIO);
    for (i = 0; i < FRAMES * 2; i++) { in[i] = (short)(i * 331); fa[i] = (float)i / (FRAMES * 2); fb[i] = 1.0f - fa[i]; }

    /* stream conversion: S16 stereo 44.1k -> F32 stereo 48k (fmt + rate) */
    {
        SDL_AudioSpec s = { SDL_AUDIO_S16, 2, 44100 };
        SDL_AudioSpec d = { SDL_AUDIO_F32, 2, 48000 };
        SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
        for (it = 0; it < ITERS; it++) {
            Uint64 t0 = SDL_GetTicksNS();
            SDL_PutAudioStreamData(st, in, FRAMES * 4);
            while (SDL_GetAudioStreamData(st, out, (int)sizeof out) > 0) {}
            lat[it] = SDL_GetTicksNS() - t0;
        }
        report("convert s16/44.1k->f32/48k 4096fr", FRAMES * 4.0);
        SDL_DestroyAudioStream(st);
    }
    /* stream conversion incl. channel matrix: S16 5.1 44.1k -> F32 stereo 48k */
    {
        static short in6[FRAMES * 6];
        SDL_AudioSpec s = { SDL_AUDIO_S16, 6, 44100 };
        SDL_AudioSpec d = { SDL_AUDIO_F32, 2, 48000 };
        SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
        for (i = 0; i < FRAMES * 6; i++) in6[i] = (short)(i * 131);
        for (it = 0; it < ITERS; it++) {
            Uint64 t0 = SDL_GetTicksNS();
            SDL_PutAudioStreamData(st, in6, FRAMES * 12);
            while (SDL_GetAudioStreamData(st, out, (int)sizeof out) > 0) {}
            lat[it] = SDL_GetTicksNS() - t0;
        }
        report("convert s16-5.1/44.1k->f32-st/48k 4096fr", FRAMES * 12.0);
        SDL_DestroyAudioStream(st);
    }
    /* pass-through put/get (epoch machinery floor) */
    {
        SDL_AudioSpec s = { SDL_AUDIO_F32, 2, 48000 };
        SDL_AudioStream *st = SDL_CreateAudioStream(&s, &s);
        for (it = 0; it < ITERS; it++) {
            Uint64 t0 = SDL_GetTicksNS();
            SDL_PutAudioStreamData(st, fa, FRAMES * 8);
            while (SDL_GetAudioStreamData(st, out, (int)sizeof out) > 0) {}
            lat[it] = SDL_GetTicksNS() - t0;
        }
        report("passthrough f32/48k 4096fr", FRAMES * 8.0);
        SDL_DestroyAudioStream(st);
    }
    /* SDL_MixAudio F32 + S16 */
    {
        for (it = 0; it < ITERS; it++) {
            Uint64 t0 = SDL_GetTicksNS();
            SDL_MixAudio((Uint8 *)fa, (const Uint8 *)fb, SDL_AUDIO_F32, FRAMES * 8, 0.8f);
            lat[it] = SDL_GetTicksNS() - t0;
        }
        report("mix f32 4096fr", FRAMES * 8.0);
        for (it = 0; it < ITERS; it++) {
            Uint64 t0 = SDL_GetTicksNS();
            SDL_MixAudio((Uint8 *)in, (const Uint8 *)in, SDL_AUDIO_S16, FRAMES * 4, 0.8f);
            lat[it] = SDL_GetTicksNS() - t0;
        }
        report("mix s16 4096fr", FRAMES * 4.0);
    }
    return 0;
}
