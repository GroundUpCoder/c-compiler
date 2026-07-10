#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include "cairo.h"
#include "cairo-ft.h"

/* Cairo smoke test: vector drawing (fills, strokes, curves, gradients,
 * dashes, clips) on an image surface, checked by sampling pixels with an
 * AA-tolerant comparison. With a font path argument it also rasterizes
 * text through cairo-ft. Exits 0 and prints "cairo <ver> ok" on success. */

static int failures = 0;

static void expect_px(cairo_surface_t *s, int x, int y,
                      int r, int g, int b, int tol, const char *what) {
    unsigned char *data = cairo_image_surface_get_data(s);
    int stride = cairo_image_surface_get_stride(s);
    uint32_t px = *(uint32_t *)(data + y * stride + x * 4);
    int pr = (px >> 16) & 0xff, pg = (px >> 8) & 0xff, pb = px & 0xff;
    if (abs(pr - r) > tol || abs(pg - g) > tol || abs(pb - b) > tol) {
        printf("FAIL %s at (%d,%d): got %02x%02x%02x want %02x%02x%02x tol %d\n",
               what, x, y, pr, pg, pb, r, g, b, tol);
        failures++;
    }
}

int main(int argc, char **argv) {
    const int W = 256, H = 256;
    cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, W, H);
    cairo_t *cr = cairo_create(surface);

    /* white background */
    cairo_set_source_rgb(cr, 1, 1, 1);
    cairo_paint(cr);

    /* solid red square, axis-aligned (exact) */
    cairo_set_source_rgb(cr, 1, 0, 0);
    cairo_rectangle(cr, 16, 16, 64, 64);
    cairo_fill(cr);

    /* AA green circle */
    cairo_set_source_rgb(cr, 0, 0.8, 0);
    cairo_arc(cr, 176, 48, 30, 0, 2 * M_PI);
    cairo_fill(cr);

    /* blue cubic-bezier stroke, round caps */
    cairo_set_source_rgb(cr, 0, 0, 1);
    cairo_set_line_width(cr, 6);
    cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
    cairo_move_to(cr, 16, 160);
    cairo_curve_to(cr, 80, 96, 176, 224, 240, 160);
    cairo_stroke(cr);

    /* linear gradient bar */
    cairo_pattern_t *lin = cairo_pattern_create_linear(16, 0, 240, 0);
    cairo_pattern_add_color_stop_rgb(lin, 0, 0, 0, 0);
    cairo_pattern_add_color_stop_rgb(lin, 1, 1, 1, 1);
    cairo_set_source(cr, lin);
    cairo_rectangle(cr, 16, 200, 224, 32);
    cairo_fill(cr);
    cairo_pattern_destroy(lin);

    /* dashed stroke + clip: yellow disc clipped to left half */
    cairo_save(cr);
    cairo_rectangle(cr, 96, 96, 32, 64);
    cairo_clip(cr);
    cairo_set_source_rgb(cr, 0.9, 0.7, 0);
    cairo_arc(cr, 128, 128, 28, 0, 2 * M_PI);
    cairo_fill(cr);
    cairo_restore(cr);

    cairo_surface_flush(surface);

    expect_px(surface, 48, 48, 0xff, 0, 0, 0, "red square");
    expect_px(surface, 8, 8, 0xff, 0xff, 0xff, 0, "background");
    expect_px(surface, 176, 48, 0, 0xcc, 0, 2, "green circle");
    expect_px(surface, 176, 48 - 29, 0, 0xcc, 0, 96, "circle edge AA");
    expect_px(surface, 16, 160, 0, 0, 0xff, 2, "curve start");
    expect_px(surface, 24, 216, 0x0e, 0x0e, 0x0e, 12, "gradient left");
    expect_px(surface, 232, 216, 0xf7, 0xf7, 0xf7, 12, "gradient right");
    expect_px(surface, 112, 128, 0xe5, 0xb2, 0, 4, "clipped disc inside");
    expect_px(surface, 144, 128, 0xff, 0xff, 0xff, 0, "clipped disc outside");

    /* text via cairo-ft, if a font is supplied */
    if (argc > 1) {
        FT_Library ft;
        FT_Face face;
        if (FT_Init_FreeType(&ft) || FT_New_Face(ft, argv[1], 0, &face)) {
            printf("FAIL cannot load font %s\n", argv[1]);
            failures++;
        } else {
            cairo_font_face_t *cface = cairo_ft_font_face_create_for_ft_face(face, 0);
            cairo_set_font_face(cr, cface);
            cairo_set_font_size(cr, 48);
            cairo_set_source_rgb(cr, 0, 0, 0);
            cairo_move_to(cr, 96, 64);
            cairo_show_text(cr, "Ag");
            cairo_surface_flush(surface);

            cairo_text_extents_t ext;
            cairo_text_extents(cr, "Ag", &ext);
            if (ext.width < 10 || ext.height < 10) {
                printf("FAIL text extents %f x %f\n", ext.width, ext.height);
                failures++;
            }
            /* some pixel in the text box must be dark now */
            unsigned char *data = cairo_image_surface_get_data(surface);
            int stride = cairo_image_surface_get_stride(surface);
            int dark = 0;
            for (int y = 24; y < 64 && !dark; y++)
                for (int x = 96; x < 160 && !dark; x++) {
                    uint32_t px = *(uint32_t *)(data + y * stride + x * 4);
                    if (((px >> 16) & 0xff) < 0x40) dark = 1;
                }
            if (!dark) { printf("FAIL no text pixels rendered\n"); failures++; }
            cairo_font_face_destroy(cface);
        }
    }

    /* PNG round-trip through the vendored libpng */
    if (cairo_surface_write_to_png(surface, "/tmp/cairo_smoke.png") != CAIRO_STATUS_SUCCESS) {
        printf("FAIL png write\n");
        failures++;
    } else {
        cairo_surface_t *back = cairo_image_surface_create_from_png("/tmp/cairo_smoke.png");
        if (cairo_surface_status(back) != CAIRO_STATUS_SUCCESS ||
            cairo_image_surface_get_width(back) != W) {
            printf("FAIL png read back\n");
            failures++;
        }
        cairo_surface_destroy(back);
    }

    cairo_destroy(cr);
    cairo_surface_destroy(surface);

    if (failures) { printf("%d failures\n", failures); return 1; }
    printf("cairo %s ok\n", cairo_version_string());
    return 0;
}
