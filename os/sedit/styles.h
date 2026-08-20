#ifndef SEDIT_STYLES_H
#define SEDIT_STYLES_H
#include <stddef.h>
#include <stdint.h>
#include "c_lex.h"
#include "../win32/gucedit.h"

/* Build a GEM_SETSTYLES batch from a completed lexer pass over text[0..len).
 * caret is the selection end used for delimiter-mate boxing; text may be NULL
 * only when len is 0. Returns NULL on allocation failure. *truncated is set
 * to 1 when styles were dropped at the batch bound, else 0. */
GUCEDIT_BATCH_V1 *sedit_styles_build(const SeditLexer *lex, const char *text,
                                     size_t len, uint32_t caret,
                                     uint32_t generation, int *truncated);
#endif
