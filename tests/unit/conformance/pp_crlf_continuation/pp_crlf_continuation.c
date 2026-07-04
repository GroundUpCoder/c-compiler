// BUG: CRLF line endings break backslash line-continuation: the lexer sees
//      backslash-CR and reports "Unexpected character: '\'".
// C11: 5.1.1.2p1 phases 1-2 -- physical source line endings are mapped to
//      new-line characters, then backslash + new-line splices lines; a file
//      using CRLF line endings with a continued macro must compile.
// EXPECT: ADD(2,3) == 5. (This file intentionally has literal \r\n line
//         endings and a backslash-continued #define.)
#include <stdio.h>
#define ADD(a,b) \
  ((a)+(b))
int main(void) { printf("%d\n", ADD(2,3)); return 0; }
