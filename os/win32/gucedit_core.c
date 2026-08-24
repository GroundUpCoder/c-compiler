#include "gucedit.h"
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

static int u8_cont(unsigned char c) { return (c & 0xc0) == 0x80; }
static uint32_t u8_next(const char *s, uint32_t n, uint32_t p) {
    if (p >= n) return p;
    unsigned char c = (unsigned char)s[p]; uint32_t step = 1;
    if ((c & 0xe0) == 0xc0) step = 2;
    else if ((c & 0xf0) == 0xe0) step = 3;
    else if ((c & 0xf8) == 0xf0) step = 4;
    return p + step <= n ? p + step : n;
}

int gucedit_check_batch(const GUCEDIT_BATCH_V1 *b, const char *text,
                        uint32_t text_len, uint32_t generation) {
    if (!b || b->version != GUCEDIT_ABI_VERSION ||
        b->count > GUCEDIT_MAX_STYLES || b->count > text_len ||
        (uint64_t)b->count * sizeof(GUCEDIT_STYLE_V1) + sizeof(*b) != b->size)
        return GUCEDIT_CHECK_INVALID;
    if (b->text_generation != generation) return GUCEDIT_CHECK_STALE;
    uint32_t prev = 0;
    for (uint32_t k = 0; k < b->count; k++) {
        const GUCEDIT_STYLE_V1 *sp = &b->styles[k];
        if (sp->start >= sp->end || sp->end > text_len ||
            (k && sp->start < prev) || (sp->flags & ~GUES_VALID_MASK) ||
            (sp->foreground & 0xff000000u) || (sp->background & 0xff000000u) ||
            (sp->start && u8_cont((unsigned char)text[sp->start])) ||
            (sp->end < text_len && u8_cont((unsigned char)text[sp->end])) ||
            memchr(text + sp->start, '\n', sp->end - sp->start) ||
            ((sp->flags & GUES_BOX) &&
             (sp->end != u8_next(text, text_len, sp->start) || text[sp->start] == '\t')))
            return GUCEDIT_CHECK_INVALID;
        prev = sp->end;
    }
    return GUCEDIT_CHECK_OK;
}

int gucedit_replace_batch(GUCEDIT_BATCH_V1 **slot,
                          const GUCEDIT_BATCH_V1 *batch,
                          GUCEDIT_ALLOC_FN alloc_fn) {
    if (!slot || !batch || !alloc_fn) return 0;
    GUCEDIT_BATCH_V1 *copy = (GUCEDIT_BATCH_V1 *)alloc_fn(batch->size);
    if (!copy) return 0;
    memcpy(copy, batch, batch->size);
    free(*slot); *slot = copy; return 1;
}

uint32_t gucedit_generation_advance(uint32_t generation, const char *cur,
                                    uint32_t cur_len, char *last,
                                    uint32_t *last_len) {
    if (cur_len == *last_len && (!cur_len || !memcmp(cur, last, cur_len)))
        return generation;
    if (cur_len) memcpy(last, cur, cur_len);
    *last_len = cur_len;
    if (++generation == 0) generation = 1;
    return generation;
}

int gucedit_tab_advance(int x, int tab_width) {
    if (tab_width <= 0) return x;
    return ((x / tab_width) + 1) * tab_width;
}

int gucedit_mark_plan(const GUCEDIT_STYLE_V1 *style, int selected,
                      uint32_t highlight_text, int x0, int x1, int y,
                      int line_height, GUCEDIT_MARK_PLAN *out) {
    if (!style || !out || x1 <= x0 || line_height <= 1 ||
        !(style->flags & (GUES_UNDERLINE | GUES_BOX))) return 0;
    out->x0=x0; out->x1=x1-1; out->top=y; out->bottom=y+line_height-1;
    out->underline_y=y+line_height-2;
    out->color=selected?highlight_text:style->foreground;
    out->flags=style->flags&(GUES_UNDERLINE|GUES_BOX);
    return 1;
}

void gucedit_paint_span(const GUCEDIT_STYLE_V1 *style, int styles_current,
                        int selected, uint32_t default_foreground,
                        uint32_t highlight_text, int x0, int x1, int y,
                        int line_height, GUCEDIT_PAINT_SPAN *out) {
    memset(out,0,sizeof *out);
    out->x0=x0;out->x1=x1-1;out->top=y;out->bottom=y+line_height-1;
    if (!styles_current) style=NULL;
    out->foreground=selected?highlight_text:(style?style->foreground:default_foreground);
    if (style&&!selected&&(style->flags&GUES_BG_VALID)) {
        out->background=style->background; out->fill_background=1;
    }
    out->has_mark=gucedit_mark_plan(style,selected,highlight_text,x0,x1,y,line_height,&out->mark);
}
