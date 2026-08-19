/* SDL_MixAudio (#722 / #529-A): pinned release-3.4.0 src/audio/SDL_mixer.c
   semantics — volume quantized to round-half-away(fvolume*128) with 0 a
   successful no-op and no clamping of the volume itself, truncating integer
   scaling ((s*v)/128, C truncation), saturation to each integer format's
   exact range, the U8 bias-table mix, raw-float volume on the F32 path with
   a [-1, 1] clamp, and forward per-sample iteration (which pins overlap
   behavior). expected.stdout is hand-derived from the pinned source. */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    /* U8: bias 128, table mix, floor/ceiling clip, half and negative volume */
    {
        Uint8 d[6] = { 128, 68, 228, 128, 128, 10 };
        Uint8 s[6] = { 178, 28, 228, 228, 178, 10 };
        Uint8 d2[6];
        printf("u8 full %d:", (int)SDL_MixAudio(d, s, SDL_AUDIO_U8, 6, 1.0f));
        for (int i = 0; i < 6; i++) printf(" %u", d[i]);
        printf("\n");
        memcpy(d2, (Uint8[6]){ 128, 128, 128, 128, 128, 128 }, 6);
        printf("u8 half %d:", (int)SDL_MixAudio(d2, s, SDL_AUDIO_U8, 6, 0.5f));
        for (int i = 0; i < 6; i++) printf(" %u", d2[i]);
        printf("\n");
        memcpy(d2, (Uint8[6]){ 128, 128, 128, 128, 128, 128 }, 6);
        printf("u8 neg %d:", (int)SDL_MixAudio(d2, s, SDL_AUDIO_U8, 6, -1.0f));
        for (int i = 0; i < 6; i++) printf(" %u", d2[i]);
        printf("\n");
    }
    /* S8: extrema clip */
    {
        signed char d[4] = { 100, -100, 27, -27 };
        const signed char s[4] = { 100, -100, 100, -100 };
        printf("s8 %d:", (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S8, 4, 1.0f));
        for (int i = 0; i < 4; i++) printf(" %d", (int)d[i]);
        printf("\n");
    }
    /* S16: extrema, truncation toward zero, amplification, quantization */
    {
        short d[4] = { 1, -1, 100, 100 };
        const short s[4] = { 32767, -32768, 51, -51 };
        printf("s16 halfmix %d:", (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S16, 8, 0.5f));
        for (int i = 0; i < 4; i++) printf(" %d", (int)d[i]);
        printf("\n");
        short d2[3] = { 1, -1, 0 };
        const short s2[3] = { 32767, -32768, 1000 };
        printf("s16 clip %d:", (int)SDL_MixAudio((Uint8 *)d2, (const Uint8 *)s2, SDL_AUDIO_S16, 6, 1.0f));
        for (int i = 0; i < 3; i++) printf(" %d", (int)d2[i]);
        printf("\n");
        short d3[2] = { 0, 0 };
        const short s3[2] = { 1000, -1000 };
        printf("s16 x2 %d:", (int)SDL_MixAudio((Uint8 *)d3, (const Uint8 *)s3, SDL_AUDIO_S16, 4, 2.0f));
        for (int i = 0; i < 2; i++) printf(" %d", (int)d3[i]);
        printf("\n");
        short d4[2] = { 5, 5 };
        const short s4[2] = { 32767, -100 };
        printf("s16 q127 %d:", (int)SDL_MixAudio((Uint8 *)d4, (const Uint8 *)s4, SDL_AUDIO_S16, 4, 0.996f));
        for (int i = 0; i < 2; i++) printf(" %d", (int)d4[i]);
        printf("\n");
    }
    /* S32: 64-bit accumulate + clip */
    {
        int d[3] = { 2000000000, -2000000000, 7 };
        const int s[3] = { 2000000000, -2000000000, -12 };
        printf("s32 %d:", (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S32, 12, 1.0f));
        for (int i = 0; i < 3; i++) printf(" %d", d[i]);
        printf("\n");
    }
    /* F32: raw float volume, [-1, 1] clamp */
    {
        float d[4] = { 0.75f, -0.75f, 0.25f, 0.0f };
        const float s[4] = { 0.5f, -0.5f, 0.25f, 0.5f };
        int ok = (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_F32, 16, 1.0f);
        printf("f32 clamp %d: %g %g %g %g\n", ok, d[0], d[1], d[2], d[3]);
        float d2[2] = { 0.5f, 0.5f };
        const float s2[2] = { 0.5f, -0.5f };
        ok = (int)SDL_MixAudio((Uint8 *)d2, (const Uint8 *)s2, SDL_AUDIO_F32, 8, 0.25f);
        printf("f32 kvol %d: %g %g\n", ok, d2[0], d2[1]);
    }
    /* volume 0 (and sub-half-step volume) is a successful no-op */
    {
        short d[2] = { 123, -123 };
        const short s[2] = { 1000, 1000 };
        int a = (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S16, 4, 0.0f);
        int b = (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S16, 4, 0.0038f);
        printf("vol0 %d %d: %d %d\n", a, b, (int)d[0], (int)d[1]);
    }
    /* invalid calls: NULL pointers, unknown format, misaligned length —
       refused, dst untouched */
    {
        short d[2] = { 77, -77 };
        const short s[2] = { 1000, 1000 };
        int r1 = (int)SDL_MixAudio(NULL, (const Uint8 *)s, SDL_AUDIO_S16, 4, 1.0f);
        int r2 = (int)SDL_MixAudio((Uint8 *)d, NULL, SDL_AUDIO_S16, 4, 1.0f);
        int r3 = (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, 0x1234, 4, 1.0f);
        int r4 = (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)s, SDL_AUDIO_S16, 3, 1.0f);
        printf("invalid %d %d %d %d: %d %d\n", r1, r2, r3, r4, (int)d[0], (int)d[1]);
    }
    /* overlap: in-place doubling, and dst one sample ahead of src (forward
       iteration reads the already-mixed sample — pinned upstream shape) */
    {
        short d[2] = { 1000, -2000 };
        printf("overlap self %d:", (int)SDL_MixAudio((Uint8 *)d, (const Uint8 *)d, SDL_AUDIO_S16, 4, 1.0f));
        printf(" %d %d\n", (int)d[0], (int)d[1]);
        short b[3] = { 100, 200, 300 };
        printf("overlap fwd %d:", (int)SDL_MixAudio((Uint8 *)(b + 1), (const Uint8 *)b, SDL_AUDIO_S16, 4, 1.0f));
        printf(" %d %d %d\n", (int)b[0], (int)b[1], (int)b[2]);
    }
    return 0;
}
