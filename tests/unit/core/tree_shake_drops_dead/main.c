// Dead static function (never called or address-taken) gets dropped by
// tree-shake. The program must still compile and run correctly without
// the dead function ever being reached. If `dead` got compiled and its
// body referenced `secret_extern`, the link would fail.

#include <stdio.h>

extern int secret_extern_does_not_exist(int);

static int dead(int x) { return secret_extern_does_not_exist(x); }

int main(void) {
  printf("alive\n");
  return 0;
}
