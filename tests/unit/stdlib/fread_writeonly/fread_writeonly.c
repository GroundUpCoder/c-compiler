#include <stdio.h>

int main() {
  char buf[16];
  fread(buf, 1, 1, stdout);  /* should crash: stream is not readable */
  return 0;
}
