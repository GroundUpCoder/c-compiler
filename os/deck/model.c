/* model.c — .deck v1 parse + validation (todos/0284; format contract in
 * model.h). Validation is VISIBLE, not fatal, for unknown keys and bad
 * style values (collected DeckWarns, defaults applied); malformed JSON /
 * missing required fields / unknown types / bad geometry are structured
 * DeckErrs that abort the load — the first one wins (agents fix one at a
 * time; the where/offset points straight at it). */
#include "model.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

/* ---- load context --------------------------------------------------- */

typedef struct {
    DeckWarn *warns;
    int nwarns, wcap;
    DeckErr *err;
    int failed;
    char slideId[DECK_ID_MAX];      /* "" outside a slide */
    char elemId[DECK_ID_MAX];       /* "" outside an element */
} Ctx;

static void where_str(Ctx *c, char *out, int cap) {
    if (c->elemId[0])
        snprintf(out, cap, "slide '%s' element '%s'", c->slideId, c->elemId);
    else if (c->slideId[0])
        snprintf(out, cap, "slide '%s'", c->slideId);
    else
        out[0] = 0;
}

static void warnf(Ctx *c, const char *fmt, ...) {
    if (c->nwarns == c->wcap) {
        int nc = c->wcap ? c->wcap * 2 : 8;
        DeckWarn *nw = realloc(c->warns, (size_t)nc * sizeof(DeckWarn));
        if (!nw)
            return;                 /* OOM: drop the warning, keep loading */
        c->warns = nw;
        c->wcap = nc;
    }
    DeckWarn *w = &c->warns[c->nwarns++];
    where_str(c, w->where, sizeof w->where);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(w->msg, sizeof w->msg, fmt, ap);
    va_end(ap);
}

static void failf(Ctx *c, const char *fmt, ...) {
    if (c->failed)
        return;                     /* first error wins */
    c->failed = 1;
    where_str(c, c->err->where, sizeof c->err->where);
    c->err->offset = -1;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(c->err->msg, sizeof c->err->msg, fmt, ap);
    va_end(ap);
}

/* ---- small accessors ------------------------------------------------- */

static int jnum(const cJSON *o, const char *k, float *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    if (!v || !cJSON_IsNumber(v))
        return 0;
    *out = (float)v->valuedouble;
    return 1;
}

static const char *jstr(const cJSON *o, const char *k) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    return v && cJSON_IsString(v) ? v->valuestring : NULL;
}

/* Warn on every key not in the NULL-terminated allowed list. */
static void check_keys(Ctx *c, const cJSON *obj, const char *what,
                       const char *const *allowed) {
    const cJSON *ch;
    cJSON_ArrayForEach(ch, obj) {
        if (!ch->string)
            continue;
        int ok = 0;
        for (int i = 0; allowed[i] && !ok; i++)
            ok = strcmp(ch->string, allowed[i]) == 0;
        if (!ok)
            warnf(c, "unknown %s key '%s' (ignored)", what, ch->string);
    }
}

static int hexval(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

/* "#rrggbb" / "#rrggbbaa" -> DColor. Returns 0 (and leaves *out) on a
 * malformed string — callers warn and keep their default. */
static int parse_color(const char *s, DColor *out) {
    if (!s || s[0] != '#')
        return 0;
    size_t len = strlen(s + 1);
    if (len != 6 && len != 8)
        return 0;
    int v[8];
    for (size_t i = 0; i < len; i++)
        if ((v[i] = hexval(s[1 + i])) < 0)
            return 0;
    out->r = (uint8_t)(v[0] * 16 + v[1]);
    out->g = (uint8_t)(v[2] * 16 + v[3]);
    out->b = (uint8_t)(v[4] * 16 + v[5]);
    out->a = len == 8 ? (uint8_t)(v[6] * 16 + v[7]) : 255;
    return 1;
}

/* A color-or-"none" style value into hasX/X, warning on garbage. */
static void style_paint(Ctx *c, const cJSON *style, const char *key,
                        int *has, DColor *col) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, key);
    if (!v)
        return;
    if (cJSON_IsString(v)) {
        if (strcmp(v->valuestring, "none") == 0) {
            *has = 0;
            return;
        }
        if (parse_color(v->valuestring, col)) {
            *has = 1;
            return;
        }
    }
    warnf(c, "bad '%s' value (want \"#rrggbb[aa]\" or \"none\"); default kept", key);
}

static void style_num(Ctx *c, const cJSON *style, const char *key,
                      float min, float *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, key);
    if (!v)
        return;
    if (cJSON_IsNumber(v) && (float)v->valuedouble >= min) {
        *out = (float)v->valuedouble;
        return;
    }
    warnf(c, "bad '%s' value (want a number >= %g); default kept", key, min);
}

static void style_bool(Ctx *c, const cJSON *style, const char *key, int *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, key);
    if (!v)
        return;
    if (cJSON_IsBool(v)) {
        *out = v->valueint ? 1 : 0;
        return;
    }
    warnf(c, "bad '%s' value (want true/false); default kept", key);
}

static void style_enum(Ctx *c, const cJSON *style, const char *key,
                       const char *const *names, int *out) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, key);
    if (!v)
        return;
    if (cJSON_IsString(v))
        for (int i = 0; names[i]; i++)
            if (strcmp(v->valuestring, names[i]) == 0) {
                *out = i;
                return;
            }
    warnf(c, "bad '%s' value; default kept", key);
}

/* `font` is reserved-not-ignored: only "sans" exists today (the baked
 * Noto Sans Mono face); gucman font packages extend this later with no
 * format change. Anything else renders sans, loudly. */
static void style_font(Ctx *c, const cJSON *style) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, "font");
    if (!v)
        return;
    if (cJSON_IsString(v) && strcmp(v->valuestring, "sans") == 0)
        return;
    if (cJSON_IsString(v))
        warnf(c, "font '%s' not available (only \"sans\"); using sans",
              v->valuestring);
    else
        warnf(c, "bad 'font' value (want a string); using sans");
}

static void style_dash(Ctx *c, const cJSON *style, DElem *e) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(style, "dash");
    if (!v)
        return;
    if (cJSON_IsArray(v) && cJSON_GetArraySize(v) == 2) {
        const cJSON *on = cJSON_GetArrayItem(v, 0);
        const cJSON *off = cJSON_GetArrayItem(v, 1);
        if (cJSON_IsNumber(on) && cJSON_IsNumber(off) &&
            on->valuedouble > 0 && off->valuedouble > 0) {
            e->hasDash = 1;
            e->dash[0] = (float)on->valuedouble;
            e->dash[1] = (float)off->valuedouble;
            return;
        }
    }
    warnf(c, "bad 'dash' value (want [on, off], both > 0); solid kept");
}

static char *dupstr(const char *s) {
    size_t n = strlen(s) + 1;
    char *d = malloc(n);
    if (d)
        memcpy(d, s, n);
    return d;
}

/* ---- ids ------------------------------------------------------------- */

static int read_id(Ctx *c, const cJSON *obj, const char *what,
                   char out[DECK_ID_MAX]) {
    const char *id = jstr(obj, "id");
    if (!id || !id[0]) {
        failf(c, "%s is missing required 'id'", what);
        return 0;
    }
    if (strlen(id) >= DECK_ID_MAX)
        warnf(c, "%s id '%.20s...' longer than %d chars (truncated)",
              what, id, DECK_ID_MAX - 1);
    snprintf(out, DECK_ID_MAX, "%s", id);
    for (const char *p = out; *p; p++)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '-' || *p == '_')) {
            warnf(c, "%s id '%s' is not a slug ([A-Za-z0-9_-])", what, out);
            break;
        }
    return 1;
}

/* ---- elements --------------------------------------------------------- */

static const char *const TEXT_STYLE_KEYS[] =
    { "font", "size", "color", "align", "valign", "wrap", NULL };
static const char *const RECT_STYLE_KEYS[] =
    { "fill", "stroke", "strokeWidth", "radius", NULL };
static const char *const ELLIPSE_STYLE_KEYS[] =
    { "fill", "stroke", "strokeWidth", NULL };
static const char *const LINE_STYLE_KEYS[] =
    { "stroke", "width", "endArrow", "startArrow", "dash", NULL };
static const char *const ALIGN_NAMES[] = { "left", "center", "right", NULL };
static const char *const VALIGN_NAMES[] = { "top", "middle", "bottom", NULL };
static const char *const FIT_NAMES[] = { "contain", "cover", "stretch", NULL };
static const char *const LABEL_KEYS[] =
    { "text", "font", "size", "color", "align", "valign", "wrap", NULL };

/* Fold the theme's defaults into a fresh element of `type`. */
static void elem_defaults(const Deck *d, DElem *e, int type) {
    memset(e, 0, sizeof *e);
    e->type = type;
    e->color = d->thText;
    e->size = d->thTextSize;
    e->align = DALIGN_LEFT;
    e->valign = DVALIGN_TOP;
    e->wrap = 1;
    e->hasFill = d->thHasFill;
    e->fill = d->thFill;
    e->hasStroke = 1;
    e->stroke = d->thStroke;
    e->strokeWidth = d->thStrokeW;
    e->fit = DFIT_CONTAIN;
}

/* Geometry x/y/w/h with w,h > 0 — the explicit-geometry contract. */
static int read_box(Ctx *c, const cJSON *jo, DElem *e) {
    if (!jnum(jo, "x", &e->x) || !jnum(jo, "y", &e->y) ||
        !jnum(jo, "w", &e->w) || !jnum(jo, "h", &e->h)) {
        failf(c, "missing/non-numeric geometry (need x, y, w, h)");
        return 0;
    }
    if (e->w <= 0 || e->h <= 0) {
        failf(c, "bad geometry: w and h must be > 0 (got %g x %g)", e->w, e->h);
        return 0;
    }
    return 1;
}

/* stroke/width/arrows/dash — shared by line and polyline. */
static void read_line_style(Ctx *c, const cJSON *style, DElem *e) {
    if (!style)
        return;
    check_keys(c, style, "style", LINE_STYLE_KEYS);
    const cJSON *col = cJSON_GetObjectItemCaseSensitive(style, "stroke");
    if (col && (!cJSON_IsString(col) ||
                !parse_color(col->valuestring, &e->stroke)))
        warnf(c, "bad 'stroke' value; default kept");
    style_num(c, style, "width", 0.0f, &e->strokeWidth);
    style_bool(c, style, "endArrow", &e->endArrow);
    style_bool(c, style, "startArrow", &e->startArrow);
    style_dash(c, style, e);
}

/* label: {...} on rect/ellipse — sugar for a centered wrapped text child
 * sharing the shape's box. */
static void read_label(Ctx *c, const Deck *d, const cJSON *jo, DElem *e) {
    const cJSON *jl = cJSON_GetObjectItemCaseSensitive(jo, "label");
    if (!jl)
        return;
    if (!cJSON_IsObject(jl)) {
        warnf(c, "bad 'label' (want an object); ignored");
        return;
    }
    check_keys(c, jl, "label", LABEL_KEYS);
    const char *txt = jstr(jl, "text");
    if (!txt) {
        warnf(c, "label is missing 'text'; ignored");
        return;
    }
    DElem *l = malloc(sizeof *l);
    if (!l)
        return;
    elem_defaults(d, l, DEL_TEXT);
    snprintf(l->id, DECK_ID_MAX, "%s.label", e->id);
    l->x = e->x;
    l->y = e->y;
    l->w = e->w;
    l->h = e->h;
    l->align = DALIGN_CENTER;
    l->valign = DVALIGN_MIDDLE;
    l->text = dupstr(txt);
    style_font(c, jl);
    style_num(c, jl, "size", 1.0f, &l->size);
    const cJSON *col = cJSON_GetObjectItemCaseSensitive(jl, "color");
    if (col) {
        if (!cJSON_IsString(col) || !parse_color(col->valuestring, &l->color))
            warnf(c, "bad label 'color'; default kept");
    }
    style_enum(c, jl, "align", ALIGN_NAMES, &l->align);
    style_enum(c, jl, "valign", VALIGN_NAMES, &l->valign);
    style_bool(c, jl, "wrap", &l->wrap);
    e->label = l;
}

static void read_element(Ctx *c, Deck *d, const cJSON *jo, DElem *e) {
    if (!cJSON_IsObject(jo)) {
        failf(c, "element is not an object");
        return;
    }
    /* id first so every later message can name it */
    char id[DECK_ID_MAX];
    if (!read_id(c, jo, "element", id))
        return;
    snprintf(c->elemId, DECK_ID_MAX, "%s", id);

    const char *type = jstr(jo, "type");
    if (!type) {
        failf(c, "element is missing required 'type'");
        return;
    }
    int t;
    if (strcmp(type, "text") == 0) t = DEL_TEXT;
    else if (strcmp(type, "rect") == 0) t = DEL_RECT;
    else if (strcmp(type, "ellipse") == 0) t = DEL_ELLIPSE;
    else if (strcmp(type, "line") == 0) t = DEL_LINE;
    else if (strcmp(type, "polyline") == 0) t = DEL_POLYLINE;
    else if (strcmp(type, "image") == 0) t = DEL_IMAGE;
    else {
        failf(c, "unknown element type '%s' (v1: text, rect, ellipse, "
                 "line, polyline, image; arrow = line + endArrow)", type);
        return;
    }
    elem_defaults(d, e, t);
    memcpy(e->id, id, DECK_ID_MAX);

    const cJSON *style = cJSON_GetObjectItemCaseSensitive(jo, "style");
    if (style && !cJSON_IsObject(style)) {
        warnf(c, "bad 'style' (want an object); ignored");
        style = NULL;
    }

    switch (t) {
    case DEL_TEXT: {
        static const char *const KEYS[] =
            { "id", "type", "x", "y", "w", "h", "text", "style", NULL };
        check_keys(c, jo, "element", KEYS);
        if (!read_box(c, jo, e))
            return;
        const char *txt = jstr(jo, "text");
        if (!txt) {
            failf(c, "text element is missing required 'text'");
            return;
        }
        e->text = dupstr(txt);
        if (style) {
            check_keys(c, style, "style", TEXT_STYLE_KEYS);
            style_font(c, style);
            style_num(c, style, "size", 1.0f, &e->size);
            const cJSON *col = cJSON_GetObjectItemCaseSensitive(style, "color");
            if (col && (!cJSON_IsString(col) ||
                        !parse_color(col->valuestring, &e->color)))
                warnf(c, "bad 'color' value; default kept");
            style_enum(c, style, "align", ALIGN_NAMES, &e->align);
            style_enum(c, style, "valign", VALIGN_NAMES, &e->valign);
            style_bool(c, style, "wrap", &e->wrap);
        }
        break;
    }
    case DEL_RECT:
    case DEL_ELLIPSE: {
        static const char *const KEYS[] =
            { "id", "type", "x", "y", "w", "h", "style", "label", NULL };
        check_keys(c, jo, "element", KEYS);
        if (!read_box(c, jo, e))
            return;
        if (style) {
            check_keys(c, style, "style",
                       t == DEL_RECT ? RECT_STYLE_KEYS : ELLIPSE_STYLE_KEYS);
            style_paint(c, style, "fill", &e->hasFill, &e->fill);
            style_paint(c, style, "stroke", &e->hasStroke, &e->stroke);
            style_num(c, style, "strokeWidth", 0.0f, &e->strokeWidth);
            if (t == DEL_RECT)
                style_num(c, style, "radius", 0.0f, &e->radius);
        }
        read_label(c, d, jo, e);
        break;
    }
    case DEL_LINE: {
        static const char *const KEYS[] =
            { "id", "type", "x1", "y1", "x2", "y2", "style", NULL };
        check_keys(c, jo, "element", KEYS);
        if (!jnum(jo, "x1", &e->x1) || !jnum(jo, "y1", &e->y1) ||
            !jnum(jo, "x2", &e->x2) || !jnum(jo, "y2", &e->y2)) {
            failf(c, "missing/non-numeric geometry (need x1, y1, x2, y2)");
            return;
        }
        read_line_style(c, style, e);
        break;
    }
    case DEL_POLYLINE: {
        static const char *const KEYS[] =
            { "id", "type", "points", "style", NULL };
        check_keys(c, jo, "element", KEYS);
        const cJSON *jp = cJSON_GetObjectItemCaseSensitive(jo, "points");
        if (!jp || !cJSON_IsArray(jp) || cJSON_GetArraySize(jp) < 2) {
            failf(c, "polyline needs a 'points' array of >= 2 [x, y] pairs");
            return;
        }
        int n = cJSON_GetArraySize(jp);
        e->pts = malloc((size_t)n * sizeof *e->pts);
        if (!e->pts) {
            failf(c, "out of memory");
            return;
        }
        int i = 0;
        const cJSON *pt;
        cJSON_ArrayForEach(pt, jp) {
            const cJSON *px, *py;
            if (!cJSON_IsArray(pt) || cJSON_GetArraySize(pt) != 2 ||
                !cJSON_IsNumber(px = cJSON_GetArrayItem(pt, 0)) ||
                !cJSON_IsNumber(py = cJSON_GetArrayItem(pt, 1))) {
                failf(c, "bad geometry: points[%d] is not [x, y]", i);
                return;
            }
            e->pts[i][0] = (float)px->valuedouble;
            e->pts[i][1] = (float)py->valuedouble;
            i++;
        }
        e->npts = n;
        read_line_style(c, style, e);
        break;
    }
    case DEL_IMAGE: {
        static const char *const KEYS[] =
            { "id", "type", "x", "y", "w", "h", "src", "fit", NULL };
        check_keys(c, jo, "element", KEYS);
        if (!read_box(c, jo, e))
            return;
        const char *src = jstr(jo, "src");
        if (!src || !src[0]) {
            failf(c, "image element is missing required 'src'");
            return;
        }
        e->src = dupstr(src);
        char full[1024];
        if (src[0] == '/')
            snprintf(full, sizeof full, "%s", src);
        else
            snprintf(full, sizeof full, "%s/%s", d->dir, src);
        e->path = dupstr(full);
        const cJSON *fit = cJSON_GetObjectItemCaseSensitive(jo, "fit");
        if (fit) {
            if (cJSON_IsString(fit)) {
                int got = -1;
                for (int i = 0; FIT_NAMES[i]; i++)
                    if (strcmp(fit->valuestring, FIT_NAMES[i]) == 0)
                        got = i;
                if (got >= 0)
                    e->fit = got;
                else
                    warnf(c, "bad 'fit' value '%s' (want contain|cover|"
                             "stretch); using contain", fit->valuestring);
            } else
                warnf(c, "bad 'fit' value; using contain");
        }
        /* existence probe now, visibly — the render draws a placeholder */
        FILE *f = fopen(e->path, "rb");
        if (f)
            fclose(f);
        else
            warnf(c, "image '%s' not found (placeholder will render)", e->path);
        break;
    }
    }
}

/* ---- theme ------------------------------------------------------------ */

static void read_theme(Ctx *c, Deck *d, const cJSON *root) {
    const cJSON *th = cJSON_GetObjectItemCaseSensitive(root, "theme");
    if (!th)
        return;
    if (!cJSON_IsObject(th)) {
        warnf(c, "bad 'theme' (want an object); defaults kept");
        return;
    }
    static const char *const THEME_KEYS[] =
        { "background", "text", "stroke", "fill", NULL };
    check_keys(c, th, "theme", THEME_KEYS);
    const char *bg = jstr(th, "background");
    if (bg && !parse_color(bg, &d->bg))
        warnf(c, "bad theme 'background'; default kept");
    const cJSON *tx = cJSON_GetObjectItemCaseSensitive(th, "text");
    if (tx && cJSON_IsObject(tx)) {
        static const char *const KEYS[] = { "font", "size", "color", NULL };
        check_keys(c, tx, "theme text", KEYS);
        style_font(c, tx);
        style_num(c, tx, "size", 1.0f, &d->thTextSize);
        const char *col = jstr(tx, "color");
        if (col && !parse_color(col, &d->thText))
            warnf(c, "bad theme text 'color'; default kept");
    } else if (tx)
        warnf(c, "bad theme 'text' (want an object); defaults kept");
    const cJSON *st = cJSON_GetObjectItemCaseSensitive(th, "stroke");
    if (st && cJSON_IsObject(st)) {
        static const char *const KEYS[] = { "color", "width", NULL };
        check_keys(c, st, "theme stroke", KEYS);
        const char *col = jstr(st, "color");
        if (col && !parse_color(col, &d->thStroke))
            warnf(c, "bad theme stroke 'color'; default kept");
        style_num(c, st, "width", 0.0f, &d->thStrokeW);
    } else if (st)
        warnf(c, "bad theme 'stroke' (want an object); defaults kept");
    style_paint(c, th, "fill", &d->thHasFill, &d->thFill);
}

/* ---- top level --------------------------------------------------------- */

static void free_elem(DElem *e) {
    free(e->pts);
    free(e->text);
    free(e->src);
    free(e->path);
    free(e->img);
    if (e->label) {
        free_elem(e->label);
        free(e->label);
    }
}

void deck_free(Deck *d) {
    if (!d)
        return;
    for (int s = 0; s < d->nslides; s++) {
        for (int i = 0; i < d->slides[s].nels; i++)
            free_elem(&d->slides[s].els[i]);
        free(d->slides[s].els);
        free(d->slides[s].notes);
    }
    free(d->slides);
    free(d);
}

int deck_slide_index(const Deck *d, const char *id) {
    for (int i = 0; i < d->nslides; i++)
        if (strcmp(d->slides[i].id, id) == 0)
            return i;
    return -1;
}

Deck *deck_load(const char *path, DeckErr *err, DeckWarn **warns, int *nwarns) {
    Ctx c;
    memset(&c, 0, sizeof c);
    c.err = err;
    memset(err, 0, sizeof *err);
    err->offset = -1;
    *warns = NULL;
    *nwarns = 0;

    Deck *d = NULL;
    char *buf = NULL;
    cJSON *root = NULL;

    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(err->msg, sizeof err->msg, "cannot open '%s'", path);
        goto fail;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0 || !(buf = malloc((size_t)sz + 1))) {
        fclose(f);
        snprintf(err->msg, sizeof err->msg, "cannot read '%s'", path);
        goto fail;
    }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = 0;

    const char *end = NULL;
    root = cJSON_ParseWithOpts(buf, &end, 0);
    if (!root) {
        snprintf(err->msg, sizeof err->msg, "JSON parse error");
        err->offset = end ? (long)(end - buf) : -1;
        goto fail;
    }
    if (!cJSON_IsObject(root)) {
        snprintf(err->msg, sizeof err->msg, "top level is not an object");
        goto fail;
    }

    d = calloc(1, sizeof *d);
    if (!d) {
        snprintf(err->msg, sizeof err->msg, "out of memory");
        goto fail;
    }
    /* deck dir, for relative image srcs */
    const char *slash = strrchr(path, '/');
    if (slash)
        snprintf(d->dir, sizeof d->dir, "%.*s", (int)(slash - path), path);
    else
        snprintf(d->dir, sizeof d->dir, ".");

    /* neutral defaults; a theme overrides */
    d->w = 1280;
    d->h = 720;
    d->bg = (DColor){ 255, 255, 255, 255 };
    d->thText = (DColor){ 0, 0, 0, 255 };
    d->thTextSize = 32;
    d->thStroke = (DColor){ 0, 0, 0, 255 };
    d->thStrokeW = 3;
    d->thHasFill = 0;
    d->thFill = (DColor){ 0, 0, 0, 255 };

    static const char *const TOP_KEYS[] =
        { "deck", "size", "theme", "slides", NULL };
    check_keys(&c, root, "top-level", TOP_KEYS);

    const cJSON *ver = cJSON_GetObjectItemCaseSensitive(root, "deck");
    if (!ver || !cJSON_IsNumber(ver)) {
        failf(&c, "missing required \"deck\": 1 (the format version)");
        goto fail;
    }
    if (ver->valueint != 1) {
        failf(&c, "unsupported deck format version %d (this build reads 1)",
              ver->valueint);
        goto fail;
    }

    const cJSON *size = cJSON_GetObjectItemCaseSensitive(root, "size");
    if (size) {
        static const char *const KEYS[] = { "w", "h", NULL };
        if (!cJSON_IsObject(size) ||
            (check_keys(&c, size, "size", KEYS), 0) ||
            !jnum(size, "w", &d->w) || !jnum(size, "h", &d->h) ||
            d->w <= 0 || d->h <= 0) {
            failf(&c, "bad 'size' (want { \"w\": > 0, \"h\": > 0 })");
            goto fail;
        }
    }

    read_theme(&c, d, root);
    if (c.failed)
        goto fail;

    const cJSON *slides = cJSON_GetObjectItemCaseSensitive(root, "slides");
    if (!slides || !cJSON_IsArray(slides) || cJSON_GetArraySize(slides) < 1) {
        failf(&c, "missing 'slides' (want a non-empty array)");
        goto fail;
    }
    d->nslides = cJSON_GetArraySize(slides);
    d->slides = calloc((size_t)d->nslides, sizeof(DSlide));
    if (!d->slides) {
        failf(&c, "out of memory");
        goto fail;
    }
    int si = 0;
    const cJSON *js;
    cJSON_ArrayForEach(js, slides) {
        DSlide *s = &d->slides[si++];
        c.slideId[0] = c.elemId[0] = 0;
        if (!cJSON_IsObject(js)) {
            snprintf(c.slideId, DECK_ID_MAX, "#%d", si);
            failf(&c, "slide is not an object");
            goto fail;
        }
        if (!read_id(&c, js, "slide", s->id)) {
            snprintf(c.slideId, DECK_ID_MAX, "#%d", si);
            goto fail;
        }
        memcpy(c.slideId, s->id, DECK_ID_MAX);
        for (int k = 0; k < si - 1; k++)
            if (strcmp(d->slides[k].id, s->id) == 0) {
                warnf(&c, "duplicate slide id '%s'", s->id);
                break;
            }
        static const char *const KEYS[] = { "id", "notes", "elements", NULL };
        check_keys(&c, js, "slide", KEYS);
        const char *notes = jstr(js, "notes");
        if (notes)
            s->notes = dupstr(notes);

        const cJSON *els = cJSON_GetObjectItemCaseSensitive(js, "elements");
        if (!els)
            continue;               /* an empty slide is legal */
        if (!cJSON_IsArray(els)) {
            failf(&c, "bad 'elements' (want an array)");
            goto fail;
        }
        s->nels = cJSON_GetArraySize(els);
        if (!s->nels)
            continue;
        s->els = calloc((size_t)s->nels, sizeof(DElem));
        if (!s->els) {
            failf(&c, "out of memory");
            goto fail;
        }
        int ei = 0;
        const cJSON *je;
        cJSON_ArrayForEach(je, els) {
            DElem *e = &s->els[ei++];
            c.elemId[0] = 0;
            read_element(&c, d, je, e);
            if (c.failed)
                goto fail;
            for (int k = 0; k < ei - 1; k++)
                if (strcmp(s->els[k].id, e->id) == 0) {
                    warnf(&c, "duplicate element id '%s'", e->id);
                    break;
                }
        }
    }

    cJSON_Delete(root);
    free(buf);
    *warns = c.warns;
    *nwarns = c.nwarns;
    return d;

fail:
    if (root)
        cJSON_Delete(root);
    free(buf);
    deck_free(d);
    *warns = c.warns;              /* placard shows warnings + the error */
    *nwarns = c.nwarns;
    return NULL;
}
