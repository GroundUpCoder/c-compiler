#include <stdio.h>
#include <stddef.h>

__struct Foo { int x; };

int main(void) {
  __struct Foo *a;  // null
  __struct Foo *b = __new(__struct Foo *, 7);

  // boolean coercion in if/else
  if (a) printf("a non-null\n"); else printf("a null\n");
  if (b) printf("b non-null\n"); else printf("b null\n");

  // ! on ref
  printf("!a=%d !b=%d\n", !a, !b);

  // ternary
  printf("ternary: %d\n", b ? 1 : 0);

  // null compare with literal 0
  printf("a==0: %d  a!=0: %d\n", a == 0, a != 0);
  printf("b==0: %d  b!=0: %d\n", b == 0, b != 0);
  printf("0==a: %d  0==b: %d\n", 0 == a, 0 == b);

  // null compare with NULL macro
  printf("a==NULL: %d\n", a == NULL);

  // identity (== between two refs)
  __struct Foo *c = b;
  printf("b==c: %d  b==a: %d\n", b == c, b == a);
  printf("b!=c: %d  b!=a: %d\n", b != c, b != a);

  // assign 0 / NULL to ref
  b = 0;
  printf("after b=0: %d\n", b == 0);
  c = NULL;
  printf("after c=NULL: %d\n", c == 0);

  // initialize via 0 / NULL
  __struct Foo *d = 0;
  __struct Foo *e = NULL;
  printf("d null: %d  e null: %d\n", d == 0, e == 0);

  // boolean coercion in for-loop condition
  __array(int) arr = __new_array(int, 1, 2, 3);
  int seen = 0;
  for (auto i = arr; i; i = 0) seen++;
  printf("for-seen: %d\n", seen);

  // && / || with refs
  __struct Foo *p = __new(__struct Foo *, 1);
  __struct Foo *q;
  if (p && !q) printf("p&&!q\n");
  if (q || p) printf("q||p\n");

  // intrinsics still work alongside sugar
  printf("intrinsic ok: %d\n", __ref_is_null(d));
  printf("intrinsic eq: %d\n", __ref_eq(p, p));

  return 0;
}
