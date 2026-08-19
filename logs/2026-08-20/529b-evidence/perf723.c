/* perf723.c — #723 per-codec decode/heap measurement (dev-log evidence).
 * argv[1..] = wav files (the gen-fixtures.mjs --perf corpus: 5 s at 44.1 kHz
 * per codec). Prints, per file: decoded bytes, min/median decode ms over 7
 * runs, heap used while the buffer is live, and heap-balance after free. */
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>

static long heap_used(void) {
    struct __heap_info h;
    __inspect_heap(&h);
    return h.total_bytes - h.free_bytes;
}

static int cmp_d(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y ? 1 : 0;
}

int main(int argc, char **argv) {
    /* Warm the allocator pool to its high-water mark first: TLSF pool GROWTH
       costs a one-time 8-byte used sentinel per grown segment (measured with
       a pure malloc/free control, zero SDL involved — growdiag in the #723
       dev log), which would otherwise read as a spurious "leak" on whichever
       file happens to grow the pool. */
    for (int i = 1; i < argc; i++) {
        SDL_AudioSpec spec; Uint8 *buf; Uint32 len;
        if (SDL_LoadWAV(argv[i], &spec, &buf, &len)) SDL_free(buf);
    }
    for (int i = 1; i < argc; i++) {
        double ms[7];
        Uint32 len = 0;
        long live = 0;
        long before = heap_used();
        for (int r = 0; r < 7; r++) {
            SDL_AudioSpec spec; Uint8 *buf;
            Uint64 t0 = SDL_GetPerformanceCounter();
            if (!SDL_LoadWAV(argv[i], &spec, &buf, &len)) { printf("FAIL %s %s\n", argv[i], SDL_GetError()); return 1; }
            Uint64 t1 = SDL_GetPerformanceCounter();
            ms[r] = (double)(t1 - t0) * 1000.0 / (double)SDL_GetPerformanceFrequency();
            live = heap_used() - before;
            SDL_free(buf);
        }
        qsort(ms, 7, sizeof(double), cmp_d);
        printf("%s bytes=%u min=%.2fms p50=%.2fms live-heap=%ld balanced=%d\n",
               argv[i], (unsigned)len, ms[0], ms[3], live, heap_used() == before);
    }
    return 0;
}
