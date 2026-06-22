/* A static-storage object initialized with a non-constant expression is a
   constraint violation in C (C11 6.7.9p4) — gcc/clang both reject it. The
   compiler must diagnose this rather than silently emit a zero (which it used
   to: the dynamic initializer never ran). atexit(...) is a function call, so
   it is never a constant expression. */
#include <stdlib.h>
static void cleanup(void) {}
static int registered = atexit(cleanup);
int main(void) { return registered; }
