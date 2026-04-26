#include <stdio.h>

int main() {
  /* fprintf to stdout */
  fprintf(stdout, "hello %s %d\n", "world", 42);

  /* fprintf to stderr */
  fprintf(stderr, "error: %s\n", "something went wrong");
  fprintf(stderr, "code=%d\n", 99);

  /* fputs and fputc to stderr */
  fputs("warn: check this\n", stderr);
  fputc('!', stderr);
  fputc('\n', stderr);

  /* printf still goes to stdout */
  printf("done\n");
  return 0;
}
