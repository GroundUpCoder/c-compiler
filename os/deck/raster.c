/* raster.c — /bin/deck's CPU rasterizer (todos/0284). See raster.h for
 * the AA model. Everything here is exercised rarely (one render per nav/
 * resize/reload — the presenter parks between states), so clarity beats
 * micro-optimization; the only loops that matter are bbox-bounded. */
#include "raster.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ---- canvas -------------------------------------------------------- */

int rc_init(RCanvas *c, int w, int h) {
    c->w = w;
    c->h = h;
    c->px = (uint8_t *)malloc((size_t)w * h * 4);
    return c->px ? 0 : -1;
}

void rc_free(RCanvas *c) {
    free(c->px);
    c->px = NULL;
    c->w = c->h = 0;
}

void rc_clear(RCanvas *c, uint8_t r, uint8_t g, uint8_t b) {
    uint8_t *p = c->px;
    for (int i = 0, n = c->w * c->h; i < n; i++) {
        *p++ = r;
        *p++ = g;
        *p++ = b;
        *p++ = 255;
    }
}

/* ---- mask ---------------------------------------------------------- */

int rm_init(RMask *m, int w, int h) {
    m->w = w;
    m->h = h;
    m->cov = (uint8_t *)calloc((size_t)w * h, 1);
    rm_reset(m);
    m->dx0 = m->dy0 = 0;         /* fresh calloc is already clean */
    m->dx1 = m->dy1 = 0;
    return m->cov ? 0 : -1;
}

void rm_free(RMask *m) {
    free(m->cov);
    m->cov = NULL;
}

void rm_reset(RMask *m) {
    if (m->dx1 > m->dx0)
        for (int y = m->dy0; y < m->dy1; y++)
            memset(m->cov + (size_t)y * m->w + m->dx0, 0,
                   (size_t)(m->dx1 - m->dx0));
    m->dx0 = m->w;
    m->dy0 = m->h;
    m->dx1 = 0;
    m->dy1 = 0;
}

/* Fill pixels whose CENTER lies in [xa, xb) on row y. */
static void mask_span(RMask *m, int y, float xa, float xb) {
    if (y < 0 || y >= m->h || xb <= xa)
        return;
    int x0 = (int)ceilf(xa - 0.5f);
    int x1 = (int)ceilf(xb - 0.5f);          /* exclusive */
    if (x0 < 0) x0 = 0;
    if (x1 > m->w) x1 = m->w;
    if (x0 >= x1)
        return;
    memset(m->cov + (size_t)y * m->w + x0, 255, (size_t)(x1 - x0));
    if (x0 < m->dx0) m->dx0 = x0;
    if (y < m->dy0) m->dy0 = y;
    if (x1 > m->dx1) m->dx1 = x1;
    if (y + 1 > m->dy1) m->dy1 = y + 1;
}

/* ---- even-odd scanline polygon fill -------------------------------- */

void rm_poly(RMask *m, float (*pts)[2], int n) {
    if (n < 3)
        return;
    float ymin = pts[0][1], ymax = pts[0][1];
    for (int i = 1; i < n; i++) {
        if (pts[i][1] < ymin) ymin = pts[i][1];
        if (pts[i][1] > ymax) ymax = pts[i][1];
    }
    int y0 = (int)floorf(ymin);
    int y1 = (int)ceilf(ymax);
    if (y0 < 0) y0 = 0;
    if (y1 > m->h) y1 = m->h;

    float stackx[64];
    float *xs = n <= 64 ? stackx : (float *)malloc((size_t)n * sizeof(float));
    if (!xs)
        return;
    for (int y = y0; y < y1; y++) {
        float yc = (float)y + 0.5f;
        int k = 0;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            float ya = pts[j][1], yb = pts[i][1];
            if ((ya <= yc && yc < yb) || (yb <= yc && yc < ya))
                xs[k++] = pts[j][0] +
                          (yc - ya) * (pts[i][0] - pts[j][0]) / (yb - ya);
        }
        /* insertion sort — k is tiny (2 for convex, rarely more) */
        for (int i = 1; i < k; i++) {
            float v = xs[i];
            int j = i - 1;
            while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; }
            xs[j + 1] = v;
        }
        for (int i = 0; i + 1 < k; i += 2)
            mask_span(m, y, xs[i], xs[i + 1]);
    }
    if (xs != stackx)
        free(xs);
}

void rm_disc(RMask *m, float cx, float cy, float r) {
    if (r <= 0.0f)
        return;
    int y0 = (int)floorf(cy - r);
    int y1 = (int)ceilf(cy + r);
    if (y0 < 0) y0 = 0;
    if (y1 > m->h) y1 = m->h;
    for (int y = y0; y < y1; y++) {
        float dy = (float)y + 0.5f - cy;
        float d2 = r * r - dy * dy;
        if (d2 <= 0.0f)
            continue;
        float dx = sqrtf(d2);
        mask_span(m, y, cx - dx, cx + dx);
    }
}

/* ---- arc flattening ------------------------------------------------
 * Segments for a full circle of radius r keeping the chord sagitta
 * under 1/4 supersampled px (error invisible after the downsample). */
static int arc_steps(float r) {
    if (r <= 1.0f)
        return 8;
    float theta = 2.0f * acosf(1.0f - 0.25f / r);
    int n = (int)ceilf(6.2831853f / theta);
    return n < 8 ? 8 : n > 256 ? 256 : n;
}

/* Append a rounded-rect outline (clockwise, corner arcs flattened) to
 * pts; returns the vertex count. Caller sizes pts via RRECT_MAX_PTS. */
#define RRECT_MAX_PTS (4 * 66)
static int flatten_rrect(float (*pts)[2], float x, float y, float w, float h,
                         float rad) {
    float rmax = (w < h ? w : h) * 0.5f;
    if (rad > rmax) rad = rmax;
    if (rad < 0.0f) rad = 0.0f;
    int n = 0;
    if (rad <= 0.0f) {
        pts[n][0] = x;     pts[n++][1] = y;
        pts[n][0] = x + w; pts[n++][1] = y;
        pts[n][0] = x + w; pts[n++][1] = y + h;
        pts[n][0] = x;     pts[n++][1] = y + h;
        return n;
    }
    int q = arc_steps(rad) / 4;
    if (q < 2) q = 2;
    if (q > 64) q = 64;
    /* corner centers, arcs swept clockwise starting at the top-left */
    static const float qstart[4] = { 3.1415927f, 4.7123890f, 0.0f, 1.5707963f };
    const float ccx[4] = { x + rad, x + w - rad, x + w - rad, x + rad };
    const float ccy[4] = { y + rad, y + rad, y + h - rad, y + h - rad };
    for (int c = 0; c < 4; c++)
        for (int i = 0; i <= q; i++) {
            float a = qstart[c] + 1.5707963f * (float)i / (float)q;
            pts[n][0] = ccx[c] + rad * cosf(a);
            pts[n][1] = ccy[c] + rad * sinf(a);
            n++;
        }
    return n;
}

#define ELLIPSE_MAX_PTS 256
static int flatten_ellipse(float (*pts)[2], float x, float y, float w, float h) {
    float rx = w * 0.5f, ry = h * 0.5f;
    float cx = x + rx, cy = y + ry;
    int n = arc_steps(rx > ry ? rx : ry);
    if (n > ELLIPSE_MAX_PTS) n = ELLIPSE_MAX_PTS;
    for (int i = 0; i < n; i++) {
        float a = 6.2831853f * (float)i / (float)n;
        pts[i][0] = cx + rx * cosf(a);
        pts[i][1] = cy + ry * sinf(a);
    }
    return n;
}

/* ---- closed-outline stroking ---------------------------------------
 * Quad per edge + disc per vertex = constant width, round joins. */
static void stroke_closed(RMask *m, float (*pts)[2], int n, float sw) {
    float hw = sw * 0.5f;
    if (hw < 0.5f) hw = 0.5f;    /* hairline floor: never thinner than 1 SS px */
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        float len = sqrtf(dx * dx + dy * dy);
        if (len < 1e-6f)
            continue;
        float nx = -dy / len * hw, ny = dx / len * hw;
        float quad[4][2] = {
            { pts[j][0] + nx, pts[j][1] + ny },
            { pts[i][0] + nx, pts[i][1] + ny },
            { pts[i][0] - nx, pts[i][1] - ny },
            { pts[j][0] - nx, pts[j][1] - ny },
        };
        rm_poly(m, quad, 4);
        rm_disc(m, pts[i][0], pts[i][1], hw);
    }
}

/* ---- rect / ellipse ------------------------------------------------ */

void rm_fill_rrect(RMask *m, float x, float y, float w, float h, float rad) {
    float pts[RRECT_MAX_PTS][2];
    int n = flatten_rrect(pts, x, y, w, h, rad);
    rm_poly(m, pts, n);
}

void rm_stroke_rrect(RMask *m, float x, float y, float w, float h,
                     float rad, float sw) {
    float pts[RRECT_MAX_PTS][2];
    int n = flatten_rrect(pts, x, y, w, h, rad);
    stroke_closed(m, pts, n, sw);
}

void rm_fill_ellipse(RMask *m, float x, float y, float w, float h) {
    float pts[ELLIPSE_MAX_PTS][2];
    int n = flatten_ellipse(pts, x, y, w, h);
    rm_poly(m, pts, n);
}

void rm_stroke_ellipse(RMask *m, float x, float y, float w, float h, float sw) {
    float pts[ELLIPSE_MAX_PTS][2];
    int n = flatten_ellipse(pts, x, y, w, h);
    stroke_closed(m, pts, n, sw);
}

/* ---- open-path stroking (lines, polylines, dash, arrows) ----------- */

/* One solid stroked segment: quad + round caps as discs at both ends.
 * Discs are idempotent in the mask, so adjacent segments overlap freely. */
static void seg(RMask *m, float x0, float y0, float x1, float y1, float hw) {
    float dx = x1 - x0, dy = y1 - y0;
    float len = sqrtf(dx * dx + dy * dy);
    if (len < 1e-6f) {
        rm_disc(m, x0, y0, hw);
        return;
    }
    float nx = -dy / len * hw, ny = dx / len * hw;
    float quad[4][2] = {
        { x0 + nx, y0 + ny }, { x1 + nx, y1 + ny },
        { x1 - nx, y1 - ny }, { x0 - nx, y0 - ny },
    };
    rm_poly(m, quad, 4);
    rm_disc(m, x0, y0, hw);
    rm_disc(m, x1, y1, hw);
}

/* Arrowhead proportions (design §1.3: filled triangle at the line angle,
 * size ~ strokeWidth). Tuned at the AA gate on the thin-arrow fixture. */
#define ARROW_LEN(w)  ((w) * 4.5f)
#define ARROW_HALF(w) ((w) * 1.8f)

static void arrowhead(RMask *m, float tipx, float tipy,
                      float dirx, float diry, float width) {
    float len = ARROW_LEN(width), half = ARROW_HALF(width);
    float bx = tipx - dirx * len, by = tipy - diry * len;
    float nx = -diry * half, ny = dirx * half;
    float tri[3][2] = {
        { tipx, tipy }, { bx + nx, by + ny }, { bx - nx, by - ny },
    };
    rm_poly(m, tri, 3);
}

void rm_stroke_path(RMask *m, float (*pts)[2], int n, float width,
                    const float *dash, int startArrow, int endArrow) {
    if (n < 1)
        return;
    float hw = width * 0.5f;
    if (hw < 0.5f) hw = 0.5f;
    if (n == 1) {
        rm_disc(m, pts[0][0], pts[0][1], hw);
        return;
    }

    /* Trim the shaft under each arrowhead so a translucent stroke does
     * not show the shaft butt through the head's taper; the head owns
     * the last ARROW_LEN*0.8 of the path. Work on a local copy of the
     * two end points. */
    float first[2] = { pts[0][0], pts[0][1] };
    float last[2] = { pts[n - 1][0], pts[n - 1][1] };
    float sdir[2] = { 0, 0 }, edir[2] = { 0, 0 };
    float trim = ARROW_LEN(width) * 0.8f;
    if (startArrow) {
        float dx = pts[0][0] - pts[1][0], dy = pts[0][1] - pts[1][1];
        float len = sqrtf(dx * dx + dy * dy);
        if (len > 1e-6f) {
            sdir[0] = dx / len;
            sdir[1] = dy / len;
            float t = trim < len ? trim : len;
            first[0] -= sdir[0] * t;
            first[1] -= sdir[1] * t;
        }
    }
    if (endArrow) {
        float dx = pts[n - 1][0] - pts[n - 2][0],
              dy = pts[n - 1][1] - pts[n - 2][1];
        float len = sqrtf(dx * dx + dy * dy);
        if (len > 1e-6f) {
            edir[0] = dx / len;
            edir[1] = dy / len;
            float t = trim < len ? trim : len;
            last[0] -= edir[0] * t;
            last[1] -= edir[1] * t;
        }
    }

    int dashed = dash && dash[0] > 0.0f && dash[1] > 0.0f;
    float don = dashed ? dash[0] : 0.0f, doff = dashed ? dash[1] : 0.0f;
    float cycle = don + doff;
    /* Dash position WITHIN the cycle, kept in [0, cycle) with exact
     * boundary snapping — a raw accumulating phase wedged the walk at
     * specific window scales (run = don - fmod(phase, cycle) fell below
     * one ulp of the accumulator, so t += run stopped advancing; found
     * live: slide "arch" at a 700x500 window). Bounded p keeps every
     * residual well above float granularity. */
    float p = 0.0f;

    for (int i = 0; i + 1 < n; i++) {
        float ax = i == 0 ? first[0] : pts[i][0];
        float ay = i == 0 ? first[1] : pts[i][1];
        float bx = i == n - 2 ? last[0] : pts[i + 1][0];
        float by = i == n - 2 ? last[1] : pts[i + 1][1];
        float dx = bx - ax, dy = by - ay;
        float len = sqrtf(dx * dx + dy * dy);
        if (len < 1e-6f)
            continue;
        if (!dashed) {
            seg(m, ax, ay, bx, by, hw);
            continue;
        }
        float ux = dx / len, uy = dy / len, t = 0.0f;
        while (len - t > 1e-3f) {
            int draw = p < don;
            float rf = (draw ? don : cycle) - p;    /* > 0 by construction */
            float run = rf;
            if (run > len - t)
                run = len - t;
            if (draw)
                seg(m, ax + ux * t, ay + uy * t,
                    ax + ux * (t + run), ay + uy * (t + run), hw);
            t += run;
            if (run >= rf)
                p = draw ? don : 0.0f;              /* completed: snap exact */
            else
                p += run;                           /* segment ended mid-run */
        }
    }

    if (startArrow && (sdir[0] != 0.0f || sdir[1] != 0.0f))
        arrowhead(m, pts[0][0], pts[0][1], sdir[0], sdir[1], width);
    if (endArrow && (edir[0] != 0.0f || edir[1] != 0.0f))
        arrowhead(m, pts[n - 1][0], pts[n - 1][1], edir[0], edir[1], width);
}

/* ---- composite / downsample / images / glyphs ---------------------- */

void rm_composite(RCanvas *c, const RMask *m,
                  uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (a == 0 || m->dx1 <= m->dx0)
        return;
    for (int y = m->dy0; y < m->dy1; y++) {
        const uint8_t *cov = m->cov + (size_t)y * m->w;
        uint8_t *px = c->px + ((size_t)y * c->w + m->dx0) * 4;
        for (int x = m->dx0; x < m->dx1; x++, px += 4) {
            unsigned cv = cov[x];
            if (!cv)
                continue;
            unsigned sa = (cv * a + 127) / 255;
            unsigned inv = 255 - sa;
            px[0] = (uint8_t)((r * sa + px[0] * inv + 127) / 255);
            px[1] = (uint8_t)((g * sa + px[1] * inv + 127) / 255);
            px[2] = (uint8_t)((b * sa + px[2] * inv + 127) / 255);
            /* canvas stays opaque (cleared to alpha 255) */
        }
    }
}

void rc_downsample(RCanvas *dst, const RCanvas *src, int ss) {
    int area = ss * ss;
    int half = area / 2;
    for (int y = 0; y < dst->h; y++) {
        uint8_t *out = dst->px + (size_t)y * dst->w * 4;
        for (int x = 0; x < dst->w; x++, out += 4) {
            unsigned sr = 0, sg = 0, sb = 0;
            for (int sy = 0; sy < ss; sy++) {
                const uint8_t *in = src->px +
                    (((size_t)(y * ss + sy) * src->w) + (size_t)x * ss) * 4;
                for (int sx = 0; sx < ss; sx++, in += 4) {
                    sr += in[0];
                    sg += in[1];
                    sb += in[2];
                }
            }
            out[0] = (uint8_t)((sr + half) / area);
            out[1] = (uint8_t)((sg + half) / area);
            out[2] = (uint8_t)((sb + half) / area);
            out[3] = 255;
        }
    }
}

void rc_blit_image(RCanvas *c, const uint8_t *rgba, int iw, int ih,
                   float sx, float sy, float sw, float sh,
                   float dx, float dy, float dw, float dh) {
    if (iw <= 0 || ih <= 0 || dw <= 0.0f || dh <= 0.0f ||
        sw <= 0.0f || sh <= 0.0f)
        return;
    int x0 = (int)floorf(dx), y0 = (int)floorf(dy);
    int x1 = (int)ceilf(dx + dw), y1 = (int)ceilf(dy + dh);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > c->w) x1 = c->w;
    if (y1 > c->h) y1 = c->h;
    for (int y = y0; y < y1; y++) {
        float v = ((float)y + 0.5f - dy) / dh;
        if (v < 0.0f || v >= 1.0f)
            continue;
        float syf = sy + v * sh - 0.5f;
        int iy = (int)floorf(syf);
        float fy = syf - (float)iy;
        int iy1 = iy + 1;
        if (iy < 0) { iy = 0; fy = 0.0f; }
        if (iy1 > ih - 1) iy1 = ih - 1;
        uint8_t *px = c->px + ((size_t)y * c->w + x0) * 4;
        for (int x = x0; x < x1; x++, px += 4) {
            float u = ((float)x + 0.5f - dx) / dw;
            if (u < 0.0f || u >= 1.0f)
                continue;
            float sxf = sx + u * sw - 0.5f;
            int ix = (int)floorf(sxf);
            float fx = sxf - (float)ix;
            int ix1 = ix + 1;
            if (ix < 0) { ix = 0; fx = 0.0f; }
            if (ix1 > iw - 1) ix1 = iw - 1;
            const uint8_t *p00 = rgba + ((size_t)iy * iw + ix) * 4;
            const uint8_t *p01 = rgba + ((size_t)iy * iw + ix1) * 4;
            const uint8_t *p10 = rgba + ((size_t)iy1 * iw + ix) * 4;
            const uint8_t *p11 = rgba + ((size_t)iy1 * iw + ix1) * 4;
            float w00 = (1.0f - fx) * (1.0f - fy), w01 = fx * (1.0f - fy);
            float w10 = (1.0f - fx) * fy, w11 = fx * fy;
            float sr = p00[0] * w00 + p01[0] * w01 + p10[0] * w10 + p11[0] * w11;
            float sg = p00[1] * w00 + p01[1] * w01 + p10[1] * w10 + p11[1] * w11;
            float sb = p00[2] * w00 + p01[2] * w01 + p10[2] * w10 + p11[2] * w11;
            float sa = p00[3] * w00 + p01[3] * w01 + p10[3] * w10 + p11[3] * w11;
            unsigned a = (unsigned)(sa + 0.5f);
            if (!a)
                continue;
            unsigned inv = 255 - a;
            px[0] = (uint8_t)(((unsigned)(sr + 0.5f) * a + px[0] * inv + 127) / 255);
            px[1] = (uint8_t)(((unsigned)(sg + 0.5f) * a + px[1] * inv + 127) / 255);
            px[2] = (uint8_t)(((unsigned)(sb + 0.5f) * a + px[2] * inv + 127) / 255);
        }
    }
}

void rc_blend_cov(RCanvas *c, const uint8_t *cov, int cw, int ch,
                  int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!cov || a == 0)
        return;
    for (int j = 0; j < ch; j++) {
        int oy = y + j;
        if (oy < 0 || oy >= c->h)
            continue;
        for (int i = 0; i < cw; i++) {
            int ox = x + i;
            if (ox < 0 || ox >= c->w)
                continue;
            unsigned cv = cov[(size_t)j * cw + i];
            if (!cv)
                continue;
            unsigned sa = (cv * a + 127) / 255;
            unsigned inv = 255 - sa;
            uint8_t *px = c->px + ((size_t)oy * c->w + ox) * 4;
            px[0] = (uint8_t)((r * sa + px[0] * inv + 127) / 255);
            px[1] = (uint8_t)((g * sa + px[1] * inv + 127) / 255);
            px[2] = (uint8_t)((b * sa + px[2] * inv + 127) / 255);
        }
    }
}
