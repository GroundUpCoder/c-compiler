#include <stdio.h>
#include <string.h>
#include <time.h>

int main() {
  char buf[128];
  struct tm t;

  // Wednesday, 2025-01-15 14:30:45 (day 14 of year, 0-indexed)
  t.tm_year = 125;
  t.tm_mon = 0;
  t.tm_mday = 15;
  t.tm_hour = 14;
  t.tm_min = 30;
  t.tm_sec = 45;
  t.tm_wday = 3;
  t.tm_yday = 14;
  t.tm_isdst = 0;

  // %y — 2-digit year
  strftime(buf, sizeof(buf), "%y", &t);
  printf("%%y: %s\n", buf);

  // %I — 12-hour clock (14:00 -> 02)
  strftime(buf, sizeof(buf), "%I", &t);
  printf("%%I afternoon: %s\n", buf);

  // %I — midnight (hour 0 -> 12)
  t.tm_hour = 0;
  strftime(buf, sizeof(buf), "%I %p", &t);
  printf("%%I midnight: %s\n", buf);

  // %I — noon (hour 12 -> 12)
  t.tm_hour = 12;
  strftime(buf, sizeof(buf), "%I %p", &t);
  printf("%%I noon: %s\n", buf);

  // %I — 1 AM
  t.tm_hour = 1;
  strftime(buf, sizeof(buf), "%I %p", &t);
  printf("%%I 1am: %s\n", buf);

  t.tm_hour = 14; // restore

  // %U — week number (Sunday start)
  // Jan 15, wday=3(Wed), yday=14 => (14 + 7 - 3) / 7 = 18/7 = 2
  strftime(buf, sizeof(buf), "%U", &t);
  printf("%%U: %s\n", buf);

  // %W — week number (Monday start)
  // wday=3(Wed), Mon-based day = 3-1 = 2 => (14 + 7 - 2) / 7 = 19/7 = 2
  strftime(buf, sizeof(buf), "%W", &t);
  printf("%%W: %s\n", buf);

  // %U/%W on Jan 1 that is a Sunday (wday=0, yday=0)
  // %U: (0 + 7 - 0) / 7 = 1
  // %W: Mon-based day = 6 => (0 + 7 - 6) / 7 = 0
  t.tm_mday = 1;
  t.tm_yday = 0;
  t.tm_wday = 0;
  strftime(buf, sizeof(buf), "%U", &t);
  printf("%%U Jan1-Sun: %s\n", buf);
  strftime(buf, sizeof(buf), "%W", &t);
  printf("%%W Jan1-Sun: %s\n", buf);

  // %U/%W on Jan 1 that is a Monday (wday=1, yday=0)
  // %U: (0 + 7 - 1) / 7 = 0
  // %W: Mon-based day = 0 => (0 + 7 - 0) / 7 = 1
  t.tm_wday = 1;
  strftime(buf, sizeof(buf), "%U", &t);
  printf("%%U Jan1-Mon: %s\n", buf);
  strftime(buf, sizeof(buf), "%W", &t);
  printf("%%W Jan1-Mon: %s\n", buf);

  // Restore for locale tests
  t.tm_mday = 15;
  t.tm_yday = 14;
  t.tm_wday = 3;

  // %x — locale date (C locale: MM/DD/YY)
  strftime(buf, sizeof(buf), "%x", &t);
  printf("%%x: %s\n", buf);

  // %X — locale time (C locale: HH:MM:SS)
  strftime(buf, sizeof(buf), "%X", &t);
  printf("%%X: %s\n", buf);

  // %Z — timezone name (empty in wasm)
  strftime(buf, sizeof(buf), "[%Z]", &t);
  printf("%%Z: %s\n", buf);

  // Combined format using new specifiers
  strftime(buf, sizeof(buf), "%x %X", &t);
  printf("combined: %s\n", buf);

  // Year 2000: %y should be 00
  t.tm_year = 100;
  strftime(buf, sizeof(buf), "%y", &t);
  printf("%%y 2000: %s\n", buf);

  // Year 1999: %y should be 99
  t.tm_year = 99;
  strftime(buf, sizeof(buf), "%y", &t);
  printf("%%y 1999: %s\n", buf);

  return 0;
}
