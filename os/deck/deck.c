/* deck.c — /bin/deck, the gucOS slide presenter (todos/0284 Lane 1;
 * design ~/git/meta/gucos/notes/slide-tool-design.md §1). Reads the
 * frozen .deck v1 JSON (model.h), renders through the supersample-AA
 * rasterizer (raster.h) + the fontcore text layer (text.h), presents in
 * a resizable SDL window with the mgpp nav key set, and parks idle
 * between states (the mgp SDL_WaitEventTimeout idiom).
 *
 *   deck FILE.deck                     present (start at --slide if given)
 *   deck --shot OUT.png FILE.deck      headless render of one slide at the
 *                                      deck's logical size -> PNG; no SDL,
 *                                      no event loop (the e2e/golden and
 *                                      AA-gate surface)
 *   deck --validate FILE.deck          parse + validate only; warnings to
 *                                      stderr, "deck: OK ..." to stdout
 *   --slide N|ID                       1-based index or slide id
 *   --ss N                             supersample override (default DECK_SS)
 *
 * Warnings always print to stderr (visible, never fatal); hard errors
 * print the structured where/offset and exit 1 — Lane 2 renders the same
 * DeckErr/DeckWarn structures on the in-window placard. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <SDL.h>
#include <png.h>

#include "model.h"
#include "raster.h"
#include "text.h"

/* ---- image loading (sent's pngload shape, alpha kept straight) ------ */

static void load_image(DElem *e) {
    if (e->img || e->imgFailed)
        return;
    png_image pi;
    memset(&pi, 0, sizeof pi);
    pi.version = PNG_IMAGE_VERSION;
    if (!png_image_begin_read_from_file(&pi, e->path)) {
        e->imgFailed = 1;
        return;
    }
    pi.format = PNG_FORMAT_RGBA;
    uint8_t *rgba = malloc(PNG_IMAGE_SIZE(pi));
    if (!rgba || !png_image_finish_read(&pi, NULL, rgba, 0, NULL)) {
        free(rgba);
        e->imgFailed = 1;
        return;
    }
    e->img = rgba;
    e->imgW = (int)pi.width;
    e->imgH = (int)pi.height;
}

/* ---- slide -> canvas ------------------------------------------------ */

/* Deferred text pass: text elements and shape labels composite at FINAL
 * resolution after the downsample (glyphs are already AA — design §1.3);
 * v1 semantics: text sits above shapes/images, array order among text. */
typedef struct {
    const DElem **v;
    int n, cap;
} TextList;

static void text_push(TextList *tl, const DElem *e) {
    if (tl->n == tl->cap) {
        int nc = tl->cap ? tl->cap * 2 : 16;
        const DElem **nv = realloc((void *)tl->v, (size_t)nc * sizeof *nv);
        if (!nv)
            return;
        tl->v = nv;
        tl->cap = nc;
    }
    tl->v[tl->n++] = e;
}

/* Missing/unloadable image: a LOUD placeholder (gray panel, dark border,
 * diagonal cross), never a silent gap — the agent sees where it goes. */
static void placeholder(RCanvas *hi, RMask *m, float x, float y,
                        float w, float h, float sw) {
    rm_reset(m);
    rm_fill_rrect(m, x, y, w, h, 0);
    rm_composite(hi, m, 176, 176, 176, 255);
    rm_reset(m);
    rm_stroke_rrect(m, x, y, w, h, 0, sw);
    float d1[2][2] = { { x, y }, { x + w, y + h } };
    float d2[2][2] = { { x + w, y }, { x, y + h } };
    rm_stroke_path(m, d1, 2, sw, NULL, 0, 0);
    rm_stroke_path(m, d2, 2, sw, NULL, 0, 0);
    rm_composite(hi, m, 96, 96, 96, 255);
}

/* Render slide `sl` at outW x outH (the aspect-fit rect; --shot passes
 * the logical size) with supersample `ss` into `out` (initialized here;
 * caller rc_free()s). Returns 0, or -1 on OOM. */
static int render_slide(const Deck *d, DSlide *sl,
                        int outW, int outH, int ss, RCanvas *out) {
    RCanvas hi;
    RMask m;
    if (rc_init(out, outW, outH))
        return -1;
    if (rc_init(&hi, outW * ss, outH * ss)) {
        rc_free(out);
        return -1;
    }
    if (rm_init(&m, hi.w, hi.h)) {
        rc_free(&hi);
        rc_free(out);
        return -1;
    }
    rc_clear(&hi, d->bg.r, d->bg.g, d->bg.b);

    float fx = (float)outW * ss / d->w;   /* logical -> supersampled device */
    float fy = (float)outH * ss / d->h;
    float fs = (fx + fy) * 0.5f;          /* scalars (widths, radii, dashes);
                                             fx == fy under aspect fit */
    TextList tl = { NULL, 0, 0 };

    for (int i = 0; i < sl->nels; i++) {
        DElem *e = &sl->els[i];
        switch (e->type) {
        case DEL_TEXT:
            text_push(&tl, e);
            break;
        case DEL_RECT:
        case DEL_ELLIPSE: {
            float x = e->x * fx, y = e->y * fy, w = e->w * fx, h = e->h * fy;
            if (e->hasFill) {
                rm_reset(&m);
                if (e->type == DEL_RECT)
                    rm_fill_rrect(&m, x, y, w, h, e->radius * fs);
                else
                    rm_fill_ellipse(&m, x, y, w, h);
                rm_composite(&hi, &m, e->fill.r, e->fill.g, e->fill.b, e->fill.a);
            }
            if (e->hasStroke && e->strokeWidth > 0) {
                rm_reset(&m);
                if (e->type == DEL_RECT)
                    rm_stroke_rrect(&m, x, y, w, h, e->radius * fs,
                                    e->strokeWidth * fs);
                else
                    rm_stroke_ellipse(&m, x, y, w, h, e->strokeWidth * fs);
                rm_composite(&hi, &m, e->stroke.r, e->stroke.g, e->stroke.b,
                             e->stroke.a);
            }
            if (e->label)
                text_push(&tl, e->label);
            break;
        }
        case DEL_LINE:
        case DEL_POLYLINE: {
            if (e->strokeWidth <= 0)
                break;
            float two[2][2];
            float (*sp)[2] = two;
            int n = 2;
            if (e->type == DEL_LINE) {
                two[0][0] = e->x1 * fx; two[0][1] = e->y1 * fy;
                two[1][0] = e->x2 * fx; two[1][1] = e->y2 * fy;
            } else {
                sp = malloc((size_t)e->npts * sizeof *sp);
                if (!sp)
                    break;
                n = e->npts;
                for (int k = 0; k < n; k++) {
                    sp[k][0] = e->pts[k][0] * fx;
                    sp[k][1] = e->pts[k][1] * fy;
                }
            }
            float dash[2] = { e->dash[0] * fs, e->dash[1] * fs };
            rm_reset(&m);
            rm_stroke_path(&m, sp, n, e->strokeWidth * fs,
                           e->hasDash ? dash : NULL,
                           e->startArrow, e->endArrow);
            rm_composite(&hi, &m, e->stroke.r, e->stroke.g, e->stroke.b,
                         e->stroke.a);
            if (sp != two)
                free(sp);
            break;
        }
        case DEL_IMAGE: {
            load_image(e);
            float x = e->x * fx, y = e->y * fy, w = e->w * fx, h = e->h * fy;
            if (!e->img) {
                placeholder(&hi, &m, x, y, w, h, 2.0f * fs);
                break;
            }
            float iw = (float)e->imgW, ih = (float)e->imgH;
            float sx = 0, sy = 0, sw = iw, sh = ih;
            float dx = x, dy = y, dw = w, dh = h;
            if (e->fit == DFIT_CONTAIN) {
                float sc = w / iw < h / ih ? w / iw : h / ih;
                dw = iw * sc;
                dh = ih * sc;
                dx = x + (w - dw) * 0.5f;
                dy = y + (h - dh) * 0.5f;
            } else if (e->fit == DFIT_COVER) {
                float sc = w / iw > h / ih ? w / iw : h / ih;
                sw = w / sc;
                sh = h / sc;
                sx = (iw - sw) * 0.5f;
                sy = (ih - sh) * 0.5f;
            }
            rc_blit_image(&hi, e->img, e->imgW, e->imgH,
                          sx, sy, sw, sh, dx, dy, dw, dh);
            break;
        }
        }
    }

    rc_downsample(out, &hi, ss);
    rc_free(&hi);
    rm_free(&m);

    /* text pass at 1x */
    float sx1 = (float)outW / d->w, sy1 = (float)outH / d->h;
    for (int i = 0; i < tl.n; i++) {
        const DElem *e = tl.v[i];
        int px = (int)(e->size * sy1 + 0.5f);
        if (px < 1)
            px = 1;
        dtext_draw(out, e->text, px, e->x * sx1, e->y * sy1,
                   e->w * sx1, e->h * sy1, e->align, e->valign, e->wrap,
                   e->color);
    }
    free((void *)tl.v);
    return 0;
}

/* ---- load-time reporting -------------------------------------------- */

static void print_warns(const DeckWarn *w, int n) {
    for (int i = 0; i < n; i++) {
        if (w[i].where[0])
            fprintf(stderr, "deck: warning (%s): %s\n", w[i].where, w[i].msg);
        else
            fprintf(stderr, "deck: warning: %s\n", w[i].msg);
    }
}

static void print_err(const char *file, const DeckErr *e) {
    fprintf(stderr, "deck: %s: ERROR", file);
    if (e->where[0])
        fprintf(stderr, " (%s)", e->where);
    fprintf(stderr, ": %s", e->msg);
    if (e->offset >= 0)
        fprintf(stderr, " at byte %ld", e->offset);
    fputc('\n', stderr);
}

/* ---- presenter state ------------------------------------------------ */

static Deck *g_deck;
static int g_cur;                  /* current slide index */
static int g_acc = -1;             /* <N>g digit accumulator, -1 = none */
static int g_ss = DECK_SS;
static int g_running = 1;
static int g_dirty = 1;            /* 1 = re-render, 2 = re-blit only */
static SDL_Window *g_win;
static SDL_Surface *g_surf;
static RCanvas g_lo;               /* cached composed fit-rect canvas */
static int g_haveLo;

static void nav_to(int idx) {
    if (idx < 0)
        idx = 0;
    if (idx >= g_deck->nslides)
        idx = g_deck->nslides - 1;
    if (idx != g_cur) {
        g_cur = idx;
        g_dirty = 1;
    }
}

static void blit(void) {
    if (!g_haveLo)
        return;
    int xoff = (g_surf->w - g_lo.w) / 2;
    int yoff = (g_surf->h - g_lo.h) / 2;
    uint32_t bg = (uint32_t)g_deck->bg.r | ((uint32_t)g_deck->bg.g << 8) |
                  ((uint32_t)g_deck->bg.b << 16) | 0xFF000000u;
    for (int y = 0; y < g_surf->h; y++) {
        uint32_t *row = (uint32_t *)((uint8_t *)g_surf->pixels +
                                     (size_t)y * g_surf->pitch);
        int sy = y - yoff;
        if (sy < 0 || sy >= g_lo.h) {
            for (int x = 0; x < g_surf->w; x++)
                row[x] = bg;
            continue;
        }
        for (int x = 0; x < xoff && x < g_surf->w; x++)
            row[x] = bg;
        const uint8_t *src = g_lo.px + (size_t)sy * g_lo.w * 4;
        int x0 = xoff < 0 ? 0 : xoff;
        int x1 = xoff + g_lo.w;
        if (x1 > g_surf->w) x1 = g_surf->w;
        for (int x = x0; x < x1; x++) {
            const uint8_t *p = src + (size_t)(x - xoff) * 4;
            row[x] = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                     ((uint32_t)p[2] << 16) | 0xFF000000u;
        }
        for (int x = x1 > 0 ? x1 : 0; x < g_surf->w; x++)
            row[x] = bg;
    }
    SDL_UpdateWindowSurface(g_win);
}

static void present_render(void) {
    float sc = (float)g_surf->w / g_deck->w;
    float sch = (float)g_surf->h / g_deck->h;
    if (sch < sc)
        sc = sch;
    int fitW = (int)(g_deck->w * sc + 0.5f);
    int fitH = (int)(g_deck->h * sc + 0.5f);
    if (fitW < 1) fitW = 1;
    if (fitH < 1) fitH = 1;
    if (g_haveLo) {
        rc_free(&g_lo);
        g_haveLo = 0;
    }
    if (render_slide(g_deck, &g_deck->slides[g_cur], fitW, fitH, g_ss, &g_lo)) {
        fprintf(stderr, "deck: out of memory rendering slide %d\n", g_cur + 1);
        return;
    }
    g_haveLo = 1;
    blit();
}

static void key_down(SDL_Keycode k) {
    if (k >= '0' && k <= '9') {
        g_acc = (g_acc < 0 ? 0 : g_acc) * 10 + (int)(k - '0');
        return;
    }
    switch (k) {
    case 'q':
    case SDLK_ESCAPE:
        g_running = 0;
        break;
    case 'g':                      /* <N>g goto, bare g = last (mgp) */
        nav_to(g_acc > 0 ? g_acc - 1 : g_deck->nslides - 1);
        break;
    case SDLK_RIGHT:
    case SDLK_SPACE:
    case SDLK_PAGEDOWN:
        nav_to(g_cur + (g_acc > 0 ? g_acc : 1));
        break;
    case SDLK_LEFT:
    case SDLK_PAGEUP:
        nav_to(g_cur - (g_acc > 0 ? g_acc : 1));
        break;
    case SDLK_HOME:
        nav_to(0);
        break;
    case SDLK_END:
        nav_to(g_deck->nslides - 1);
        break;
    }
    g_acc = -1;
}

/* Frame callback (the estate's SDL app model — sent/mgp): drain events,
 * apply state, and when settled park on the input ring (todos/0161,
 * peek semantics: a waking event stays queued for the next frame). */
static void frame_cb(void) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
        switch (ev.type) {
        case SDL_EVENT_KEY_DOWN:
            key_down(ev.key.key);
            break;
        case SDL_EVENT_MOUSE_BUTTON_DOWN:
            if (ev.button.x < (float)g_surf->w * 0.5f)
                nav_to(g_cur - 1);
            else
                nav_to(g_cur + 1);
            break;
        case SDL_EVENT_WINDOW_RESIZED:
            g_surf = SDL_GetWindowSurface(g_win);   /* re-derive (SDL3) */
            g_dirty = 1;
            break;
        case SDL_EVENT_WINDOW_EXPOSED:
            if (g_dirty < 1)
                g_dirty = 2;
            break;
        case SDL_EVENT_QUIT:
        case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
            g_running = 0;
            break;
        }
    }
    if (!g_running)
        exit(0);
    if (g_dirty == 1)
        present_render();
    else if (g_dirty == 2)
        blit();
    else {
        SDL_WaitEventTimeout(NULL, 1000);           /* idle park, peek */
        return;
    }
    g_dirty = 0;
}

/* ---- main ------------------------------------------------------------ */

static void usage(void) {
    fprintf(stderr, "usage: deck [--validate | --shot OUT.png] "
                    "[--slide N|ID] [--ss N] FILE.deck\n");
    exit(2);
}

int main(int argc, char **argv) {
    const char *file = NULL, *shot = NULL, *slide = NULL;
    int validate = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--validate") == 0)
            validate = 1;
        else if (strcmp(argv[i], "--shot") == 0 && i + 1 < argc)
            shot = argv[++i];
        else if (strcmp(argv[i], "--slide") == 0 && i + 1 < argc)
            slide = argv[++i];
        else if (strcmp(argv[i], "--ss") == 0 && i + 1 < argc) {
            g_ss = atoi(argv[++i]);
            if (g_ss < 1 || g_ss > 8) {
                fprintf(stderr, "deck: --ss must be 1..8\n");
                exit(2);
            }
        } else if (argv[i][0] == '-')
            usage();
        else if (!file)
            file = argv[i];
        else
            usage();
    }
    if (!file)
        usage();

    DeckErr err;
    DeckWarn *warns;
    int nwarns;
    g_deck = deck_load(file, &err, &warns, &nwarns);
    print_warns(warns, nwarns);
    free(warns);
    if (!g_deck) {
        print_err(file, &err);
        return 1;
    }

    if (validate) {
        printf("deck: OK: %d slide%s, %d warning%s\n",
               g_deck->nslides, g_deck->nslides == 1 ? "" : "s",
               nwarns, nwarns == 1 ? "" : "s");
        return 0;
    }

    /* resolve the start slide: exact id first, then 1-based index */
    g_cur = 0;
    if (slide) {
        int idx = deck_slide_index(g_deck, slide);
        if (idx < 0) {
            char *endp;
            long n = strtol(slide, &endp, 10);
            if (*endp == 0 && n >= 1 && n <= g_deck->nslides)
                idx = (int)n - 1;
        }
        if (idx < 0) {
            fprintf(stderr, "deck: no slide '%s'\n", slide);
            return 1;
        }
        g_cur = idx;
    }

    if (dtext_init() < 0) {
        fprintf(stderr, "deck: cannot open any font face "
                        "(/etc/fonts/mono.ttf or /usr/share/fonts/mono.ttf)\n");
        return 1;
    }

    if (shot) {
        RCanvas out;
        int w = (int)(g_deck->w + 0.5f), h = (int)(g_deck->h + 0.5f);
        if (render_slide(g_deck, &g_deck->slides[g_cur], w, h, g_ss, &out)) {
            fprintf(stderr, "deck: out of memory rendering slide\n");
            return 1;
        }
        png_image pi;
        memset(&pi, 0, sizeof pi);
        pi.version = PNG_IMAGE_VERSION;
        pi.width = (png_uint_32)out.w;
        pi.height = (png_uint_32)out.h;
        pi.format = PNG_FORMAT_RGBA;
        if (!png_image_write_to_file(&pi, shot, 0, out.px,
                                     out.w * 4, NULL)) {
            fprintf(stderr, "deck: PNG write to '%s' failed: %s\n",
                    shot, pi.message);
            return 1;
        }
        printf("deck: wrote %s (slide %d/%d, %dx%d, ss=%d)\n",
               shot, g_cur + 1, g_deck->nslides, out.w, out.h, g_ss);
        rc_free(&out);
        return 0;
    }

    if (!SDL_Init(SDL_INIT_VIDEO)) {
        fprintf(stderr, "deck: SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }
    /* initial window: the logical space fit into 960x540 (WM maximize is
     * the present mode — design §1.3) */
    float isc = 960.0f / g_deck->w;
    if (540.0f / g_deck->h < isc)
        isc = 540.0f / g_deck->h;
    if (isc > 1.0f)
        isc = 1.0f;
    int iw = (int)(g_deck->w * isc + 0.5f), ih = (int)(g_deck->h * isc + 0.5f);

    const char *base = strrchr(file, '/');
    char title[128];
    snprintf(title, sizeof title, "deck: %s", base ? base + 1 : file);
    g_win = SDL_CreateWindow(title, iw, ih, SDL_WINDOW_RESIZABLE);
    if (!g_win || !(g_surf = SDL_GetWindowSurface(g_win))) {
        fprintf(stderr, "deck: cannot create window: %s\n", SDL_GetError());
        return 1;
    }
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
