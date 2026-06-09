/* Regression: GNU ", ##__VA_ARGS__" comma paste — every expansion of
 * such a macro produced garbage tokens (parse error at the use site),
 * even when variadic arguments were present. */
#include <stdio.h>

#define LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)

int f1(int a) { return a; }
int f2(int a, int b) { return a + b; }
#define WRAP1(x, ...) f1(x, ##__VA_ARGS__)
#define WRAP2(x, ...) f2(x, ##__VA_ARGS__)

int main(void) {
  LOG("no args\n");
  LOG("%d\n", 42);
  LOG("%d %d\n", 1, 2);
  printf("%d %d\n", WRAP1(7), WRAP2(3, 4));
  return 0;
}
