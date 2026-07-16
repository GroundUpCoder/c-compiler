// BUG: companion to diag_pp_unknown_directive — pins what must STAY
// accepted around the new invalid-directive diagnostic (todos/0227 G22):
// unknown directives inside a SKIPPED conditional group, GNU line
// markers (`# 1 "file.c"` — PP_NUMBER after '#'), and the null
// directive (`#` alone).
// C11: 6.10p6 — within a skipped group only the conditional directives
// are recognized; 6.10p1's null directive; GNU line-marker extension.
// EXPECT: compiles clean, prints ok.
#include <stdio.h>
#if 0
#frobnicate
#this is not a directive either
#endif
# 1 "somewhere-else.c"
#
int main(void) {
    printf("ok\n");
    return 0;
}
