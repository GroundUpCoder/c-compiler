// BUG: fclose() on a stream given a caller-supplied buffer via setvbuf traps (the close path frees the user buffer).
// C11: 7.21.5.6 — setvbuf "may" use the array supplied by the caller as the buffer; 7.21.5.1 — fclose must still flush, close, and return zero.
// EXPECT: "ok 0\n" and exit code 0 (verified against native clang).
#include <stdio.h>

#ifndef TEST_TMPDIR
#define TEST_TMPDIR "/tmp/"
#endif

static char mybuf[1024];

int main(void) {
  FILE *f = fopen(TEST_TMPDIR "conf_fclose_setvbuf.txt", "w");
  if (!f) { printf("open fail\n"); return 1; }
  setvbuf(f, mybuf, _IOFBF, sizeof mybuf);
  fputs("data\n", f);
  int r = fclose(f);
  printf("ok %d\n", r);
  return 0;
}
