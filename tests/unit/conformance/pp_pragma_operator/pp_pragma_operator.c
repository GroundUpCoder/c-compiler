// BUG: _Pragma("once") only worked as a literal in the raw token stream —
//      a _Pragma produced by macro expansion (the DO_PRAGMA(#x) idiom) was
//      emitted as ordinary tokens and became a parse error, and the
//      destringize step didn't undo \" / \\ escapes.
// C11: 6.10.9 — _Pragma(string-literal) is destringized (delete prefix and
//      quotes, \" -> ", \\ -> \) and processed as if it were a #pragma
//      directive, wherever the operator appears in the token stream.
// EXPECT: both headers are included exactly once (redefinition of the
//      global would otherwise fail the compile).
#include <stdio.h>
#include "once_direct.h"
#include "once_direct.h"
#include "once_macro.h"
#include "once_macro.h"
int main(void) {
  printf("%d %d\n", once_direct, once_macro);
  return 0;
}
