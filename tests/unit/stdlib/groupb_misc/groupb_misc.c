// todos/0325 Group B — memrchr, explicit_bzero, strsignal, getentropy,
// confstr/pathconf/fpathconf, timegm, clock_nanosleep, wcsftime.
// BEHAVIOUR throughout.
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <wchar.h>
#include <errno.h>
#include <signal.h>
#include <limits.h>

int main(void) {
  // ---- memrchr: the LAST occurrence, unlike memchr ----
  const char *h = "abcabcabc";
  printf("memrchr=%d memchr=%d\n",
         (int)((const char *)memrchr(h, 'b', 9) - h),
         (int)((const char *)memchr(h, 'b', 9) - h));
  printf("memrchr_missing=%d\n", memrchr(h, 'z', 9) == 0);
  printf("memrchr_len0=%d\n", memrchr(h, 'a', 0) == 0);
  // n bounds the search: 'c' at index 2 is outside the first 2 bytes
  printf("memrchr_bounded=%d\n", memrchr(h, 'c', 2) == 0);
  // must match on an embedded NUL too. One named array, not two spellings of
  // the same literal: subtracting pointers into distinct objects is
  // undefined, and identical-literal merging is a per-implementation choice.
  static const char emb[3] = { 'a', 0, 'b' };
  printf("memrchr_nul=%d\n", (int)((const char *)memrchr(emb, 0, 3) - emb) == 1);

  // ---- explicit_bzero: really zeroes ----
  char secret[16];
  memcpy(secret, "hunter2hunter2!", 16);
  explicit_bzero(secret, sizeof secret);
  int nonzero = 0;
  for (unsigned i = 0; i < sizeof secret; i++) if (secret[i]) nonzero++;
  printf("explicit_bzero_nonzero=%d\n", nonzero);
  // zero length must be a no-op, not a wild write
  char keep[4] = {1, 2, 3, 4};
  explicit_bzero(keep, 0);
  printf("bzero_len0_keeps=%d\n", keep[0] == 1 && keep[3] == 4);

  // ---- strsignal ----
  printf("sigint=[%s]\n", strsignal(SIGINT));
  printf("sigsegv=[%s]\n", strsignal(SIGSEGV));
  printf("sigkill=[%s]\n", strsignal(SIGKILL));
  printf("unknown=[%s]\n", strsignal(4242));
  printf("strsignal_never_null=%d\n", strsignal(-1) != 0);

  // ---- getentropy: real bytes, and the documented limits ----
  unsigned char a[32], b[32];
  int ra = getentropy(a, sizeof a);
  int rb = getentropy(b, sizeof b);
  printf("getentropy rc=%d,%d differ=%d\n", ra, rb, memcmp(a, b, sizeof a) != 0);
  int allzero = 1;
  for (unsigned i = 0; i < sizeof a; i++) if (a[i]) { allzero = 0; break; }
  printf("getentropy_not_allzero=%d\n", !allzero);
  errno = 0;
  printf("getentropy_over256=%d eio=%d\n",
         getentropy(a, 257), errno == EIO);
  printf("getentropy_zero_len=%d\n", getentropy(a, 0));

  // ---- confstr / pathconf / fpathconf ----
  char cbuf[64];
  size_t need = confstr(_CS_PATH, cbuf, sizeof cbuf);
  printf("confstr len=%d path=[%s]\n", (int)need, cbuf);
  printf("confstr_size_query=%d\n", (int)confstr(_CS_PATH, 0, 0) == (int)need);
  errno = 0;
  printf("confstr_bad=%d einval=%d\n", (int)confstr(9999, cbuf, sizeof cbuf), errno == EINVAL);

  printf("pathconf_name=%ld path=%ld\n",
         pathconf("/", _PC_NAME_MAX), pathconf("/", _PC_PATH_MAX));
  errno = 0;
  printf("pathconf_missing=%ld\n", pathconf("/no/such/path", _PC_NAME_MAX));
  int fd = open("/gb", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  printf("fpathconf_name=%ld\n", fpathconf(fd, _PC_NAME_MAX));
  close(fd);
  errno = 0;
  printf("fpathconf_badfd=%ld\n", fpathconf(fd, _PC_NAME_MAX));

  // ---- timegm: mktime's UTC twin ----
  struct tm t;
  memset(&t, 0, sizeof t);
  t.tm_year = 100; t.tm_mon = 0; t.tm_mday = 1;   // 2000-01-01 00:00:00 UTC
  printf("timegm_y2k=%lld\n", (long long)timegm(&t));
  printf("timegm_normalised wday=%d yday=%d\n", t.tm_wday, t.tm_yday);

  memset(&t, 0, sizeof t);
  t.tm_year = 70; t.tm_mon = 0; t.tm_mday = 1;
  printf("timegm_epoch=%lld\n", (long long)timegm(&t));

  // out-of-range fields normalise (month 12 == January of the next year)
  memset(&t, 0, sizeof t);
  t.tm_year = 100; t.tm_mon = 12; t.tm_mday = 1;
  printf("timegm_normalise_month=%lld\n", (long long)timegm(&t));

  // timegm must round-trip gmtime_r exactly
  time_t orig = 1700000000;
  struct tm rt;
  gmtime_r(&orig, &rt);
  printf("timegm_roundtrip=%d\n", timegm(&rt) == orig);

  // ---- clock_nanosleep: returns an errno VALUE, does not set errno ----
  struct timespec ts;
  ts.tv_sec = 0; ts.tv_nsec = 1000000;      // 1ms
  printf("cns_rel=%d\n", clock_nanosleep(CLOCK_MONOTONIC, 0, &ts, 0));
  printf("cns_badclock=%d\n", clock_nanosleep(9999, 0, &ts, 0) == EINVAL);
  ts.tv_nsec = 2000000000L;
  printf("cns_badnsec=%d\n", clock_nanosleep(CLOCK_MONOTONIC, 0, &ts, 0) == EINVAL);
  // An absolute deadline already in the past returns immediately, not EINVAL.
  struct timespec past;
  clock_gettime(CLOCK_MONOTONIC, &past);
  past.tv_sec -= 10;
  printf("cns_abs_past=%d\n", clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &past, 0));
  // An absolute deadline in the near future really waits.
  struct timespec before, after, deadline;
  clock_gettime(CLOCK_MONOTONIC, &before);
  deadline = before;
  deadline.tv_nsec += 5000000L;             // +5ms
  if (deadline.tv_nsec >= 1000000000L) { deadline.tv_nsec -= 1000000000L; deadline.tv_sec++; }
  int cr = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, 0);
  clock_gettime(CLOCK_MONOTONIC, &after);
  long long elapsed_ns = (long long)(after.tv_sec - before.tv_sec) * 1000000000LL
                       + (after.tv_nsec - before.tv_nsec);
  printf("cns_abs_waited rc=%d atleast4ms=%d\n", cr, elapsed_ns >= 4000000LL);

  // ---- wcsftime ----
  time_t z = 0;
  struct tm ut;
  gmtime_r(&z, &ut);
  wchar_t wbuf[64];
  size_t wn = wcsftime(wbuf, 64, L"%Y-%m-%d %H:%M:%S", &ut);
  printf("wcsftime n=%d out=[%ls]\n", (int)wn, wbuf);
  // A too-small buffer returns 0 (C95), it does not overflow.
  printf("wcsftime_small=%d\n", (int)wcsftime(wbuf, 4, L"%Y-%m-%d", &ut));
  return 0;
}
