/*
 * jq_gucos_shims.c — libc gap-fillers for the gucOS wasm build of jq.
 *
 * The repo's ISO C libc (compiler.js) provides gmtime/localtime/localtime_r/
 * mktime/strftime, but not timegm(), gmtime_r() or strptime(). jq's date
 * builtins (strptime, mktime, gmtime, date arithmetic) need all three, so we
 * supply portable, self-contained implementations here and advertise them to
 * jq via -DHAVE_TIMEGM/-DHAVE_GMTIME_R/-DHAVE_STRPTIME in bin.json.
 *
 * These are provided ONLY when the corresponding libc symbol is absent; if a
 * future compiler.js grows them, drop the define(s) and this TU can shrink.
 */
#include <time.h>
#include <string.h>
#include <ctype.h>

/* days_from_civil: days since 1970-01-01 for a proleptic-Gregorian y/m/d.
   (Howard Hinnant's algorithm; valid for the full time_t range.) */
static long __days_from_civil(long y, unsigned m, unsigned d) {
  y -= m <= 2;
  long era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097L + (long)doe - 719468L;
}

time_t timegm(struct tm *tm) {
  long days = __days_from_civil(tm->tm_year + 1900L,
                                (unsigned)(tm->tm_mon + 1),
                                (unsigned)tm->tm_mday);
  long long secs = (long long)days * 86400LL
                 + (long long)tm->tm_hour * 3600LL
                 + (long long)tm->tm_min * 60LL
                 + (long long)tm->tm_sec;
  return (time_t)secs;
}

struct tm *gmtime_r(const time_t *timep, struct tm *result) {
  struct tm *g = gmtime(timep);   /* libc gmtime is pure UTC, no TZ state */
  if (!g) return 0;
  *result = *g;
  return result;
}

/* --- strptime ------------------------------------------------------------
 * Supports the specifiers jq and typical users need: %Y %y %C %m %d %e %H %I
 * %M %S %j %p %A %a %B %b %h %z %Z %n %t %% and the compound %F %T %D %R.
 * Unknown specifiers cause a NULL return (parse failure), matching the "does
 * not match format" contract jq relies on. Names are matched case-insensitively
 * against the C (POSIX) locale. */

static const char *const __mon_full[12] = {
  "january","february","march","april","may","june",
  "july","august","september","october","november","december" };
static const char *const __mon_abbr[12] = {
  "jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec" };
static const char *const __day_full[7] = {
  "sunday","monday","tuesday","wednesday","thursday","friday","saturday" };
static const char *const __day_abbr[7] = {
  "sun","mon","tue","wed","thu","fri","sat" };

static int __ci_prefix(const char *s, const char *word) {
  /* returns match length if `word` is a case-insensitive prefix of s, else 0 */
  int i = 0;
  while (word[i]) {
    if (tolower((unsigned char)s[i]) != word[i]) return 0;
    i++;
  }
  return i;
}

static const char *__match_name(const char *s, const char *const *tab, int n, int *idx) {
  /* try full-length entries first would be ideal; tables here are unambiguous */
  for (int i = 0; i < n; i++) {
    int k = __ci_prefix(s, tab[i]);
    if (k) { *idx = i; return s + k; }
  }
  return 0;
}

static const char *__get_int(const char *s, int maxdigits, int *out) {
  int val = 0, n = 0, neg = 0;
  while (isspace((unsigned char)*s)) s++;
  if (*s == '+' || *s == '-') { neg = (*s == '-'); s++; }
  while (n < maxdigits && isdigit((unsigned char)*s)) {
    val = val * 10 + (*s - '0');
    s++; n++;
  }
  if (n == 0) return 0;
  *out = neg ? -val : val;
  return s;
}

char *strptime(const char *s, const char *format, struct tm *tm) {
  const char *f = format;
  int v, idx;

  while (*f) {
    if (*f == '%') {
      f++;
      if (*f == 'E' || *f == 'O') f++;   /* ignore locale modifiers */
      switch (*f) {
        case '%':
          if (*s != '%') return 0;
          s++;
          break;
        case 'n': case 't':
          while (isspace((unsigned char)*s)) s++;
          break;
        case 'Y':
          if (!(s = __get_int(s, 6, &v))) return 0;
          tm->tm_year = v - 1900;
          break;
        case 'y':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_year = (v < 69 ? v + 100 : v);
          break;
        case 'C':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_year = v * 100 - 1900;
          break;
        case 'm':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_mon = v - 1;
          break;
        case 'd': case 'e':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_mday = v;
          break;
        case 'H':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_hour = v;
          break;
        case 'I':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_hour = v % 12;
          break;
        case 'M':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_min = v;
          break;
        case 'S':
          if (!(s = __get_int(s, 2, &v))) return 0;
          tm->tm_sec = v;
          break;
        case 'j':
          if (!(s = __get_int(s, 3, &v))) return 0;
          tm->tm_yday = v - 1;
          break;
        case 'p':
          if (__ci_prefix(s, "pm")) { if (tm->tm_hour < 12) tm->tm_hour += 12; s += 2; }
          else if (__ci_prefix(s, "am")) { if (tm->tm_hour == 12) tm->tm_hour = 0; s += 2; }
          else return 0;
          break;
        case 'A': case 'a':
          if (!(s = __match_name(s, __day_full, 7, &idx)))
            if (!(s = __match_name(s, __day_abbr, 7, &idx))) return 0;
          tm->tm_wday = idx;
          break;
        case 'B': case 'b': case 'h':
          if (!(s = __match_name(s, __mon_full, 12, &idx)))
            if (!(s = __match_name(s, __mon_abbr, 12, &idx))) return 0;
          tm->tm_mon = idx;
          break;
        case 'z': {
          if (*s == 'Z') { tm->tm_gmtoff = 0; s++; break; }
          if (*s == '+' || *s == '-') {
            int sign = (*s == '-') ? -1 : 1; s++;
            int hh = 0, mm = 0, n = 0;
            while (n < 2 && isdigit((unsigned char)*s)) { hh = hh*10 + (*s++ - '0'); n++; }
            if (*s == ':') s++;
            n = 0;
            while (n < 2 && isdigit((unsigned char)*s)) { mm = mm*10 + (*s++ - '0'); n++; }
            tm->tm_gmtoff = sign * (hh * 3600 + mm * 60);
          }
          break;
        }
        case 'Z':
          while (isalpha((unsigned char)*s)) s++;   /* consume, don't interpret */
          break;
        case 'F':   /* %Y-%m-%d */
          if (!(s = strptime(s, "%Y-%m-%d", tm))) return 0;
          break;
        case 'T': case 'X':   /* %H:%M:%S */
          if (!(s = strptime(s, "%H:%M:%S", tm))) return 0;
          break;
        case 'R':   /* %H:%M */
          if (!(s = strptime(s, "%H:%M", tm))) return 0;
          break;
        case 'D': case 'x':   /* %m/%d/%y */
          if (!(s = strptime(s, "%m/%d/%y", tm))) return 0;
          break;
        default:
          return 0;   /* unsupported specifier */
      }
      f++;
    } else if (isspace((unsigned char)*f)) {
      while (isspace((unsigned char)*s)) s++;
      f++;
    } else {
      if (*s != *f) return 0;
      s++; f++;
    }
  }
  return (char *)s;
}
