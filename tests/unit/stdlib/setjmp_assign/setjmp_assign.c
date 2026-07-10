/* The assignment forms of the setjmp idiom: the longjmp value is captured
 * into a variable in the if-condition. This is the shape cairo's scan
 * converters use ("if ((status = setjmp (sweep_line.unwind))) return status;")
 * and is common across the C corpus (C11 7.13.1.1p5 allows setjmp as "the
 * entire controlling expression" — the assignment form is ubiquitous even
 * if strictly an extension of that list). */
#include <stdio.h>
#include <setjmp.h>

/* Form 1: if ((v = setjmp(buf))) — truthy branch is the catch */
static jmp_buf b1;
static void fail1(void) { longjmp(b1, 42); }
static void test_direct(void) {
    int status;
    printf("direct: ");
    if ((status = setjmp(b1))) {
        printf("caught %d\n", status);
        return;
    }
    printf("try status=%d ", status);
    fail1();
    printf("SHOULD NOT PRINT\n");
}

/* Form 2: if ((v = setjmp(buf)) == 0) — else branch is the catch */
static void test_eq_zero(void) {
    jmp_buf buf;
    int status;
    printf("eq-zero: ");
    if ((status = setjmp(buf)) == 0) {
        printf("try status=%d ", status);
        longjmp(buf, 7);
        printf("SHOULD NOT PRINT ");
    } else {
        printf("caught %d\n", status);
    }
}

/* Form 3: if ((v = setjmp(buf)) != 0) */
static void test_ne_zero(void) {
    jmp_buf buf;
    int status;
    printf("ne-zero: ");
    if ((status = setjmp(buf)) != 0) {
        printf("caught %d\n", status);
        return;
    }
    printf("try ");
    longjmp(buf, 9);
}

/* C11 7.13.2.1p4: longjmp with val 0 makes setjmp return 1 */
static void test_zero_coerce(void) {
    jmp_buf buf;
    int status;
    printf("zero-coerce: ");
    if ((status = setjmp(buf))) {
        printf("caught %d\n", status);
        return;
    }
    longjmp(buf, 0);
}

/* Struct-field jmp_buf + statements following the setjmp-if (the retry
 * scaffold path), like cairo's sweep_line.unwind. */
typedef struct { jmp_buf unwind; int ncalls; } sweeper;
static void step(sweeper *s) {
    if (++s->ncalls < 3) return;
    longjmp(s->unwind, 5);
}
static int run_sweep(sweeper *s) {
    int status;
    if ((status = setjmp(s->unwind)))
        return status;
    for (;;)
        step(s);
}
static void test_struct_retry(void) {
    sweeper s = { .ncalls = 0 };
    printf("struct: ");
    int r = run_sweep(&s);
    printf("status=%d after %d calls\n", r, s.ncalls);
}

/* The value survives re-jumps: two longjmps through the same buf. */
static jmp_buf b2;
static int attempts;
static void maybe_fail(void) {
    attempts++;
    if (attempts <= 2) longjmp(b2, attempts * 10);
}
static void test_rejump(void) {
    int status;
    printf("rejump: ");
    if ((status = setjmp(b2))) {
        printf("caught %d ", status);
    }
    maybe_fail();
    printf("done after %d attempts\n", attempts);
}

int main(void) {
    test_direct();
    test_eq_zero();
    test_ne_zero();
    test_zero_coerce();
    test_struct_retry();
    test_rejump();
    return 0;
}
