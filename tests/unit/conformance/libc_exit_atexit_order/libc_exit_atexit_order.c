// BUG: output written by an atexit handler is lost — streams are flushed/closed before the handlers run.
// C11: 7.22.4.4p3 — exit() first calls atexit-registered functions, THEN flushes and closes open streams.
// EXPECT: "main done\n" followed by "from-atexit-no-newline" with NO trailing newline (verified against native clang).
#include <stdio.h>
#include <stdlib.h>

static void h(void) { printf("from-atexit-no-newline"); }

int main(void) {
  atexit(h);
  printf("main done\n");
  return 0;
}
