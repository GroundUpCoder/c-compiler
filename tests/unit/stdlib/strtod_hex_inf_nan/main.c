/* Regression: strtod missed C99 forms — hex floats ("0x10"), "inf",
 * "infinity", "nan" all parsed as 0 with nothing consumed. The same
 * engine backs scanf %f/%lf. */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

int main(void) {
  char *e;
  const char *s1 = "0x10";
  printf("%g %d\n", strtod(s1, &e), (int)(e - s1));
  const char *s2 = "0x1.8p1zz";
  printf("%g %d\n", strtod(s2, &e), (int)(e - s2));
  const char *s3 = "inf";
  printf("%d %d\n", isinf(strtod(s3, &e)) ? 1 : 0, (int)(e - s3));
  const char *s4 = "-Infinity!";
  double v4 = strtod(s4, &e);
  printf("%d %d %d\n", isinf(v4) ? 1 : 0, v4 < 0 ? 1 : 0, (int)(e - s4));
  const char *s5 = "nan";
  printf("%d %d\n", isnan(strtod(s5, &e)) ? 1 : 0, (int)(e - s5));
  double sc = 0;
  printf("%d", sscanf("inf", "%lf", &sc));
  printf(" %d\n", isinf(sc) ? 1 : 0);
  return 0;
}
