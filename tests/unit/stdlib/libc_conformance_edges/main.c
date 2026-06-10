/* Fast-suite regressions for conformance fixes driven by musl's
 * libc-test (the full suite runs as tests/run.py --types=libc). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>   /* must provide size_t per POSIX */

static size_t poke;   /* uses unistd.h's size_t */

int main(void) {
  /* strtol: invalid base => EINVAL, 0, endptr = nptr */
  errno = 0;
  char *e;
  long v = strtol("123", &e, 37);
  printf("base37: %ld %d %d\n", v, errno == EINVAL, e == (char *)0 ? -1 : (int)(e - "123"));

  /* scanf %i: consumed "0x" without digits is a matching failure */
  int x = -1, y = -1;
  int n = sscanf(" 0x12 0x34", "%5i%2i", &x, &y);
  printf("scanf-i: %d %d %d\n", n, x, y);

  /* scanf %f: dangling exponent ("10e") is a matching failure */
  double d = -1;
  printf("scanf-f: %d\n", sscanf("10e", "%lf", &d));

  /* strtod: exact hex-float rounding at the last ulp */
  printf("hex: %d\n", strtod("0x1.111111111111281p0", 0) == 0x1.1111111111113p+0);

  /* strtod: rounds up across the denormal floor (TRUE_MIN/2 + epsilon) */
  printf("denorm: %d\n", strtod("2.470328229206232720883e-324", 0) > 0.0);

  /* strtof: single rounding from decimal — this value is just under half
     of FLT_TRUE_MIN and must round to 0; rounding via double first gives
     a nonzero result (the classic double-rounding trap) */
  float f = strtof(".70064923216240853546186479164495806564013097093825788587e-45", 0);
  printf("strtof: %d\n", f == 0.0f);

  /* strlcpy / strlcat / memmem */
  char buf[8];
  size_t r1 = strlcpy(buf, "hello world", sizeof buf);
  printf("strlcpy: %u %s\n", (unsigned)r1, buf);
  buf[0] = 0;
  strlcpy(buf, "ab", sizeof buf);
  size_t r2 = strlcat(buf, "cdefghij", sizeof buf);
  printf("strlcat: %u %s\n", (unsigned)r2, buf);
  const char h[] = "xxneedlexx";
  printf("memmem: %d\n", (char *)memmem(h, sizeof h - 1, "needle", 6) == h + 2);

  /* tmpfile */
  FILE *tf = tmpfile();
  if (!tf) { puts("tmpfile: FAIL"); return 1; }
  fputs("zap", tf);
  rewind(tf);
  char tb[8] = {0};
  fread(tb, 1, 7, tf);
  fclose(tf);
  printf("tmpfile: %s\n", tb);

  /* ftell after fscanf on an update stream (vfscanf read-ahead flag) */
  tf = tmpfile();
  fwrite("      42", 1, 8, tf);
  rewind(tf);
  int fx = -1, fy = -1;
  fscanf(tf, " %n%*d%n", &fx, &fy);
  printf("vfscanf-ftell: %d %d %ld\n", fx, fy, ftell(tf));
  fclose(tf);

  /* strftime: %c space-padded day, %e, %C (+width), %Y beyond 9999 */
  struct tm tm = {0};
  tm.tm_year = 116; tm.tm_mon = 0; tm.tm_mday = 3;
  tm.tm_hour = 13; tm.tm_min = 23; tm.tm_sec = 45; tm.tm_wday = 0;
  char sb[64];
  strftime(sb, sizeof sb, "%c", &tm);
  printf("c: %s\n", sb);
  strftime(sb, sizeof sb, "%e|%C|%03C|%+3C", &tm);
  printf("e: %s\n", sb);
  tm.tm_year = 10009 - 1900;
  strftime(sb, sizeof sb, "%Y", &tm);
  printf("Y: %s\n", sb);

  (void)poke;
  return 0;
}
