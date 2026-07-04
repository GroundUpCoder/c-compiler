// BUG: an inline definition in one TU plus the external definition of the same function in another TU is rejected as a duplicate definition at link time.
// C11: 6.7.4p7 -- `inline` (without extern or static) provides an inline definition only, NOT an external definition; the external definition may (and here does) live in another translation unit. A call may use either definition.
// EXPECT: links successfully; both definitions are identical, so g(4) prints 5 either way.
#include <stdio.h>
inline int g(int x) { return x + 1; }
int main(void) { printf("%d\n", g(4)); return 0; }
