/* SDL_Delay is a real cooperative/blocking sleep wherever blocking is legal
   (todos/0224): the unit runner executes in a worker thread, so the delay is
   honoured and execution continues past it. The pre-0224 contract (throw
   uniformly, "after delay" unreachable) applies ONLY to the standalone
   main-thread-browser flavor, which is pinned by
   tests/kernel/test_sdl_delay_e2e.js. This test pins the sleep-succeeds
   contract: both lines print, the elapsed ticks cover the requested duration,
   and main returns 0. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("before delay\n");
    Uint64 t0 = SDL_GetTicks();
    SDL_Delay(50);
    Uint64 dt = SDL_GetTicks() - t0;
    printf("after delay\n");
    if (dt < 40) {
        printf("delay too short: %llu ms\n", (unsigned long long)dt);
        return 1;
    }
    return 0;
}
