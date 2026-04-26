#include <stdio.h>

#define STR(x) #x
#define SHOW(expr) printf("%s = %d\n", #expr, expr)

int main() {
  printf("%s\n", STR(hello world));
  printf("%s\n", STR(1 + 2));
  printf("%s\n", STR("quoted"));
  SHOW(2 + 3);
  SHOW(10 * 20);
  return 0;
}
