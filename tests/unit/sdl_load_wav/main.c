// #723 (#529-B): SDL_LoadWAV API-contract test — ownership, output zeroing,
// zero-data behavior, allocation-failure injection at every site, heap
// balance, and the B->A composition (decoded WAV through a #722 device-less
// SDL_AudioStream). The byte-exactness of the DECODER itself is proven by the
// differential suite (tests/host/test_sdl_loadwav_diff.js) against the pinned
// upstream oracle manifest; this test pins the caller-visible contract.
//
// Fixture paths are repo-root-relative (the unit runners execute with the
// repo root as cwd — the tests/run.js dispatcher pins cwd: ROOT).
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// The #723 test seam (reserved __ name, declared in no header): N >= 0 makes
// the (N+1)th allocation inside the decoder TU fail once, then disarms.
extern int __sdl_wave_alloc_countdown;

#define FIX "tests/unit/sdl_load_wav_fixtures/"

static unsigned crc32_bytes(const unsigned char *p, unsigned n) {
    unsigned crc = 0xffffffffu;
    for (unsigned i = 0; i < n; i++) {
        crc ^= p[i];
        for (int b = 0; b < 8; b++)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static long heap_used(void) {
    struct __heap_info h;
    __inspect_heap(&h);
    return h.total_bytes - h.free_bytes;
}

static void poison(SDL_AudioSpec *spec, Uint8 **buf, Uint32 *len) {
    memset(spec, 0x5a, sizeof(*spec));
    *buf = (Uint8 *)0x5a5a5a5a;
    *len = 0x5a5a5a5a;
}

static int spec_zeroed(const SDL_AudioSpec *spec) {
    return spec->format == 0 && spec->channels == 0 && spec->freq == 0;
}

int main(void) {
    SDL_AudioSpec spec;
    Uint8 *buf;
    Uint32 len;

    // Warm up lazy one-time allocations (stdio buffers, the error slot) so
    // the heap-balance probes below measure ONLY the loader's behavior.
    poison(&spec, &buf, &len);
    (void)SDL_LoadWAV(FIX "pcm_s16_stereo.wav", &spec, &buf, &len);
    SDL_free(buf);
    (void)SDL_LoadWAV("/no/such/dir/x.wav", &spec, &buf, &len);
    printf("warmed\n");

    const long baseline = heap_used();

    // ---- parameter contract -------------------------------------------------
    poison(&spec, &buf, &len);
    if (SDL_LoadWAV(NULL, &spec, &buf, &len)) return 1;
    printf("null-path: err=\"%s\" buf-null=%d len=%u spec-zeroed=%d\n",
           SDL_GetError(), buf == NULL, (unsigned)len, spec_zeroed(&spec));

    poison(&spec, &buf, &len);
    if (SDL_LoadWAV("/no/such/dir/x.wav", &spec, &buf, &len)) return 1;
    printf("bad-path: err=\"%s\" buf-null=%d len=%u spec-zeroed=%d\n",
           SDL_GetError(), buf == NULL, (unsigned)len, spec_zeroed(&spec));

    buf = (Uint8 *)0x5a5a5a5a; len = 0x5a5a5a5a;
    if (SDL_LoadWAV(FIX "pcm_s16_stereo.wav", NULL, &buf, &len)) return 1;
    printf("null-spec: err=\"%s\" buf-null=%d len=%u\n",
           SDL_GetError(), buf == NULL, (unsigned)len);

    poison(&spec, &buf, &len);
    if (SDL_LoadWAV(FIX "pcm_s16_stereo.wav", &spec, NULL, &len)) return 1;
    printf("null-buf: err=\"%s\" len=%u spec-zeroed=%d\n",
           SDL_GetError(), (unsigned)len, spec_zeroed(&spec));

    poison(&spec, &buf, &len);
    if (SDL_LoadWAV(FIX "pcm_s16_stereo.wav", &spec, &buf, NULL)) return 1;
    printf("null-len: err=\"%s\" buf-null=%d spec-zeroed=%d\n",
           SDL_GetError(), buf == NULL, spec_zeroed(&spec));

    // ---- failure zeroes every output ---------------------------------------
    poison(&spec, &buf, &len);
    if (SDL_LoadWAV(FIX "unknown_tag.wav", &spec, &buf, &len)) return 1;
    printf("decode-fail: err=\"%s\" buf-null=%d len=%u spec-zeroed=%d\n",
           SDL_GetError(), buf == NULL, (unsigned)len, spec_zeroed(&spec));

    // ---- zero-sample success: NULL buffer, len 0, spec REAL ----------------
    poison(&spec, &buf, &len);
    if (!SDL_LoadWAV(FIX "ms_zero_data.wav", &spec, &buf, &len)) return 1;
    printf("zero-data: ok format=%d channels=%d freq=%d buf-null=%d len=%u\n",
           (int)spec.format, spec.channels, spec.freq, buf == NULL, (unsigned)len);
    SDL_free(buf); // NULL — must be a no-op

    // ---- success + SDL_free ownership + reloadability -----------------------
    for (int round = 0; round < 2; round++) {
        poison(&spec, &buf, &len);
        if (!SDL_LoadWAV(FIX "pcm_s16_stereo.wav", &spec, &buf, &len)) return 1;
        printf("load[%d]: format=%d channels=%d freq=%d len=%u crc=%08x\n",
               round, (int)spec.format, spec.channels, spec.freq,
               (unsigned)len, crc32_bytes(buf, len));
        SDL_free(buf);
    }

    // ---- allocation-failure injection at EVERY site -------------------------
    // For each codec family, fail allocation k (k = 0, 1, ...) until the load
    // succeeds. Every injected failure must zero the outputs, set the error,
    // and leave the heap balanced (nothing leaked, adapter closed). The first
    // succeeding k IS the allocation-site count of that codec's happy path —
    // printed, so a site appearing or vanishing moves a pinned number.
    {
        static const char *files[] = {
            FIX "pcm_s16_mono.wav",   // stream, fmt chunk, const-mem stream, data chunk
            FIX "pcm_s24_mono.wav",   // + the 24->32 realloc
            FIX "mulaw_mono.wav",     // + the law realloc
            FIX "msadpcm_stereo.wav", // + coeff table + output calloc
            FIX "imaadpcm_stereo.wav" // + output malloc + channel-state calloc
        };
        for (int f = 0; f < 5; f++) {
            int sites = -1;
            for (int k = 0; k < 16; k++) {
                long before = heap_used();
                poison(&spec, &buf, &len);
                __sdl_wave_alloc_countdown = k;
                bool ok = SDL_LoadWAV(files[f], &spec, &buf, &len);
                __sdl_wave_alloc_countdown = -1;
                if (ok) {
                    SDL_free(buf);
                    if (heap_used() != before) { printf("LEAK after success k=%d %s\n", k, files[f]); return 1; }
                    sites = k;
                    break;
                }
                if (buf != NULL || len != 0 || !spec_zeroed(&spec)) {
                    printf("BAD outputs after injected fail k=%d %s\n", k, files[f]);
                    return 1;
                }
                if (SDL_GetError()[0] == 0) { printf("EMPTY error k=%d %s\n", k, files[f]); return 1; }
                if (heap_used() != before) { printf("LEAK after injected fail k=%d %s\n", k, files[f]); return 1; }
            }
            printf("alloc-sites[%d]=%d\n", f, sites);
        }
    }

    // ---- B feeds A: decoded U8 through a device-less stream to S16 ---------
    {
        if (!SDL_LoadWAV(FIX "pcm_u8_mono.wav", &spec, &buf, &len)) return 1;
        SDL_AudioSpec dst = { SDL_AUDIO_S16, 1, 8000 };
        SDL_AudioStream *st = SDL_CreateAudioStream(&spec, &dst);
        if (!st) return 1;
        if (!SDL_PutAudioStreamData(st, buf, (int)len)) return 1;
        if (!SDL_FlushAudioStream(st)) return 1;
        static Uint8 out[4096];
        int got = SDL_GetAudioStreamData(st, out, (int)sizeof(out));
        printf("convert: in=%u out=%d crc=%08x\n",
               (unsigned)len, got, got > 0 ? crc32_bytes(out, (unsigned)got) : 0);
        SDL_DestroyAudioStream(st);
        SDL_free(buf);
    }

    // ---- the whole run leaked nothing ---------------------------------------
    printf("heap-balanced=%d\n", heap_used() == baseline);
    return 0;
}
