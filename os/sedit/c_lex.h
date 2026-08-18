#ifndef SEDIT_C_LEX_H
#define SEDIT_C_LEX_H
#include <stddef.h>
#include <stdint.h>

enum SeditTokenKind { SEDIT_T_KEYWORD=1, SEDIT_T_TYPE, SEDIT_T_NUMBER,
    SEDIT_T_STRING, SEDIT_T_CHAR, SEDIT_T_COMMENT, SEDIT_T_PREPROCESSOR,
    SEDIT_T_PUNCT, SEDIT_T_ERROR };
typedef struct { uint32_t start, end; uint8_t kind; } SeditToken;
typedef struct { uint32_t at, mate; uint8_t unmatched; } SeditPair;
typedef struct {
    SeditToken *tokens; size_t token_count, token_cap;
    SeditPair *pairs; size_t pair_count, pair_cap;
    uint64_t *stack; size_t stack_count, stack_cap;
    int state, escape, line_start, directive_cont;
    uint32_t token_start, offset;
    int failed;
} SeditLexer;

void sedit_lex_init(SeditLexer *lx);
int sedit_lex_feed(SeditLexer *lx, const char *bytes, size_t n);
int sedit_lex_finish(SeditLexer *lx);
void sedit_lex_free(SeditLexer *lx);
int sedit_pair_mate(const SeditLexer *lx, uint32_t at, uint32_t *mate, int *unmatched);
#endif
