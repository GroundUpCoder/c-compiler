/* #529-A conversion matrix (#722): device-less SDL_AudioStream over the full
   5-format x 1..8-channel x rate grid, checked against an INDEPENDENT JS
   oracle (gen-expected.mjs in this directory — it re-derives the channel
   coefficients from the pinned SDL release-3.4.0 generator TABLE, a second
   transcription path from the same pin, and mirrors the documented float
   pipeline with fround arithmetic). expected.stdout is emitted by that
   oracle, never by this program.

   Legs:
   1. full sweep: 5x5 formats x 8x8 channels x {22050->48000, 48000->22050,
      44100->44100}, 17 source frames, put+flush+drain, FNV-1a per
      channel-pair + a grand total;
   2. chunk-boundary invariance: same input converted under three different
      put/get chunkings is byte-identical (self-verifying, prints MATCH);
   3. saturation: out-of-range F32 input saturates each integer format to
      its exact range (exact printed values);
   4. resampler tail: upsample emits ceil(N*df/sf) frames after flush,
      holding the last source frame. */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

static const int FMTS[5] = { SDL_AUDIO_U8, SDL_AUDIO_S8, SDL_AUDIO_S16, SDL_AUDIO_S32, SDL_AUDIO_F32 };
static const char *FMTN[5] = { "U8", "S8", "S16", "S32", "F32" };
static const int RATES[3][2] = { { 22050, 48000 }, { 48000, 22050 }, { 44100, 44100 } };
#define NFRAMES 17

static int fmt_bytes(int f) {
    if (f == SDL_AUDIO_U8 || f == SDL_AUDIO_S8) return 1;
    if (f == SDL_AUDIO_S16) return 2;
    return 4;
}

/* deterministic source pattern, identical in gen-expected.mjs */
static int pat(int f, int c, int sf) { return ((f * 31 + c * 17 + sf * 13) % 255) - 127; }

static void fill_src(unsigned char *buf, int fmt, int ch, int sfi) {
    int f, c;
    for (f = 0; f < NFRAMES; f++) {
        for (c = 0; c < ch; c++) {
            int p = pat(f, c, sfi);
            unsigned char *at = buf + (f * ch + c) * fmt_bytes(fmt);
            if (fmt == SDL_AUDIO_U8) at[0] = (unsigned char)(p + 128);
            else if (fmt == SDL_AUDIO_S8) at[0] = (unsigned char)(signed char)p;
            else if (fmt == SDL_AUDIO_S16) { short v = (short)(p * 257); memcpy(at, &v, 2); }
            else if (fmt == SDL_AUDIO_S32) { int v = p * 16843009; memcpy(at, &v, 4); }
            else { float v = (float)p / 127.0f; memcpy(at, &v, 4); }
        }
    }
}

static unsigned int fnv(unsigned int h, const unsigned char *p, int n) {
    int i;
    for (i = 0; i < n; i++) { h ^= p[i]; h *= 16777619u; }
    return h;
}

int main(void) {
    static unsigned char src[NFRAMES * 8 * 4];
    static unsigned char out[64 * 8 * 4];
    int si, di, sc, dc, ri;
    unsigned int grand = 2166136261u;

    /* leg 1: the sweep */
    for (sc = 1; sc <= 8; sc++) {
        for (dc = 1; dc <= 8; dc++) {
            unsigned int pair = 2166136261u;
            for (si = 0; si < 5; si++) {
                for (di = 0; di < 5; di++) {
                    for (ri = 0; ri < 3; ri++) {
                        SDL_AudioSpec s = { FMTS[si], sc, RATES[ri][0] };
                        SDL_AudioSpec d = { FMTS[di], dc, RATES[ri][1] };
                        SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
                        int got;
                        if (!st) { printf("FAIL create %d %d\n", si, di); return 1; }
                        fill_src(src, FMTS[si], sc, si);
                        if (!SDL_PutAudioStreamData(st, src, NFRAMES * sc * fmt_bytes(FMTS[si]))) { printf("FAIL put\n"); return 1; }
                        if (!SDL_FlushAudioStream(st)) { printf("FAIL flush\n"); return 1; }
                        got = SDL_GetAudioStreamData(st, out, (int)sizeof out);
                        if (got < 0) { printf("FAIL get\n"); return 1; }
                        pair = fnv(pair, out, got);
                        {   /* frame-count sanity rides the hash too */
                            unsigned char nb[4];
                            int frames = got / (dc * fmt_bytes(FMTS[di]));
                            nb[0] = (unsigned char)frames; nb[1] = (unsigned char)(frames >> 8);
                            nb[2] = 0; nb[3] = 0;
                            pair = fnv(pair, nb, 4);
                        }
                        SDL_DestroyAudioStream(st);
                    }
                }
            }
            printf("ch %d->%d %08x\n", sc, dc, pair);
            {
                unsigned char pb[4];
                pb[0] = (unsigned char)pair; pb[1] = (unsigned char)(pair >> 8);
                pb[2] = (unsigned char)(pair >> 16); pb[3] = (unsigned char)(pair >> 24);
                grand = fnv(grand, pb, 4);
            }
        }
    }
    printf("total %08x\n", grand);

    /* leg 2: chunk-boundary invariance — three chunkings, byte-identical */
    {
        static unsigned char a[4096], b[4096], c[4096];
        SDL_AudioSpec s = { SDL_AUDIO_S16, 2, 22050 };
        SDL_AudioSpec d = { SDL_AUDIO_F32, 1, 48000 };
        int lens[3] = { 0, 0, 0 };
        int put_chunk[3] = { NFRAMES * 4, 4, 12 };       /* whole, 1-frame, 3-frame puts */
        int get_chunk[3] = { 4096, 4, 20 };              /* whole, 1-frame, 5-frame gets */
        unsigned char *outs[3];
        int v, i;
        outs[0] = a; outs[1] = b; outs[2] = c;
        fill_src(src, SDL_AUDIO_S16, 2, 2);
        for (v = 0; v < 3; v++) {
            SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
            int off = 0, total = NFRAMES * 4;
            while (off < total) {
                int n = put_chunk[v];
                if (n > total - off) n = total - off;
                SDL_PutAudioStreamData(st, src + off, n);
                off += n;
            }
            SDL_FlushAudioStream(st);
            for (;;) {
                int g = SDL_GetAudioStreamData(st, outs[v] + lens[v], get_chunk[v]);
                if (g <= 0) break;
                lens[v] += g;
            }
            SDL_DestroyAudioStream(st);
        }
        i = (lens[0] == lens[1] && lens[1] == lens[2] &&
             memcmp(a, b, (size_t)lens[0]) == 0 && memcmp(a, c, (size_t)lens[0]) == 0);
        printf("chunk invariance %s (%d bytes)\n", i ? "MATCH" : "MISMATCH", lens[0]);
    }

    /* leg 3: saturation of out-of-range float input into each integer format */
    {
        float loud[4] = { 2.0f, -2.0f, 1.0f, -1.0f };
        SDL_AudioSpec s = { SDL_AUDIO_F32, 1, 48000 };
        int di2;
        for (di2 = 0; di2 < 4; di2++) {
            SDL_AudioSpec d = { FMTS[di2], 1, 48000 };
            SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
            unsigned char ob[16];
            int g;
            SDL_PutAudioStreamData(st, loud, sizeof loud);
            SDL_FlushAudioStream(st);
            g = SDL_GetAudioStreamData(st, ob, (int)sizeof ob);
            if (FMTS[di2] == SDL_AUDIO_U8)
                printf("sat U8 %d: %u %u %u %u\n", g, ob[0], ob[1], ob[2], ob[3]);
            else if (FMTS[di2] == SDL_AUDIO_S8)
                printf("sat S8 %d: %d %d %d %d\n", g, (int)(signed char)ob[0], (int)(signed char)ob[1], (int)(signed char)ob[2], (int)(signed char)ob[3]);
            else if (FMTS[di2] == SDL_AUDIO_S16) {
                short v[4]; memcpy(v, ob, 8);
                printf("sat S16 %d: %d %d %d %d\n", g, v[0], v[1], v[2], v[3]);
            } else {
                int v[4]; memcpy(v, ob, 16);
                printf("sat S32 %d: %d %d %d %d\n", g, v[0], v[1], v[2], v[3]);
            }
            SDL_DestroyAudioStream(st);
        }
    }

    /* leg 4: upsample tail holds the last source frame */
    {
        SDL_AudioSpec s = { SDL_AUDIO_S16, 1, 16000 };
        SDL_AudioSpec d = { SDL_AUDIO_S16, 1, 48000 };
        SDL_AudioStream *st = SDL_CreateAudioStream(&s, &d);
        short in[3] = { 300, 600, 900 };
        short ob[16];
        int g, i;
        SDL_PutAudioStreamData(st, in, sizeof in);
        printf("tail avail unflushed %d\n", SDL_GetAudioStreamAvailable(st));
        SDL_FlushAudioStream(st);
        printf("tail avail flushed %d\n", SDL_GetAudioStreamAvailable(st));
        g = SDL_GetAudioStreamData(st, ob, (int)sizeof ob);
        printf("tail got %d:", g);
        for (i = 0; i < g / 2; i++) printf(" %d", (int)ob[i]);
        printf("\n");
        SDL_DestroyAudioStream(st);
    }
    return 0;
}
