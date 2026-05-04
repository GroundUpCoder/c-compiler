#include <stdio.h>

void test_default(void) {
  printf("=== default ===\n");
  __array(int) a = __new(__array(int), 5);
  for (int i = 0; i < 5; i++) printf("%d\n", a[i]);  // all 0
  for (int i = 0; i < 5; i++) a[i] = i * 10;
  for (int i = 0; i < 5; i++) printf("%d\n", a[i]);
}

void test_init(void) {
  printf("=== init ===\n");
  __array(int) b = __new(__array(int), 3, 42);
  for (int i = 0; i < 3; i++) printf("%d\n", b[i]);  // 42 42 42
}

void test_other_types(void) {
  printf("=== types ===\n");
  __array(double) d = __new(__array(double), 3, 1.5);
  for (int i = 0; i < 3; i++) printf("%g\n", d[i]);
  d[1] = 2.75;
  printf("%g\n", d[1]);

  __array(long long) l = __new(__array(long long), 2);
  l[0] = 1234567890123LL;
  l[1] = -987LL;
  printf("%lld %lld\n", l[0], l[1]);
}

int main(void) {
  test_default();
  test_init();
  test_other_types();
  return 0;
}
