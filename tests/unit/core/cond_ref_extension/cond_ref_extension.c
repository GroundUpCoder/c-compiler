// Compiler extension: GC refs and externrefs are accepted in
// boolean-context positions (if/while/?:/!) — sugar for null-check
// semantics. Strict C99 only allows scalar (arithmetic + pointer);
// we extend with refs because we have GC types.
#include <stdio.h>

__externref e;

int main(void) {
  // !ref is the canonical "is null" form
  if (!e) printf("null\n");
  // ref directly as cond
  while (e) break;            // never enters; e is null
  for (; e; ) break;
  printf("done\n");
  return 0;
}
