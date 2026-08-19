/* oracle.c — the pinned-upstream executable oracle for #529-B (#723).
 *
 * Built NATIVELY against upstream SDL at the pin (libsdl-org/SDL tag
 * release-3.4.0, commit a962f40bbba175e9716557a25d5d7965f134a3d3), this
 * program runs the real upstream SDL_LoadWAV over every fixture and prints
 * one JSON line per file: success, spec, length, SHA-256 of the decoded
 * bytes, or the upstream error string. gen-manifest.mjs collects the output
 * into manifest.json — the committed reference the in-tree differential test
 * (tests/host/test_sdl_loadwav_diff.js) compares the gucOS loader against.
 *
 * Build recipe (recorded in ../sdl_load_wav/upstream.json; macOS host):
 *   cmake -S SDL -B build -DCMAKE_BUILD_TYPE=Release -DSDL_STATIC=ON \
 *     -DSDL_SHARED=OFF -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF -DSDL_VIDEO=OFF \
 *     -DSDL_RENDER=OFF -DSDL_GPU=OFF -DSDL_CAMERA=OFF -DSDL_JOYSTICK=OFF \
 *     -DSDL_HAPTIC=OFF -DSDL_SENSOR=OFF -DSDL_POWER=OFF -DSDL_DIALOG=OFF
 *   cmake --build build -j8
 *   clang -O2 oracle.c -ISDL/include build/libSDL3.a <frameworks from sdl3.pc>
 *
 * No hints are set, so the oracle runs upstream's 3.4.0 DEFAULT hint
 * behavior — exactly the behavior the gucOS adaptation freezes in.
 */
#include <SDL3/SDL.h>
#include <stdio.h>
#include <CommonCrypto/CommonDigest.h>

static void print_escaped(const char *s)
{
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') putchar('\\');
        putchar(*s);
    }
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        SDL_AudioSpec spec;
        Uint8 *buf = (Uint8 *)0xdeadbeef;
        Uint32 len = 0xdeadbeef;
        SDL_ClearError();
        bool ok = SDL_LoadWAV(argv[i], &spec, &buf, &len);
        printf("{\"file\":\"");
        print_escaped(argv[i]);
        printf("\",\"ok\":%s", ok ? "true" : "false");
        if (ok) {
            unsigned char d[CC_SHA256_DIGEST_LENGTH];
            CC_SHA256(buf ? buf : (const Uint8 *)"", len, d);
            printf(",\"format\":%d,\"channels\":%d,\"freq\":%d,\"len\":%u,\"bufnull\":%s,\"sha256\":\"",
                   (int)spec.format, spec.channels, spec.freq, (unsigned)len,
                   buf ? "false" : "true");
            for (int j = 0; j < CC_SHA256_DIGEST_LENGTH; j++) printf("%02x", d[j]);
            printf("\"");
            SDL_free(buf);
        } else {
            printf(",\"error\":\"");
            print_escaped(SDL_GetError());
            printf("\"");
        }
        printf("}\n");
    }
    return 0;
}
