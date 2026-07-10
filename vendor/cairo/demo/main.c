/* cairodemo — the seeded cairo acceptance app (todos/0061): real vector
 * 2D (gradients, beziers, AA, dashes, alpha, cairo-ft text) drawn by the
 * vendored cairo 1.18.4 into an SDL window surface (= a kernel shm
 * surface, composited like any CPU app).
 *
 * Deterministic for tests, winbox-style:
 *   - fixed logical scene 480x360, cairo_scale'd to the window size
 *   - any KEYDOWN toggles the dark theme (and back)
 *   - SDL_EVENT_WINDOW_RESIZED re-derives the surface and redraws
 *   - SDL_EVENT_QUIT exits 0
 *
 * `cairodemo selftest [font.ttf]` renders the scene headless at 480x360
 * and asserts anchor pixels (AA-tolerant) — no window, exit code = fails.
 * `cairodemo png OUT.png [font.ttf]` dumps the scene for eyeballing.
 * The font defaults to /etc/fonts/mono.ttf then /usr/share/fonts/mono.ttf
 * (term's pair); text is skipped (and selftest fails) without one.
 */
#include <SDL.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <cairo.h>
#include <cairo-ft.h>

#define LW 480
#define LH 360

static SDL_Window *win;
static SDL_Surface *surf;
static int dark = 0;
static int dirty = 1;
static cairo_font_face_t *font_face; /* NULL = no font found */
static FT_Library ft_lib;

static void load_font(const char *override) {
    static const char *paths[] = { "/etc/fonts/mono.ttf", "/usr/share/fonts/mono.ttf" };
    FT_Face face = NULL;
    if (FT_Init_FreeType(&ft_lib)) return;
    if (override && FT_New_Face(ft_lib, override, 0, &face)) face = NULL;
    for (int i = 0; !face && i < 2; i++)
        if (FT_New_Face(ft_lib, paths[i], 0, &face)) face = NULL;
    if (face) font_face = cairo_ft_font_face_create_for_ft_face(face, 0);
}

/* The scene, in 480x360 logical coordinates. */
static void draw_scene(cairo_t *cr, int is_dark) {
    /* background: vertical linear gradient */
    cairo_pattern_t *bg = cairo_pattern_create_linear(0, 0, 0, LH);
    if (is_dark) {
        cairo_pattern_add_color_stop_rgb(bg, 0, 0.13, 0.13, 0.16);
        cairo_pattern_add_color_stop_rgb(bg, 1, 0.22, 0.22, 0.28);
    } else {
        cairo_pattern_add_color_stop_rgb(bg, 0, 0.94, 0.94, 0.96);
        cairo_pattern_add_color_stop_rgb(bg, 1, 0.78, 0.78, 0.86);
    }
    cairo_set_source(cr, bg);
    cairo_paint(cr);
    cairo_pattern_destroy(bg);

    /* radial-gradient disc */
    cairo_pattern_t *rad = cairo_pattern_create_radial(120, 120, 8, 120, 120, 70);
    cairo_pattern_add_color_stop_rgb(rad, 0, 1.0, 0.86, 0.31);   /* #ffdc50 */
    cairo_pattern_add_color_stop_rgb(rad, 1, 0.90, 0.24, 0.12);  /* #e63d1f */
    cairo_set_source(cr, rad);
    cairo_arc(cr, 120, 120, 70, 0, 2 * M_PI);
    cairo_fill(cr);
    cairo_pattern_destroy(rad);

    /* dashed ring around the disc */
    static const double dashes[2] = { 12, 8 };
    cairo_set_dash(cr, dashes, 2, 0);
    cairo_set_line_width(cr, 4);
    if (is_dark) cairo_set_source_rgb(cr, 0.85, 0.85, 0.9);
    else         cairo_set_source_rgb(cr, 0.25, 0.25, 0.3);
    cairo_arc(cr, 120, 120, 92, 0, 2 * M_PI);
    cairo_stroke(cr);
    cairo_set_dash(cr, NULL, 0, 0);

    /* translucent green 5-point star (nonzero winding fill) */
    cairo_save(cr);
    cairo_translate(cr, 340, 120);
    cairo_rotate(cr, -M_PI / 2);
    cairo_move_to(cr, 80, 0);
    for (int i = 1; i < 5; i++)
        cairo_line_to(cr, 80 * cos(i * 4 * M_PI / 5), 80 * sin(i * 4 * M_PI / 5));
    cairo_close_path(cr);
    cairo_set_fill_rule(cr, CAIRO_FILL_RULE_WINDING);
    cairo_set_source_rgba(cr, 0.16, 0.65, 0.27, 0.85);
    cairo_fill(cr);
    cairo_restore(cr);

    /* blue bezier ribbon, round caps */
    cairo_set_line_width(cr, 10);
    cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
    cairo_set_source_rgb(cr, 0.15, 0.35, 0.9);
    cairo_move_to(cr, 40, 300);
    cairo_curve_to(cr, 160, 190, 320, 400, 440, 280);
    cairo_stroke(cr);

    /* label via cairo-ft */
    if (font_face) {
        cairo_set_font_face(cr, font_face);
        cairo_set_font_size(cr, 30);
        if (is_dark) cairo_set_source_rgb(cr, 0.95, 0.95, 0.95);
        else         cairo_set_source_rgb(cr, 0.1, 0.1, 0.12);
        cairo_move_to(cr, 210, 330);
        cairo_show_text(cr, "cairo ");
        cairo_show_text(cr, cairo_version_string());
    }
}

/* Render the logical scene scaled to w x h into a fresh ARGB32 surface. */
static cairo_surface_t *render(int w, int h, int is_dark) {
    cairo_surface_t *cs = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, h);
    cairo_t *cr = cairo_create(cs);
    cairo_scale(cr, (double)w / LW, (double)h / LH);
    draw_scene(cr, is_dark);
    cairo_destroy(cr);
    cairo_surface_flush(cs);
    return cs;
}

/* cairo ARGB32 is native-endian 0xAARRGGBB; the SDL surface wants RGBA
 * bytes (winbox's r | g<<8 | b<<16 | a<<24) — swap R and B. */
static void present(cairo_surface_t *cs) {
    int w = surf->w, h = surf->h;
    int stride = cairo_image_surface_get_stride(cs);
    unsigned char *src = cairo_image_surface_get_data(cs);
    uint32_t *dst = (uint32_t *)surf->pixels;
    for (int y = 0; y < h; y++) {
        const uint32_t *row = (const uint32_t *)(src + y * stride);
        for (int x = 0; x < w; x++) {
            uint32_t p = row[x];
            dst[y * w + x] = (p & 0xFF00FF00u) | ((p >> 16) & 0xFFu) | ((p & 0xFFu) << 16);
        }
    }
    SDL_UpdateWindowSurface(win);
}

static void frame_cb(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN) { dark = !dark; dirty = 1; }
        else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            surf = SDL_GetWindowSurface(win);   /* re-derive (SDL3 contract) */
            dirty = 1;
        } else if (e.type == SDL_EVENT_QUIT) exit(0);
    }
    if (!dirty) return;
    dirty = 0;
    cairo_surface_t *cs = render(surf->w, surf->h, dark);
    present(cs);
    cairo_surface_destroy(cs);
}

/* ============================================================ selftest */

static int g_fails;

static void check_px(cairo_surface_t *s, int x, int y,
                     int r, int g, int b, int tol, const char *name) {
    const unsigned char *d = cairo_image_surface_get_data(s);
    int stride = cairo_image_surface_get_stride(s);
    uint32_t px = *(const uint32_t *)(d + y * stride + x * 4);
    int pr = (px >> 16) & 0xff, pg = (px >> 8) & 0xff, pb = px & 0xff;
    if (abs(pr - r) <= tol && abs(pg - g) <= tol && abs(pb - b) <= tol)
        printf("ok %s\n", name);
    else {
        printf("FAIL %s at (%d,%d): got %02x%02x%02x want %02x%02x%02x tol %d\n",
               name, x, y, pr, pg, pb, r, g, b, tol);
        g_fails++;
    }
}

static int selftest(void) {
    cairo_surface_t *cs = render(LW, LH, 0);
    if (cairo_surface_status(cs) != CAIRO_STATUS_SUCCESS) {
        printf("FAIL surface status\n");
        return 1;
    }
    /* gradient background, top and bottom */
    check_px(cs, 240, 2, 0xef, 0xef, 0xf4, 4, "bg_top");
    check_px(cs, 460, 60, 0xec, 0xec, 0xf2, 4, "bg_upper_right");
    check_px(cs, 240, 358, 0xc8, 0xc8, 0xdb, 4, "bg_bottom");
    /* radial disc: hot center, dark rim, AA edge blends toward bg */
    check_px(cs, 120, 120, 0xff, 0xdc, 0x4f, 4, "disc_center");
    check_px(cs, 120, 120 - 66, 0xe8, 0x44, 0x23, 8, "disc_rim");
    /* star: translucent green over the bg gradient */
    check_px(cs, 340, 120, 0x44, 0xaf, 0x5d, 8, "star_center");
    /* bezier ribbon: a point ON the curve (t=0.5 -> x=240, y=295) */
    check_px(cs, 240, 295, 0x26, 0x59, 0xe5, 10, "curve_mid");
    /* dashed ring: the dash pattern starts at angle 0 -> (212,120) is inked */
    check_px(cs, 120 + 92, 120, 0x40, 0x40, 0x4a, 24, "ring_dash");
    /* text: some dark pixel must exist in the label box */
    if (font_face) {
        const unsigned char *d = cairo_image_surface_get_data(cs);
        int stride = cairo_image_surface_get_stride(cs);
        int darkpx = 0;
        for (int y = 300; y < 335 && !darkpx; y++)
            for (int x = 210; x < 460 && !darkpx; x++) {
                uint32_t px = *(const uint32_t *)(d + y * stride + x * 4);
                if (((px >> 16) & 0xff) < 0x50) darkpx = 1;
            }
        if (darkpx) printf("ok text_pixels\n");
        else { printf("FAIL text_pixels\n"); g_fails++; }
    } else {
        printf("FAIL no font\n");
        g_fails++;
    }
    cairo_surface_destroy(cs);
    printf(g_fails ? "cairodemo selftest: %d FAILED\n" : "cairodemo selftest ok (%d)\n",
           g_fails ? g_fails : 9);
    return g_fails ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) {
        load_font(argc > 2 ? argv[2] : NULL);
        return selftest();
    }
    if (argc > 2 && strcmp(argv[1], "png") == 0) {
        load_font(argc > 3 ? argv[3] : NULL);
        cairo_surface_t *cs = render(LW, LH, 0);
        cairo_status_t st = cairo_surface_write_to_png(cs, argv[2]);
        printf("%s\n", cairo_status_to_string(st));
        return st != CAIRO_STATUS_SUCCESS;
    }
    load_font(argc > 1 ? argv[1] : NULL);
    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("cairodemo", LW, LH, SDL_WINDOW_RESIZABLE);
    if (!win) return 3;
    surf = SDL_GetWindowSurface(win);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
