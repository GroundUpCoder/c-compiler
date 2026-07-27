// bench-2x2 diagnostic: is the ~1000x CPython gap a general codegen property,
// or something CPython-specific?
//
// Three shapes, each timed separately, no Python involved:
//   1. tight arithmetic loop        -- baseline codegen quality
//   2. 64-case switch dispatch loop -- CPython's eval loop in miniature; a
//                                      switch lowered to a linear compare
//                                      chain instead of a br_table costs O(n)
//                                      per dispatch
//   3. indirect call through a table -- the other candidate hot path
#include <stdio.h>
#include <time.h>

static long long now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static volatile int sink;

static int loop_arith(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = (acc + i * 3) % 1000003;
    return acc;
}

static int loop_switch(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) {
        switch (i & 63) {
            case 0:  acc += 1; break;   case 1:  acc += 2; break;
            case 2:  acc += 3; break;   case 3:  acc += 4; break;
            case 4:  acc += 5; break;   case 5:  acc += 6; break;
            case 6:  acc += 7; break;   case 7:  acc += 8; break;
            case 8:  acc += 9; break;   case 9:  acc += 10; break;
            case 10: acc += 11; break;  case 11: acc += 12; break;
            case 12: acc += 13; break;  case 13: acc += 14; break;
            case 14: acc += 15; break;  case 15: acc += 16; break;
            case 16: acc += 17; break;  case 17: acc += 18; break;
            case 18: acc += 19; break;  case 19: acc += 20; break;
            case 20: acc += 21; break;  case 21: acc += 22; break;
            case 22: acc += 23; break;  case 23: acc += 24; break;
            case 24: acc += 25; break;  case 25: acc += 26; break;
            case 26: acc += 27; break;  case 27: acc += 28; break;
            case 28: acc += 29; break;  case 29: acc += 30; break;
            case 30: acc += 31; break;  case 31: acc += 32; break;
            case 32: acc += 33; break;  case 33: acc += 34; break;
            case 34: acc += 35; break;  case 35: acc += 36; break;
            case 36: acc += 37; break;  case 37: acc += 38; break;
            case 38: acc += 39; break;  case 39: acc += 40; break;
            case 40: acc += 41; break;  case 41: acc += 42; break;
            case 42: acc += 43; break;  case 43: acc += 44; break;
            case 44: acc += 45; break;  case 45: acc += 46; break;
            case 46: acc += 47; break;  case 47: acc += 48; break;
            case 48: acc += 49; break;  case 49: acc += 50; break;
            case 50: acc += 51; break;  case 51: acc += 52; break;
            case 52: acc += 53; break;  case 53: acc += 54; break;
            case 54: acc += 55; break;  case 55: acc += 56; break;
            case 56: acc += 57; break;  case 57: acc += 58; break;
            case 58: acc += 59; break;  case 59: acc += 60; break;
            case 60: acc += 61; break;  case 61: acc += 62; break;
            case 62: acc += 63; break;  default: acc += 64; break;
        }
    }
    return acc;
}

static int f0(int a) { return a + 1; }
static int f1(int a) { return a + 2; }
static int f2(int a) { return a + 3; }
static int f3(int a) { return a + 4; }
typedef int (*fp)(int);
static fp table[4] = { f0, f1, f2, f3 };

static int loop_icall(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) acc = table[i & 3](acc) & 0xFFFFF;
    return acc;
}

int main(void) {
    const int N = 2000000;
    long long t0, t1;

    t0 = now_ns(); sink = loop_arith(N);  t1 = now_ns();
    printf("arith  %d iters  %lld ns  (%.1f ns/iter)\n", N, t1 - t0, (double)(t1 - t0) / N);

    t0 = now_ns(); sink = loop_switch(N); t1 = now_ns();
    printf("switch %d iters  %lld ns  (%.1f ns/iter)\n", N, t1 - t0, (double)(t1 - t0) / N);

    t0 = now_ns(); sink = loop_icall(N);  t1 = now_ns();
    printf("icall  %d iters  %lld ns  (%.1f ns/iter)\n", N, t1 - t0, (double)(t1 - t0) / N);
    return 0;
}
