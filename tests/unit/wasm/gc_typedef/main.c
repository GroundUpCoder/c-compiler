#include <stdio.h>

__struct Foo { int x; int y; };

typedef __struct Foo FooRef;
typedef __array(int) IntArr;
typedef __array(__struct Foo) FooArr;

FooRef make(int a, int b) { return __new(__struct Foo, a, b); }

int sum_arr(IntArr a) {
  int s = 0;
  for (int i = 0; i < __array_len(a); i++) s += a[i];
  return s;
}

// Function pointer with GC ref param
int square(int x) { return x * x; }

int main(void) {
  FooRef f = make(11, 22);
  printf("%d %d\n", f.x, f.y);

  IntArr a = __new_array(int, 7, 8, 9);
  printf("sum: %d\n", sum_arr(a));

  FooArr fa = __new_array(FooRef, make(1, 2), make(3, 4));
  for (int i = 0; i < __array_len(fa); i++) printf("(%d,%d)\n", fa[i].x, fa[i].y);

  // Function pointer
  int (*fn)(int) = square;
  printf("%d\n", fn(7));

  return 0;
}
