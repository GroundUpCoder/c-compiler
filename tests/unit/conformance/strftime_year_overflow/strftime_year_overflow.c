// BUG: strftime computed tm_year + 1900 in int, so a near-INT_MAX tm_year
//      wrapped: %Y printed -2147481749 instead of +2147485547, %011Y lost
//      its zero-padding to the sign flip, and %s (which feeds the same year
//      into the fields->seconds arithmetic) came out negative. The C
//      standard specifies no range for tm_year, so INT_MAX is a valid value
//      (ticket #113 / todos/0307, class 1).
// C11: 7.27.3.5 (strftime); the tm_year range note is musl libc-test's
//      (vendor/libc-test/src/functional/strftime.c, the INT_MAX block).
// EXPECT: musl semantics per that test — NOT host-clang-verified: BSD libc
//         prints no '+' for wide %Y and has no width modifiers, so the host
//         libc is not the oracle for libc-owned formatting. Expected
//         strings are the libc-test's own assertions: %Y "+2147485547"
//         (year 2147483647+1900, '+' once past 4 digits), %011Y
//         "02147485547" (explicit width suppresses the '+'), %s
//         "67768036160140800" (fields read as UTC, gmtoff 0), %y "47".
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

int main(void) {
  struct tm tm;
  memset(&tm, 0, sizeof tm);
  tm.tm_mday = 1;
  tm.tm_wday = 3;
  tm.tm_year = INT_MAX;

  char buf[64];
  strftime(buf, sizeof buf, "%Y", &tm);
  printf("%s\n", buf);
  strftime(buf, sizeof buf, "%011Y", &tm);
  printf("%s\n", buf);
  strftime(buf, sizeof buf, "%s", &tm);
  printf("%s\n", buf);
  strftime(buf, sizeof buf, "%y", &tm);
  printf("%s\n", buf);
  return 0;
}
