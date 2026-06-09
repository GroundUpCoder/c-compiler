/* C23 __VA_OPT__(content): expands content iff variadic args are
 * present. Previously rejected with a parse error. */
#include <stdio.h>

#define LOG(fmt, ...) printf(fmt __VA_OPT__(,) __VA_ARGS__)
#define SUM(a, ...) (a __VA_OPT__(+ FIRST(__VA_ARGS__)))
#define FIRST(a, ...) (a)
#define CALL(f, ...) f(0 __VA_OPT__(, __VA_ARGS__))

int f1(int a) { return a + 1; }
int f3(int a, int b, int c) { return a + b + c; }

int main(void) {
  LOG("plain\n");
  LOG("%d\n", 5);
  LOG("%d %d\n", 1, 2);
  printf("%d %d\n", SUM(1), SUM(1, 2));
  printf("%d %d\n", CALL(f1), CALL(f3, 4, 5));
  return 0;
}
