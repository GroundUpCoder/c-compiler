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

/* One bounded incremental-scan turn (#729): feed the lexer SEDIT_SCAN_CHUNK
 * bytes at a time from text[*off..len) until end of text, until the turn has
 * consumed SEDIT_SCAN_TURN_BYTES, or until now_ns(clock_ctx) says the turn
 * has run SEDIT_SCAN_TURN_NS. Returns SEDIT_SCAN_MORE when a further turn is
 * needed (the caller re-posts itself), SEDIT_SCAN_DONE at end of text,
 * SEDIT_SCAN_OOM on lexer allocation failure. */
#define SEDIT_SCAN_CHUNK 32768u
#define SEDIT_SCAN_TURN_BYTES 262144u
#define SEDIT_SCAN_TURN_NS 8000000LL
enum { SEDIT_SCAN_OOM = -1, SEDIT_SCAN_DONE = 0, SEDIT_SCAN_MORE = 1 };
int sedit_scan_turn(SeditLexer *lex, const char *text, size_t len, size_t *off,
                    long long (*now_ns)(void *ctx), void *clock_ctx);
#endif
