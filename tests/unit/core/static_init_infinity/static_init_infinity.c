#include <stdio.h>
#include <math.h>
#include <float.h>

/* Test that 1.0/0.0 and -1.0/0.0 work as static initializers (IEEE infinity) */

static const double zero = 0.0;
static const double pone = 1.0;
static const double none = -1.0;
static const double pinf = 1.0 / 0.0;
static const double ninf = -1.0 / 0.0;

int main(void) {
    /* Verify static inits are infinity, not zero */
    if (pinf != pone / zero) {
        printf("FAIL: pinf != 1.0/0.0\n");
        return 1;
    }
    if (ninf != none / zero) {
        printf("FAIL: ninf != -1.0/0.0\n");
        return 1;
    }

    /* Verify HUGE_VAL == positive infinity */
#ifdef HUGE_VAL
    if (HUGE_VAL != pinf) {
        printf("FAIL: HUGE_VAL != pinf\n");
        return 1;
    }
    if (-HUGE_VAL != ninf) {
        printf("FAIL: -HUGE_VAL != ninf\n");
        return 1;
    }
#endif

    /* Verify basic infinity arithmetic */
    if (pinf + 1.0 != pinf) {
        printf("FAIL: inf + 1 != inf\n");
        return 1;
    }
    if (!(pinf > 1e308)) {
        printf("FAIL: inf not > 1e308\n");
        return 1;
    }

    printf("PASS\n");
    return 0;
}
