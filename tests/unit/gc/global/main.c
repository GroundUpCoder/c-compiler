#include <stdio.h>

__struct Foo { int x; };
__struct Foo *g_foo;          // global, auto-null
__array(int) g_arr;          // global, auto-null

void inc_g_foo(void) {
  g_foo->x = g_foo->x + 1;
}

int main(void) {
  printf("g_foo null: %d\n", g_foo == 0);
  printf("g_arr null: %d\n", g_arr == 0);

  g_foo = __new(__struct Foo *, 100);
  g_arr = __new_array(int, 1, 2, 3);

  printf("g_foo.x = %d\n", g_foo->x);
  printf("g_arr len = %d\n", __array_len(g_arr));

  inc_g_foo();
  inc_g_foo();
  printf("g_foo.x after inc x2 = %d\n", g_foo->x);

  // Re-null
  g_foo = 0;
  printf("g_foo null again: %d\n", !g_foo);

  // Static local — also a global internally
  static __struct Foo *s;
  printf("static null: %d\n", !s);
  if (!s) s = __new(__struct Foo *, 7);
  printf("static.x: %d\n", s->x);

  return 0;
}
