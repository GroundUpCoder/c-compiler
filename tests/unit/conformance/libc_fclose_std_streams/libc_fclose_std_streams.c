// BUG: fclose(stdout) traps at exit (the exit path re-flushes the already-closed stream), so the program exits 1 instead of 0.
// C11: 7.21.5.1 — fclose flushes and closes the stream and returns zero on success; closing stdout is well-defined.
// EXPECT: "before\n" on stdout and exit code 0 (verified against native clang).
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  printf("before\n");
  int r = fclose(stdout);
  fprintf(stderr, "fclose(stdout)=%d\n", r);
  exit(0);
}
