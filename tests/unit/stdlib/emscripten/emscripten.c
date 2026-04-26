#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>

static int called = 0;

void tick(void) {
  called++;
  printf("tick %d\n", called);
  if (called >= 3) exit(0);
}

int main(void) {
  emscripten_set_main_loop(tick, 0, 1);
  return 0;
}
