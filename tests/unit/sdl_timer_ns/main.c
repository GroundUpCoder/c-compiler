/* #495: SDL_GetPerformanceCounter / SDL_GetPerformanceFrequency /
   SDL_GetTicksNS — the sub-millisecond timing surface frame pacing is written
   against. All three ride the clock SDL_GetTicks truncates; the counter unit
   is fixed at ns (freq 1e9, as on SDL3's POSIX clock_gettime backends).
   The "sub-ms resolution" probe is the regression guard for the host clock:
   __sdl_get_ticks used to be floored to whole ms, which would make every
   TicksNS value a multiple of 1e6 and quantise dt to the very judder this API
   exists to remove. No wall-clock tolerances here — only monotonicity and
   same-clock relations, so the test cannot flake under load. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    printf("freq: %llu\n", (unsigned long long)SDL_GetPerformanceFrequency());

    Uint64 c1 = SDL_GetPerformanceCounter();
    int advanced = 0;
    for (int i = 0; i < 5000000; i++) {
        if (SDL_GetPerformanceCounter() > c1) { advanced = 1; break; }
    }
    printf("advanced: %d\n", advanced);

    int subms = 0;
    for (int i = 0; i < 1000; i++) {
        if (SDL_GetTicksNS() % 1000000ULL != 0) { subms = 1; break; }
    }
    printf("sub-ms resolution: %d\n", subms);

    Uint64 t = SDL_GetTicks();
    Uint64 n = SDL_GetTicksNS();
    printf("ns not behind ms: %d\n", n / 1000000ULL >= t);
    printf("ns monotonic: %d\n", SDL_GetTicksNS() >= n);
    return 0;
}
