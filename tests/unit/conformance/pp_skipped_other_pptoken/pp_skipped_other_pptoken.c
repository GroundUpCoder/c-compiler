// BUG: the lexer hard-errored ("Unexpected character") on characters like
//      @ $ ` that form no C token, even inside skipped #if 0 groups or in
//      macro bodies that are never expanded — cairo's
//      cairo-type1-glyph-names.c carries perl code (@ps_standard_encoding)
//      inside #if 0 and wouldn't lex.
// C11: 6.4p1 (preprocessing-token: "each non-white-space character that
//      cannot be one of the above"), 6.10p6 (skipped groups are only
//      processed to directive level), 6.4p2 footnote: such a token is only
//      undefined if it survives to conversion into an actual token.
// EXPECT: the @/$/` runs are dropped with the skipped group / unused macro
//         body; the program compiles and prints normally.
#include <stdio.h>

#if 0
@ps_standard_encoding = (
	NULL,	NULL,	$perl `stuff` @more,
);
#endif

/* legal as long as it's never expanded (C11 6.4p2) */
#define NEVER_USED @ $ `

#ifdef NOT_DEFINED
yet more @junk@
#endif

int main(void) {
    printf("skipped groups tolerated\n");
    return 0;
}
