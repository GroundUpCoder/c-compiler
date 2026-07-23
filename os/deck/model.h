/* model.h — the FROZEN .deck format, v1 (todos/0284, design §1.2).
 *
 * A .deck file is JSON (dedicated extension — openwith `json` would be
 * too broad). The WYSIWYG-first contract: every visible thing is an
 * element object with a stable `id` and EXPLICIT geometry (the v2
 * editor's selection unit and the agent's partial-edit unit are the same
 * object); array order = z-order; logical coordinate space decoupled
 * from window pixels; styles inline with an optional `theme` for
 * defaults.
 *
 *   { "deck": 1,                          // format version, REQUIRED
 *     "size": { "w": 1280, "h": 720 },    // logical space (default 1280x720)
 *     "theme": { "background": "#rrggbb[aa]",
 *                "text":   { "font", "size", "color" },
 *                "stroke": { "color", "width" },
 *                "fill":   "#rrggbb[aa]" | "none" },
 *     "slides": [ { "id": "slug",         // REQUIRED, agents address by id
 *                   "notes": "never rendered",
 *                   "elements": [ ... ] } ] }
 *
 * Element types v1 — EXACTLY these six (`arrow` is line+endArrow, not a
 * type):
 *   text     { id, type, x, y, w, h, text,
 *              style: { font, size, color, align, valign, wrap } }
 *   rect     { id, type, x, y, w, h,
 *              style: { fill, stroke, strokeWidth, radius },
 *              label: { text, size, color, font, align, valign, wrap } }
 *   ellipse  { id, type, x, y, w, h,   (bounding box)
 *              style: { fill, stroke, strokeWidth }, label: as rect }
 *   line     { id, type, x1, y1, x2, y2,
 *              style: { stroke, width, endArrow, startArrow, dash } }
 *   polyline { id, type, points: [[x,y],...],  (>= 2 points)
 *              style: as line }
 *   image    { id, type, x, y, w, h, src, fit: contain|cover|stretch }
 *
 * Style values: colors `#rrggbb` / `#rrggbbaa`; `fill`/`stroke` accept
 * "none"; `dash` is [on, off] in logical units; align left|center|right;
 * valign top|middle|bottom; wrap bool (default true); `font` is RESERVED
 * (validated, only "sans" today — gucman font packages slot in later
 * with no format change). `label` on rect/ellipse is sugar for a
 * centered wrapped text child (flow diagrams are 90% labeled boxes).
 *
 * Validation contract (agents iterate; strictness must be VISIBLE, not
 * fatal): malformed JSON, a missing required field, an unknown element
 * type, or bad geometry (w/h <= 0, malformed points) => a structured
 * DeckErr carrying the failing slide/element id and — for parse errors —
 * cJSON's error offset; the deck does not load. Unknown KEYS (element,
 * style, theme, slide, top level), bad style VALUES, a duplicate id, or
 * a missing image file => collected DeckWarns, defaults applied, the
 * deck loads. Lane 2 renders both on the on-screen placard; Lane 1
 * surfaces them on stderr and via --validate. */
#ifndef DECK_MODEL_H
#define DECK_MODEL_H

#include <stdint.h>

typedef struct { uint8_t r, g, b, a; } DColor;

enum { DEL_TEXT, DEL_RECT, DEL_ELLIPSE, DEL_LINE, DEL_POLYLINE, DEL_IMAGE };
enum { DALIGN_LEFT, DALIGN_CENTER, DALIGN_RIGHT };
enum { DVALIGN_TOP, DVALIGN_MIDDLE, DVALIGN_BOTTOM };
enum { DFIT_CONTAIN, DFIT_COVER, DFIT_STRETCH };

#define DECK_ID_MAX 64

typedef struct DElem {
    char id[DECK_ID_MAX];
    int type;                       /* DEL_* */

    float x, y, w, h;               /* text/rect/ellipse/image */
    float x1, y1, x2, y2;           /* line */
    float (*pts)[2];                /* polyline (owned) */
    int npts;

    char *text;                     /* text (owned) */
    char *src;                      /* image: as written (owned) */
    char *path;                     /* image: resolved vs deck dir (owned) */
    int fit;                        /* DFIT_* */

    /* resolved style (theme defaults already applied) */
    int hasFill;  DColor fill;
    int hasStroke; DColor stroke;
    float strokeWidth;              /* rect/ellipse stroke, line width */
    float radius;                   /* rect corner radius */
    DColor color;                   /* text color */
    float size;                     /* text px in logical units */
    int align, valign, wrap;
    int startArrow, endArrow;
    int hasDash; float dash[2];

    struct DElem *label;            /* rect/ellipse sugar -> a DEL_TEXT (owned) */

    /* render-time image cache (deck.c fills; model owns the free) */
    uint8_t *img; int imgW, imgH;
    int imgFailed;                  /* load attempted and failed */
} DElem;

typedef struct {
    char id[DECK_ID_MAX];
    char *notes;                    /* never rendered (owned) */
    DElem *els;
    int nels;
} DSlide;

typedef struct {
    int version;                    /* == 1 */
    float w, h;                     /* logical space */
    DColor bg;                      /* theme.background */
    /* theme defaults (already folded into elements; kept for renderers
     * that need the raw defaults, e.g. letterbox bars use bg) */
    DColor thText; float thTextSize;
    DColor thStroke; float thStrokeW;
    int thHasFill; DColor thFill;
    DSlide *slides;
    int nslides;
    char dir[512];                  /* deck file's directory, for image src */
} Deck;

typedef struct {
    char where[96];                 /* "slide 'arch' element 'a1'" or "" */
    char msg[160];
} DeckWarn;

typedef struct {
    char where[96];
    char msg[200];
    long offset;                    /* byte offset for parse errors, else -1 */
} DeckErr;

/* Parse + validate `path`. On success returns the Deck (caller frees via
 * deck_free) and hands ownership of the collected warnings to *warns/
 * *nwarns (free(*warns) when done; may be NULL/0). On failure returns
 * NULL with *err filled; any warnings collected before the error are
 * still handed out (Lane 2's placard shows both). */
Deck *deck_load(const char *path, DeckErr *err, DeckWarn **warns, int *nwarns);
void deck_free(Deck *d);

/* Slide index for a slide id, -1 if absent (nav + --slide by id). */
int deck_slide_index(const Deck *d, const char *id);

#endif /* DECK_MODEL_H */
