#include <time.h>
#include <stdio.h>

/* Pins 64-bit time_t: a 32-bit time_t overflows at 2038-01-19 (2^31-1 secs).
   These timestamps are deliberately past that, so a regression to 32-bit would
   garble the year via truncation/sign-overflow. mktime round-trips go through
   localtime() (same TZ offset both directions) so they're timezone-independent;
   gmtime is pure UTC so its fields are asserted exactly. */
int main(void) {
  printf("sizeof_time_t: %d\n", (int)sizeof(time_t));

  /* 2100-01-01 00:00:00 UTC = 4102444800, which is > INT32_MAX (2147483647). */
  time_t y2100 = 4102444800LL;
  struct tm *gm = gmtime(&y2100);
  printf("y2100_year: %d\n", gm->tm_year + 1900);
  printf("y2100_mon: %d\n", gm->tm_mon + 1);
  printf("y2100_mday: %d\n", gm->tm_mday);
  printf("y2100_wday: %d\n", gm->tm_wday); /* Friday = 5 */

  /* 2200-01-01 00:00:00 UTC = 7258118400, > UINT32_MAX (4294967295) too. */
  time_t y2200 = 7258118400LL;
  struct tm *gm2 = gmtime(&y2200);
  printf("y2200_year: %d\n", gm2->tm_year + 1900);

  /* localtime -> mktime identity at a post-2038 instant (TZ-independent). */
  time_t known = 4102444800LL;
  struct tm *lt = localtime(&known);
  struct tm saved = *lt;
  time_t rt = mktime(&saved);
  printf("roundtrip_2100: %d\n", rt == known);

  /* Same for the >2^32 value. */
  time_t known2 = 7258118400LL;
  struct tm *lt2 = localtime(&known2);
  struct tm saved2 = *lt2;
  time_t rt2 = mktime(&saved2);
  printf("roundtrip_2200: %d\n", rt2 == known2);

  return 0;
}
