#include <stdio.h>

int identity(int x) { return x; }

int main(void) {
  // Primitive inference
  auto i = 42;
  auto u = 7u;
  auto l = 100L;
  auto ll = 999999999999LL;
  auto f = 3.14f;
  auto d = 3.14;
  printf("%d %u %ld %lld %g %g\n", i, u, l, ll, (double)f, d);

  // Multi-decl with different types
  auto x = 1, y = 2.5;
  printf("%d %g\n", x, y);

  // String literal decays to char*
  auto s = "hello";
  printf("%s\n", s);

  // Array decays to pointer
  int arr[5] = {10, 20, 30, 40, 50};
  auto p = arr;
  printf("%d %d\n", p[0], p[4]);

  // Function decays to function pointer
  auto fn = identity;
  printf("%d\n", fn(99));

  // const stripped (top-level)
  const int cx = 5;
  auto mx = cx;
  mx = mx + 1;
  printf("%d\n", mx);

  // Inferred from expression
  auto sum = 1 + 2.5;  // double
  printf("%g\n", sum);

  // Inferred from function call
  auto rv = identity(123);
  printf("%d\n", rv);

  // const auto (qualifier, not storage class — allowed)
  const auto cv = 7;
  printf("%d\n", cv);

  return 0;
}
