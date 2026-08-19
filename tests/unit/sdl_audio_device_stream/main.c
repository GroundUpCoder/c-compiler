/* #529-A DEVICE stream contracts on the sink-less null host (#722): the
   destination-format query answers the requested spec (SDL's dummy-driver
   contract), GetData/Available are refused on a device-bound stream, puts
   stay byte-oriented (the pre-#529 unbounded-queue contract, including the
   1-byte put), Queued reports exact original bytes (never draining here —
   the null ring accepts nothing, so everything is C backlog), a source
   format change is refused while a partial device frame dangles and
   otherwise converts future puts to the open spec, a destination change is
   ignored without error (but still validated), Clear is transactional, and
   the stream is reusable after Clear. */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

static void expect(const char *what, int cond) { printf("%s %s\n", cond ? "ok" : "FAIL", what); }

/* test-only hooks implemented by __SDL.c (deliberately not in any header) */
extern int __sdl_audiostream_failalloc(int nth);
extern int __sdl_audiostream_fp(SDL_AudioStream *s, unsigned int *out, int cap);

/* Arm the k-th allocation to fail, attempt the put, and prove atomicity:
   a false return leaves the fingerprint (extents, ledger, counters, the
   allocation counter itself) and Queued byte-identical. Returns 1 when the
   put failed (armed allocation was reached), 0 when it succeeded (the path
   performs fewer than k allocations). */
static int put_fails_atomically(const char *what, SDL_AudioStream *st,
                                const void *buf, int len, int k) {
    unsigned int before[14], after[14];
    int q0 = SDL_GetAudioStreamQueued(st), q1, r;
    __sdl_audiostream_fp(st, before, 14);
    __sdl_audiostream_failalloc(k);
    r = SDL_PutAudioStreamData(st, buf, len);
    __sdl_audiostream_failalloc(0);
    if (r) return 0;
    __sdl_audiostream_fp(st, after, 14);
    q1 = SDL_GetAudioStreamQueued(st);
    expect(what, memcmp(before, after, sizeof before) == 0 && q0 == q1);
    return 1;
}

int main(void) {
    SDL_Init(SDL_INIT_AUDIO);
    SDL_AudioSpec spec = { SDL_AUDIO_S16, 2, 48000 };
    SDL_AudioStream *s = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
    SDL_AudioSpec gs, gd;
    short pcm[8] = { 100, 200, 300, 400, 500, 600, 700, 800 };
    char buf[64];

    expect("open", s != NULL);
    expect("getformat", SDL_GetAudioStreamFormat(s, &gs, &gd));
    expect("src is the open spec", gs.format == SDL_AUDIO_S16 && gs.channels == 2 && gs.freq == 48000);
    expect("dst is the reported device format", gd.format == SDL_AUDIO_S16 && gd.channels == 2 && gd.freq == 48000);

    expect("device getdata refused", SDL_GetAudioStreamData(s, buf, 64) == -1);
    expect("device available refused", SDL_GetAudioStreamAvailable(s) == -1);

    expect("identity put", SDL_PutAudioStreamData(s, pcm, 16));
    expect("queued 16", SDL_GetAudioStreamQueued(s) == 16);
    expect("1-byte put ok (byte-oriented device contract)", SDL_PutAudioStreamData(s, pcm, 1));
    expect("queued 17", SDL_GetAudioStreamQueued(s) == 17);

    {
        SDL_AudioSpec s16m24 = { SDL_AUDIO_S16, 1, 24000 };
        SDL_AudioSpec f32s96 = { SDL_AUDIO_F32, 2, 96000 };
        SDL_AudioSpec badf = { 0x1111, 2, 48000 };
        expect("src change refused on partial frame", !SDL_SetAudioStreamFormat(s, &s16m24, NULL));
        expect("complete the frame", SDL_PutAudioStreamData(s, pcm, 3));
        expect("src change ok on frame boundary", SDL_SetAudioStreamFormat(s, &s16m24, NULL));
        expect("dst change ignored without error", SDL_SetAudioStreamFormat(s, NULL, &f32s96));
        expect("dst really unchanged", SDL_GetAudioStreamFormat(s, NULL, &gd) && gd.format == SDL_AUDIO_S16 && gd.freq == 48000);
        expect("invalid ignored dst still refused", !SDL_SetAudioStreamFormat(s, NULL, &badf));
        expect("misaligned converted put refused", !SDL_PutAudioStreamData(s, pcm, 3));
        expect("converted put", SDL_PutAudioStreamData(s, pcm, 8));
        expect("queued counts original bytes across epochs", SDL_GetAudioStreamQueued(s) == 28);
        expect("flush emits the tail without changing queued", SDL_FlushAudioStream(s) && SDL_GetAudioStreamQueued(s) == 28);
        expect("repeated flush is a no-op", SDL_FlushAudioStream(s) && SDL_GetAudioStreamQueued(s) == 28);
    }

    expect("clear is transactional", SDL_ClearAudioStream(s));
    expect("queued 0 after clear", SDL_GetAudioStreamQueued(s) == 0);
    expect("put after clear begins a clean epoch", SDL_PutAudioStreamData(s, pcm, 8));
    expect("queued 8", SDL_GetAudioStreamQueued(s) == 8);

    expect("resume legal on device", SDL_ResumeAudioStreamDevice(s));
    expect("pause legal on device", SDL_PauseAudioStreamDevice(s));

    SDL_DestroyAudioStream(s);
    expect("destroy returned", 1);

    {   /* MEMORY streams refuse device-only calls */
        SDL_AudioSpec m = { SDL_AUDIO_S16, 1, 48000 };
        SDL_AudioStream *ms = SDL_CreateAudioStream(&m, &m);
        expect("memory resume refused", !SDL_ResumeAudioStreamDevice(ms));
        expect("memory pause refused", !SDL_PauseAudioStreamDevice(ms));
        SDL_DestroyAudioStream(ms);
    }

    {   /* review finding 2: injected allocation failure leaves a put
           byte-atomic — nothing submitted, nothing queued, no counter moved.
           Each k arms the k-th allocation on a FRESH stream (identity first
           put: ledger node, then backlog reserve), then a clean run of the
           same put must succeed. */
        int k, failed = 0;
        for (k = 1; k <= 3; k++) {
            SDL_AudioStream *fs = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
            char name[64];
            snprintf(name, sizeof name, "identity put atomic under failalloc(%d)", k);
            if (put_fails_atomically(name, fs, pcm, 16, k)) {
                failed++;
                expect("clean retry succeeds after injected failure",
                       SDL_PutAudioStreamData(fs, pcm, 16) && SDL_GetAudioStreamQueued(fs) == 16);
            } else {
                expect("first uninjected allocation depth reached", k == 3);
                expect("post-injection put advanced normally", SDL_GetAudioStreamQueued(fs) == 16);
            }
            SDL_DestroyAudioStream(fs);
        }
        expect("both identity allocations were exercised", failed == 2);
    }

    {   /* converted-mode put: backlog reserve, ledger node, extent node,
           extent bytes — four ordered allocations, each proven atomic. */
        SDL_AudioSpec cs = { SDL_AUDIO_S16, 1, 24000 };
        int k, failed = 0;
        for (k = 1; k <= 5; k++) {
            SDL_AudioStream *fs = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
            char name[64];
            SDL_SetAudioStreamFormat(fs, &cs, NULL);
            snprintf(name, sizeof name, "converted put atomic under failalloc(%d)", k);
            if (put_fails_atomically(name, fs, pcm, 8, k)) {
                failed++;
                expect("clean retry succeeds after injected failure",
                       SDL_PutAudioStreamData(fs, pcm, 8) && SDL_GetAudioStreamQueued(fs) == 8);
            } else {
                expect("first uninjected allocation depth reached", k == 5);
                expect("post-injection put advanced normally", SDL_GetAudioStreamQueued(fs) == 8);
            }
            SDL_DestroyAudioStream(fs);
        }
        expect("all four converted allocations were exercised", failed == 4);
    }

    {   /* steady state performs no allocation at all: an armed injector is
           never reached by a coalescing put into reserved capacity. */
        SDL_AudioStream *fs = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
        SDL_PutAudioStreamData(fs, pcm, 16);
        __sdl_audiostream_failalloc(1);
        expect("steady-state identity put allocates nothing",
               SDL_PutAudioStreamData(fs, pcm, 16) && SDL_GetAudioStreamQueued(fs) == 32);
        __sdl_audiostream_failalloc(0);
        SDL_DestroyAudioStream(fs);
    }

    {   /* pull-mode callback stays loud-refused (pre-#529 contract) */
        SDL_AudioStream *cs = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec,
                                                        (SDL_AudioStreamCallback)1, NULL);
        expect("pull callback refused", cs == NULL);
    }
    return 0;
}
