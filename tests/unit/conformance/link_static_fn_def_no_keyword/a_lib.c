// BUG: a function declared `static` and later DEFINED without the `static`
//      keyword was treated as an EXTERNAL definition, so two TUs each doing
//      this collided as a duplicate-symbol link error. Found ~60x in NetSurf
//      libcss (parse.c/language.c pattern).
// C11: 6.2.2p5 — a function declared with no storage-class specifier behaves
//      as if declared `extern`, and 6.2.2p4: with a prior visible declaration
//      the linkage is INHERITED from that declaration — here internal. Each
//      TU's `helper` is a distinct internal function.
// EXPECT: clang-verified output below.
#include <stdio.h>

static int helper(void);

int helper(void) { return 41; } /* inherits internal linkage */

/* declaration-only after the definition, still the same function */
extern int helper(void);

int a_val(void) { return helper() + 1; }
