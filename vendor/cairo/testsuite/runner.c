/* Upstream-cairo-test runner (todos/0061): renders each vendored upstream
 * test (image backend, ARGB32, CLEAR-initialized — matching what
 * cairo-test.c does for the image target) and compares against the
 * upstream reference PNG à la buffer-diff: a per-channel tolerance and a
 * hard cap on outlier pixels.
 *
 *   cairotests <reference-dir>
 *
 * cairo_test_paint_checkered is reimplemented here verbatim from
 * upstream cairo-test.c (_draw_check + the pattern setup).
 */
#include "cairo-test.h"
#include <stdlib.h>

/* Upstream compares with a perceptual diff (pdiff) after an exact buffer
 * diff; we approximate: tiny per-channel jitter on AA seams is allowed
 * (observed worst: 9/255 on dash-curve — float rounding vs the pixman
 * that rendered the refs), but any REAL rendering error produces
 * high-contrast pixels, which HARD_TOLERANCE catches regardless. */
#define TOLERANCE 3       /* per-channel slack before a pixel is an outlier */
#define HARD_TOLERANCE 16 /* no pixel may differ more than this, ever */
#define MAX_OUTLIERS(npx) ((npx) / 1000 > 32 ? (npx) / 1000 : 32)

extern const cairo_test_case_t
    cairo_test_case_fill_rule,
    cairo_test_case_caps_joins,
    cairo_test_case_paint,
    cairo_test_case_gradient_alpha,
    cairo_test_case_linear_gradient_reflect,
    cairo_test_case_rounded_rectangle_fill,
    cairo_test_case_rounded_rectangle_stroke,
    cairo_test_case_dash_curve,
    cairo_test_case_miter_precision,
    cairo_test_case_random_intersections_eo,
    cairo_test_case_mesh_pattern_overlap,
    cairo_test_case_clip_fill,
    cairo_test_case_unaligned_box,
    cairo_test_case_close_path;

static const struct {
    const cairo_test_case_t *test;
    const char *ref;  /* filename under the reference dir */
} cases[] = {
    { &cairo_test_case_fill_rule,                "fill-rule.argb32.ref.png" },
    { &cairo_test_case_caps_joins,               "caps-joins.ref.png" },
    { &cairo_test_case_paint,                    "paint.ref.png" },
    { &cairo_test_case_gradient_alpha,           "gradient-alpha.ref.png" },
    { &cairo_test_case_linear_gradient_reflect,  "linear-gradient-reflect.ref.png" },
    { &cairo_test_case_rounded_rectangle_fill,   "rounded-rectangle-fill.ref.png" },
    { &cairo_test_case_rounded_rectangle_stroke, "rounded-rectangle-stroke.ref.png" },
    { &cairo_test_case_dash_curve,               "dash-curve.ref.png" },
    { &cairo_test_case_miter_precision,          "miter-precision.ref.png" },
    { &cairo_test_case_random_intersections_eo,  "random-intersections-eo.ref.png" },
    { &cairo_test_case_mesh_pattern_overlap,     "mesh-pattern-overlap.ref.png" },
    { &cairo_test_case_clip_fill,                "clip-fill.ref.png" },
    { &cairo_test_case_unaligned_box,            "unaligned-box.ref.png" },
    { &cairo_test_case_close_path,               "close-path.ref.png" },
};

/* ---- cairo_test_paint_checkered, verbatim from cairo-test.c ---- */
static cairo_surface_t *
_draw_check (int width, int height)
{
    cairo_surface_t *surface;
    cairo_t *cr;

    surface = cairo_image_surface_create (CAIRO_FORMAT_RGB24, 12, 12);
    cr = cairo_create (surface);
    cairo_surface_destroy (surface);

    cairo_set_source_rgb (cr, 0.75, 0.75, 0.75); /* light gray */
    cairo_paint (cr);

    cairo_set_source_rgb (cr, 0.25, 0.25, 0.25); /* dark gray */
    cairo_rectangle (cr, width / 2,  0, width / 2, height / 2);
    cairo_rectangle (cr, 0, height / 2, width / 2, height / 2);
    cairo_fill (cr);

    surface = cairo_surface_reference (cairo_get_target (cr));
    cairo_destroy (cr);

    return surface;
}

void
cairo_test_paint_checkered (cairo_t *cr)
{
    cairo_surface_t *check;

    check = _draw_check (12, 12);

    cairo_save (cr);
    cairo_set_source_surface (cr, check, 0, 0);
    cairo_surface_destroy (check);

    cairo_pattern_set_filter (cairo_get_source (cr), CAIRO_FILTER_NEAREST);
    cairo_pattern_set_extend (cairo_get_source (cr), CAIRO_EXTEND_REPEAT);
    cairo_paint (cr);

    cairo_restore (cr);
}

/* ---- diff ---- */
static int run_one (const cairo_test_case_t *t, const char *refdir, const char *refname) {
    cairo_surface_t *out = cairo_image_surface_create (CAIRO_FORMAT_ARGB32,
                                                       t->width, t->height);
    cairo_t *cr = cairo_create (out);

    /* the harness's initial clear */
    cairo_save (cr);
    cairo_set_operator (cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint (cr);
    cairo_restore (cr);

    cairo_save (cr);
    cairo_test_status_t st = t->draw (cr, t->width, t->height);
    cairo_restore (cr);
    cairo_destroy (cr);
    cairo_surface_flush (out);

    if (st != CAIRO_TEST_SUCCESS || cairo_surface_status (out) != CAIRO_STATUS_SUCCESS) {
        printf ("FAIL %s: draw status %d / surface %s\n", t->name, (int) st,
                cairo_status_to_string (cairo_surface_status (out)));
        cairo_surface_destroy (out);
        return 1;
    }

    char path[512];
    snprintf (path, sizeof path, "%s/%s", refdir, refname);
    cairo_surface_t *ref = cairo_image_surface_create_from_png (path);
    if (cairo_surface_status (ref) != CAIRO_STATUS_SUCCESS) {
        printf ("FAIL %s: cannot read %s (%s)\n", t->name, path,
                cairo_status_to_string (cairo_surface_status (ref)));
        cairo_surface_destroy (out);
        cairo_surface_destroy (ref);
        return 1;
    }

    int w = cairo_image_surface_get_width (ref), h = cairo_image_surface_get_height (ref);
    if (w != t->width || h != t->height) {
        printf ("FAIL %s: ref is %dx%d, test is %dx%d\n", t->name, w, h, t->width, t->height);
        cairo_surface_destroy (out);
        cairo_surface_destroy (ref);
        return 1;
    }

    const unsigned char *pa = cairo_image_surface_get_data (out);
    const unsigned char *pb = cairo_image_surface_get_data (ref);
    int sa = cairo_image_surface_get_stride (out);
    int sb = cairo_image_surface_get_stride (ref);
    /* the from-png surface may be RGB24 (opaque refs); both are 32-bit */
    int ref_has_alpha = cairo_image_surface_get_format (ref) == CAIRO_FORMAT_ARGB32;

    long outliers = 0, worst = 0, diffpx = 0;
    for (int y = 0; y < h; y++) {
        const uint32_t *ra = (const uint32_t *) (pa + y * sa);
        const uint32_t *rb = (const uint32_t *) (pb + y * sb);
        for (int x = 0; x < w; x++) {
            uint32_t a = ra[x], b = rb[x];
            if (!ref_has_alpha) b |= 0xFF000000u;   /* compare vs opaque */
            if (a == b) continue;
            diffpx++;
            int md = 0;
            for (int c = 0; c < 4; c++) {
                int d = abs ((int) ((a >> (c * 8)) & 0xff) - (int) ((b >> (c * 8)) & 0xff));
                if (d > md) md = d;
            }
            if (md > worst) worst = md;
            if (md > TOLERANCE) outliers++;
        }
    }

    int ok = outliers <= MAX_OUTLIERS ((long) w * h) && worst <= HARD_TOLERANCE;
    printf ("%s %s: %ldpx differ, %ld beyond tol %d, worst %ld\n",
            ok ? "ok" : "FAIL", t->name, diffpx, outliers, TOLERANCE, worst);
    cairo_surface_destroy (out);
    cairo_surface_destroy (ref);
    return !ok;
}

int main (int argc, char **argv) {
    const char *refdir = argc > 1 ? argv[1] : "reference";
    int fails = 0, n = (int) (sizeof cases / sizeof cases[0]);
    for (int i = 0; i < n; i++)
        fails += run_one (cases[i].test, refdir, cases[i].ref);
    printf (fails ? "cairotests: %d/%d FAILED\n" : "cairotests: %d upstream tests ok\n",
            fails ? fails : n, n);
    return fails ? 1 : 0;
}
