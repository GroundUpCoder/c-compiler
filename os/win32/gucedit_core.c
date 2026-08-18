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
