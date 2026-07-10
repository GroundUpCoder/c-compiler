/* Minimal cairo-test.h shim (todos/0061): just enough of the upstream test
 * harness interface that the vendored upstream test .c files compile
 * UNMODIFIED. CAIRO_TEST registers a case struct the runner links against
 * by name; the real harness's target machinery is replaced by runner.c
 * (image backend only, refs compared with buffer-diff-style tolerance). */
#ifndef CAIRO_TEST_H_SHIM
#define CAIRO_TEST_H_SHIM

#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "cairo.h"

typedef enum {
    CAIRO_TEST_SUCCESS = 0,
    CAIRO_TEST_NO_MEMORY,
    CAIRO_TEST_FAILURE,
    CAIRO_TEST_NEW,
    CAIRO_TEST_XFAILURE,
    CAIRO_TEST_ERROR,
    CAIRO_TEST_CRASHED,
    CAIRO_TEST_UNTESTED = 77
} cairo_test_status_t;

/* function TYPES (not pointers) — upstream declares them this way so tests
 * can forward-declare `static cairo_test_draw_function_t draw;` */
typedef cairo_test_status_t (cairo_test_draw_function_t) (cairo_t *cr, int width, int height);
typedef cairo_test_status_t (cairo_test_preamble_function_t) (void *ctx);

typedef struct _cairo_test_case {
    const char *name;
    int width, height;
    cairo_test_preamble_function_t *preamble;
    cairo_test_draw_function_t *draw;
} cairo_test_case_t;

#define CAIRO_TEST(name, description, keywords, requirements, width, height, preamble, draw) \
    const cairo_test_case_t cairo_test_case_##name = { \
        #name, width, height, (cairo_test_preamble_function_t *) (preamble), draw };

/* the one harness helper the vendored tests use */
void cairo_test_paint_checkered (cairo_t *cr);

#endif
