// Tests global char array initialization from string literals.
// The local version was a bug that was fixed; test global too.
#include <stdio.h>

char greeting[] = "hello";
char buf[10] = "world";

int main() {
  printf("%s\n", greeting);  // hello
  printf("%s\n", buf);       // world

  // Verify they're mutable copies
  greeting[0] = 'H';
  printf("%s\n", greeting);  // Hello

  // Check sizes
  printf("%d\n", (int)sizeof(greeting));  // 6
  printf("%d\n", (int)sizeof(buf));       // 10

  return 0;
}
