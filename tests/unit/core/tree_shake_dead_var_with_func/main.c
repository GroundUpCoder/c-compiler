// A static function only referenced from a dead static global must be
// dropped — the global isn't a root, so the function it references
// should not survive on that basis alone. The function's body refers
// to an undefined extern; if it isn't dropped, the linker fails.

#include <stdio.h>

extern int undefined_extern_func(int);

static int orphan(int x) { return undefined_extern_func(x); }

typedef int (*fp)(int);
static fp dead_table[] = { orphan };  // dead_table is unreferenced

int main(void) {
  printf("alive\n");
  return 0;
}
