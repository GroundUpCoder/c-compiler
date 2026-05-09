// A static global that nothing references must be tree-shaken. Its
// initializer mentions a fake extern that doesn't exist; if the global
// survives, the linker errors out. The fact that this links and runs
// proves the dead global was actually dropped.

#include <stdio.h>

extern int undefined_extern_symbol;

static int *dead_global = &undefined_extern_symbol;

int main(void) {
  printf("alive\n");
  return 0;
}
