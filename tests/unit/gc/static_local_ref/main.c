// `static` ref-typed variables: both file-scope and function-local.
// Codegen must use refNullIdx vs refNull correctly based on whether the
// heap type is an abstract heap byte (eqref/externref) or a concrete idx.
#include <stdio.h>

__eqref g_eq;                       // file-scope, abstract heap
__struct Foo { int x; } *g_foo;     // file-scope, concrete heap idx

void f(int n) {
  static __eqref s;                 // function-local static
  if (s == 0) {
    s = n;                          // implicit-box on first call
    printf("first call, set\n");
  } else {
    printf("subsequent: %d\n", __cast(int, s));
  }
}

int main(void) {
  printf("g_eq null: %d\n", g_eq == 0);
  printf("g_foo null: %d\n", g_foo == 0);

  g_eq = 100;                       // boxing now (in main, OK)
  g_foo = __new(__struct Foo *, 42);
  printf("g_eq: %d\n", __cast(int, g_eq));
  printf("g_foo.x: %d\n", g_foo->x);

  f(7);
  f(7);
  f(99);                            // s stays at 7
  return 0;
}
