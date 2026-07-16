// BUG: the lexer's comment and newline branches never set the
//      "preceded by whitespace" flag on the following token, so the `#`
//      stringize operator rendered `S(a/**/b)` as "ab" and a two-line
//      argument as one word — and tokens arriving through a macro
//      expansion lost comment-derived spacing from their definition site
//      ((2/**/+ 1) stringized as "(2+ 1)").
// C11: 6.10.3.2p2 — each occurrence of white space (comments included,
//      5.1.1.2p1 phase 3) between the argument's preprocessing tokens
//      becomes ONE space; leading/trailing white space is deleted;
//      original spelling is otherwise preserved.
// EXPECT: matches clang.
#include <stdio.h>
#define S2(x) #x
#define S(x) S2(x)
#define V1 ( 2 +1)
#define V2 (2/**/+ 1)
int main(void) {
  printf("[%s]\n", S2(a/**/b));
  printf("[%s]\n", S2(a
b));
  printf("[%s]\n", S2(  lead  mid   trail  ));
  printf("[%s]\n", S2("str  lit" 'c'));
  printf("[%s]\n", S(V1));
  printf("[%s]\n", S(V2));
  printf("[%s]\n", S2(/**/x/**/));
  return 0;
}
