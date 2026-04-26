// Test that unused declarations are filtered out before linking.
// Without filtering, the undefined symbols here would cause linker errors.
#include <stdio.h>

int unused_function(int x);     // declared, never defined, never used
extern int unused_var;          // declared, never defined, never used

// A static function that's never called should also be filtered
static int unused_static(void);

// A used declaration that IS defined — should survive filtering
int used_function(int x);
int used_function(int x) { return x * 2; }

// A static function that IS used — should survive filtering
static int used_static(int x) { return x + 10; }

int main(void) {
  int a = used_function(5);
  int b = used_static(3);
  printf("%d %d\n", a, b);
  return 0;
}
