// todos/0332 diagnostic — the ~1000x CPython bytecode-dispatch pathology,
// reproduced with NO Python involved.
//
// Root cause this file exercises: compiler.js chooses `br_table` for a switch
// only when the case-value RANGE is <= 512 (the `dense` test in
// `CodeGenerator.emitStmt`'s SSwitch arm). Above that cap it emits a LINEAR
// `br_if` compare chain, so dispatching to case k costs k comparisons.
//
// That cap is hit two ways, and this file shows both:
//
//   (a) directly — a switch with more than 512 case values (-DOPS=1024);
//   (b) indirectly, and far more damagingly — via the loop-switch
//       ("irreducible") lowering. A function whose gotos our structured
//       emitter cannot place is rewritten into `while (1) switch (__state)`
//       with ONE CASE PER BASIC BLOCK. That synthetic switch is perfectly
//       dense (ids 0..N-1) but its range is the function's block count, so
//       any function with >512 blocks dispatches every single block
//       transition through a linear scan. CPython's _PyEval_EvalFrameDefault
//       has 5752 blocks -> a 5752-entry compare chain, ~2876 compares per
//       bytecode.
//
// This is `_PyEval_EvalFrameDefault` in miniature: a `dispatch:` label, a wide
// opcode switch, each opcode ending in a backward `goto dispatch`, and a
// forward `goto error` out of the switch into a label the switch body cannot
// see. That last edge is what defeats structured emit (CPython's ceval does
// exactly this with `goto error` / `goto exit_unwind`).
//
// Two knobs, both compile-time, so the four builds differ ONLY in codegen:
//
//   -DIRRED=0   structured emit succeeds   -> ordinary switch codegen
//   -DIRRED=1   structured emit fails      -> loop-switch state machine
//   -DOPS=256   opcode switch range 256    -> under the 512 cap
//   -DOPS=1024  opcode switch range 1024   -> over it
//
// Driver: `sh mk-reloop.sh <outdir>` builds all four and runs them.
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#ifndef IRRED
#define IRRED 1
#endif
#ifndef OPS
#define OPS 1024
#endif

static long long now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

// Opcode bodies, built by doubling. Each is its own basic block, which is what
// makes the state machine's case count large — the lowering's pathology is a
// function of BLOCK count, not of user case count.
#define OP1(n)    case (n): acc = (acc + (n) * 7) & 0xFFFF; goto dispatch;
#define OP4(b)    OP1((b)+0)   OP1((b)+1)   OP1((b)+2)   OP1((b)+3)
#define OP16(b)   OP4((b)+0)   OP4((b)+4)   OP4((b)+8)   OP4((b)+12)
#define OP64(b)   OP16((b)+0)  OP16((b)+16) OP16((b)+32) OP16((b)+48)
#define OP256(b)  OP64((b)+0)  OP64((b)+64) OP64((b)+128) OP64((b)+192)
#define OP1024(b) OP256((b)+0) OP256((b)+256) OP256((b)+512) OP256((b)+768)

#if OPS == 256
#define OPBODIES  OP256(0)
#define PROGLEN   251     /* prime: the opcode stream never falls into a short cycle */
#elif OPS == 1024
#define OPBODIES  OP1024(0)
#define PROGLEN   1021
#else
#error "OPS must be 256 or 1024"
#endif

static unsigned short prog[PROGLEN];
static volatile int sink;

static int run(int nsteps) {
    int pc = 0, acc = 0, steps = nsteps, op;

dispatch:
    if (--steps < 0) goto done;
    op = prog[pc++];
    if (pc == PROGLEN) pc = 0;
    switch (op) {
        OPBODIES
#if IRRED
        default: goto error;
#else
        default: acc ^= 1; goto dispatch;
#endif
    }

#if IRRED
error:
    acc ^= 0x5555;
    goto dispatch;
#endif

done:
    return acc;
}

int main(int argc, char **argv) {
    int n = argc > 1 ? atoi(argv[1]) : 500000;
    for (int i = 0; i < PROGLEN; i++) prog[i] = (unsigned short)((i * 37) & (OPS - 1));

    sink = run(2000);   /* warm */

    long long t0 = now_ns();
    int r = run(n);
    long long t1 = now_ns();
    sink = r;
    printf("reloop OPS=%d IRRED=%d  %d steps  %lld ns  (%.1f ns/step)  acc=%d\n",
           OPS, IRRED, n, t1 - t0, (double)(t1 - t0) / n, r);
    return 0;
}
