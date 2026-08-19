/* #529-A MEMORY stream state matrix (#722): create/set/get pointer forms,
   refusal-until-configured, atomic invalid Set, immutable format epochs
   (queued bytes keep their captured specs; partial reads stop at epoch
   boundaries), exact original-byte Queued retirement, the strictly
   observational Available (state fingerprints + a never-called control
   stream + the synthetic >INT_MAX clamp with no allocation), idempotent
   flush, clear-retains-specs, and put-after-flush reuse.

   __sdl_audiostream_fp is the deliberately-undocumented test hook filled by
   __SDL.c (kind, sides, extent count, head frames/base/k/retired/flushed,
   the extent/ledger allocation counter, backlog, ledger count, put/retired
   original bytes). */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

extern int __sdl_audiostream_fp(SDL_AudioStream *s, unsigned int *out, int cap);

static void expect(const char *what, int cond) { printf("%s %s\n", cond ? "ok" : "FAIL", what); }

int main(void) {
    SDL_AudioSpec s16m48 = { SDL_AUDIO_S16, 1, 48000 };
    SDL_AudioSpec f32s48 = { SDL_AUDIO_F32, 2, 48000 };
    SDL_AudioSpec s16s22 = { SDL_AUDIO_S16, 2, 22050 };
    SDL_AudioSpec bad = { 0x7777, 2, 48000 };

    /* -- create forms -- */
    expect("create null/null", SDL_CreateAudioStream(NULL, NULL) != NULL);
    expect("create src-only", SDL_CreateAudioStream(&s16m48, NULL) != NULL);
    expect("create dst-only", SDL_CreateAudioStream(NULL, &f32s48) != NULL);
    expect("create bad src refused", SDL_CreateAudioStream(&bad, &f32s48) == NULL);
    expect("create bad dst refused", SDL_CreateAudioStream(&s16m48, &bad) == NULL);
    {
        SDL_AudioSpec badch = { SDL_AUDIO_S16, 9, 48000 };
        SDL_AudioSpec badf = { SDL_AUDIO_S16, 2, 0 };
        expect("9 channels refused", SDL_CreateAudioStream(&badch, NULL) == NULL);
        expect("freq 0 refused", SDL_CreateAudioStream(&badf, NULL) == NULL);
        badch.channels = 8;
        expect("8 channels accepted", SDL_CreateAudioStream(&badch, NULL) != NULL);
        badf.freq = 2000000000;
        expect("extreme rate accepted at set", SDL_CreateAudioStream(&badf, NULL) != NULL);
    }

    /* -- refusal until both sides set -- */
    {
        SDL_AudioStream *u = SDL_CreateAudioStream(&s16m48, NULL);
        short pcm[4] = { 1000, 2000, 3000, 4000 };
        char out[64];
        expect("put refused unset dst", !SDL_PutAudioStreamData(u, pcm, 8));
        expect("get refused unset dst", SDL_GetAudioStreamData(u, out, 8) == -1);
        expect("get len0 is 0 even unset", SDL_GetAudioStreamData(u, out, 0) == 0);
        expect("avail refused unset dst", SDL_GetAudioStreamAvailable(u) == -1);
        expect("flush refused unset dst", !SDL_FlushAudioStream(u));
        expect("queued 0 on unset", SDL_GetAudioStreamQueued(u) == 0);
        expect("clear ok on unset", SDL_ClearAudioStream(u));
        SDL_DestroyAudioStream(u);
    }

    /* -- Set: NULL sides, atomic invalid -- */
    {
        SDL_AudioStream *s = SDL_CreateAudioStream(&s16m48, &f32s48);
        SDL_AudioSpec gs, gd;
        expect("set both null noop", SDL_SetAudioStreamFormat(s, NULL, NULL));
        expect("set bad dst refused", !SDL_SetAudioStreamFormat(s, &s16s22, &bad));
        SDL_GetAudioStreamFormat(s, &gs, &gd);
        expect("atomic: src unchanged after refusal", gs.freq == 48000 && gs.channels == 1);
        expect("set src only", SDL_SetAudioStreamFormat(s, &s16s22, NULL));
        SDL_GetAudioStreamFormat(s, &gs, &gd);
        expect("src changed dst kept", gs.freq == 22050 && gs.channels == 2 && gd.format == SDL_AUDIO_F32);
        SDL_DestroyAudioStream(s);
    }

    /* -- GetFormat pointer forms -- */
    {
        SDL_AudioStream *s = SDL_CreateAudioStream(NULL, &f32s48);
        SDL_AudioSpec gs, gd;
        memset(&gs, 0x55, sizeof gs);
        expect("getformat validity query", SDL_GetAudioStreamFormat(s, NULL, NULL));
        expect("getformat unset src fails", !SDL_GetAudioStreamFormat(s, &gs, NULL));
        expect("unset src zeroed", gs.format == 0 && gs.channels == 0 && gs.freq == 0);
        expect("getformat dst-only ok", SDL_GetAudioStreamFormat(s, NULL, &gd) && gd.channels == 2);
        expect("getformat null stream", !SDL_GetAudioStreamFormat(NULL, &gs, &gd));
        expect("null stream zeroes outputs", gd.format == 0 && gd.freq == 0);
        SDL_DestroyAudioStream(s);
    }

    /* -- put argument matrix -- */
    {
        SDL_AudioStream *s = SDL_CreateAudioStream(&s16m48, &f32s48);
        short pcm[4] = { 1, 2, 3, 4 };
        unsigned int fp0[14], fp1[14];
        expect("put null stream", !SDL_PutAudioStreamData(NULL, pcm, 8));
        expect("put null buf", !SDL_PutAudioStreamData(s, NULL, 8));
        expect("put negative len", !SDL_PutAudioStreamData(s, pcm, -4));
        __sdl_audiostream_fp(s, fp0, 14);
        expect("put len0 ok", SDL_PutAudioStreamData(s, pcm, 0));
        __sdl_audiostream_fp(s, fp1, 14);
        expect("len0 created no epoch", fp0[3] == 0 && fp1[3] == 0);
        expect("put misaligned refused", !SDL_PutAudioStreamData(s, pcm, 3));
        expect("nothing queued after refusals", SDL_GetAudioStreamQueued(s) == 0);
        SDL_DestroyAudioStream(s);
    }

    /* -- format epochs: queued bytes keep captured specs -- */
    {
        SDL_AudioStream *s = SDL_CreateAudioStream(&s16m48, &f32s48);
        short pcm[2] = { 8192, -8192 };            /* 2 mono frames */
        unsigned char out[64];
        int got;
        SDL_PutAudioStreamData(s, pcm, 4);          /* epoch A: ->F32 stereo 48k */
        SDL_SetAudioStreamFormat(s, NULL, &s16s22); /* dst change: future puts */
        SDL_PutAudioStreamData(s, pcm, 4);          /* epoch B: ->S16 stereo 22050 */
        expect("queued = both epochs' original bytes", SDL_GetAudioStreamQueued(s) == 8);
        /* epoch A is non-tail so its tail is emittable: 2 F32-stereo frames
           = 16 bytes; epoch B unflushed at 22050/48000: 1 frame = 4 bytes */
        expect("avail spans epochs", SDL_GetAudioStreamAvailable(s) == 20);
        /* a buffer holding epoch A + half an epoch-B frame stops at the
           boundary: whole frames of the head epoch only */
        got = SDL_GetAudioStreamData(s, out, 18);
        expect("partial read stops at epoch boundary", got == 16);
        {
            float v0, v1;
            memcpy(&v0, out, 4); memcpy(&v1, out + 4, 4);
            expect("epoch A decoded with captured specs", v0 == 0.25f && v1 == 0.25f);
        }
        got = SDL_GetAudioStreamData(s, out, (int)sizeof out);
        expect("epoch B follows in its own format", got == 4);
        {
            short w0, w1;
            memcpy(&w0, out, 2); memcpy(&w1, out + 2, 2);
            expect("epoch B is S16 stereo", w0 == 8192 && w1 == 8192);
        }
        SDL_DestroyAudioStream(s);
    }

    /* -- MEMORY Queued retires per consumed source frame -- */
    {
        SDL_AudioSpec up = { SDL_AUDIO_S16, 1, 24000 };
        SDL_AudioSpec at = { SDL_AUDIO_S16, 1, 48000 };
        SDL_AudioStream *s = SDL_CreateAudioStream(&up, &at);
        short pcm[4] = { 100, 200, 300, 400 };
        short out[8];
        SDL_PutAudioStreamData(s, pcm, 8);
        expect("queued 8 before get", SDL_GetAudioStreamQueued(s) == 8);
        SDL_GetAudioStreamData(s, out, 8);          /* 4 dst frames: k=4, left=floor(4/2)=2 */
        expect("queued retires consumed frames", SDL_GetAudioStreamQueued(s) == 4);
        SDL_FlushAudioStream(s);
        SDL_GetAudioStreamData(s, out, (int)sizeof out);
        expect("queued 0 after full drain", SDL_GetAudioStreamQueued(s) == 0);
        SDL_DestroyAudioStream(s);
    }

    /* -- Available: strictly observational (fingerprint + control stream) -- */
    {
        SDL_AudioSpec up = { SDL_AUDIO_S16, 2, 22050 };
        SDL_AudioStream *a = SDL_CreateAudioStream(&up, &f32s48);
        SDL_AudioStream *b = SDL_CreateAudioStream(&up, &f32s48);   /* control */
        short pcm[10] = { 1000, -1000, 2000, -2000, 3000, -3000, 4000, -4000, 5000, -5000 };
        unsigned char oa[256], ob[256];
        unsigned int fp0[14], fp1[14];
        int i, va = 0, ga, gb;
        SDL_PutAudioStreamData(a, pcm, 20);
        SDL_PutAudioStreamData(b, pcm, 20);
        SDL_FlushAudioStream(a);
        SDL_FlushAudioStream(b);
        __sdl_audiostream_fp(a, fp0, 14);
        for (i = 0; i < 5; i++) va = SDL_GetAudioStreamAvailable(a);
        __sdl_audiostream_fp(a, fp1, 14);
        expect("available repeats stable", va == SDL_GetAudioStreamAvailable(a));
        expect("available mutated nothing", memcmp(fp0, fp1, sizeof fp0) == 0);
        expect("available allocated nothing", fp0[9] == fp1[9]);
        expect("queued unchanged by available", SDL_GetAudioStreamQueued(a) == 20);
        ga = SDL_GetAudioStreamData(a, oa, (int)sizeof oa);
        gb = SDL_GetAudioStreamData(b, ob, (int)sizeof ob);
        expect("get equals the available promise", ga == va);
        expect("control stream got identical bytes", ga == gb && memcmp(oa, ob, (size_t)ga) == 0);
        __sdl_audiostream_fp(a, fp0, 14);
        __sdl_audiostream_fp(b, fp1, 14);
        expect("post-get fingerprints identical", memcmp(fp0, fp1, sizeof fp0) == 0);
        SDL_DestroyAudioStream(a);
        SDL_DestroyAudioStream(b);
    }

    /* -- synthetic >INT_MAX clamp, allocation-free -- */
    {
        SDL_AudioSpec tiny = { SDL_AUDIO_S16, 1, 1 };
        SDL_AudioSpec huge = { SDL_AUDIO_F32, 8, 2000000000 };
        SDL_AudioStream *s = SDL_CreateAudioStream(&tiny, &huge);
        short pcm[17];
        unsigned int fp0[14], fp1[14];
        int i, avail;
        for (i = 0; i < 17; i++) pcm[i] = (short)(i * 100);
        SDL_PutAudioStreamData(s, pcm, 34);
        SDL_FlushAudioStream(s);
        __sdl_audiostream_fp(s, fp0, 14);
        avail = SDL_GetAudioStreamAvailable(s);
        __sdl_audiostream_fp(s, fp1, 14);
        expect("logical size clamps to INT_MAX", avail == 2147483647);
        expect("clamp allocated no payload", fp0[9] == fp1[9] && memcmp(fp0, fp1, sizeof fp0) == 0);
        expect("queued stays original bytes", SDL_GetAudioStreamQueued(s) == 34);
        SDL_DestroyAudioStream(s);
    }

    /* -- flush idempotence + reuse -- */
    {
        SDL_AudioStream *s = SDL_CreateAudioStream(&s16m48, &s16m48);
        short pcm[4] = { 5, 6, 7, 8 };
        int a1, a2;
        expect("flush empty stream ok", SDL_FlushAudioStream(s));
        SDL_PutAudioStreamData(s, pcm, 8);
        SDL_FlushAudioStream(s);
        a1 = SDL_GetAudioStreamAvailable(s);
        SDL_FlushAudioStream(s);
        a2 = SDL_GetAudioStreamAvailable(s);
        expect("repeated flush emits nothing new", a1 == a2 && a1 == 8);
        expect("put after flush begins new epoch", SDL_PutAudioStreamData(s, pcm, 8));
        expect("avail covers both generations", SDL_GetAudioStreamAvailable(s) == 16);
        expect("clear keeps specs", SDL_ClearAudioStream(s) && SDL_GetAudioStreamFormat(s, NULL, NULL));
        expect("avail 0 after clear", SDL_GetAudioStreamAvailable(s) == 0);
        expect("put works after clear", SDL_PutAudioStreamData(s, pcm, 8));
        SDL_DestroyAudioStream(s);
    }

    /* -- destroy tolerates NULL -- */
    SDL_DestroyAudioStream(NULL);
    expect("destroy null safe", 1);
    return 0;
}
