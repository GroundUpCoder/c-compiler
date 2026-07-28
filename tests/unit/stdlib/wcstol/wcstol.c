// todos/0325 Group A — the wcstol family. BEHAVIOUR: parsed value, endptr
// position, and errno, which is where a lazy "narrow it and call strtol"
// implementation goes wrong. Host-independent, so clang-verifiable.
#include <stdio.h>
#include <wchar.h>
#include <errno.h>
#include <limits.h>

static void t(const wchar_t *s, int base) {
  wchar_t *end;
  errno = 0;
  long v = wcstol(s, &end, base);
  printf("wcstol(%ls,%d)=%ld consumed=%d erange=%d\n",
         s, base, v, (int)(end - s), errno == ERANGE);
}
static void tu(const wchar_t *s, int base) {
  wchar_t *end;
  errno = 0;
  unsigned long v = wcstoul(s, &end, base);
  printf("wcstoul(%ls,%d)=%lu consumed=%d erange=%d\n",
         s, base, v, (int)(end - s), errno == ERANGE);
}

/* Two lines below deliberately differ from clang-on-macOS; the rest are
   byte-identical to it:
     - the overflow/ULONG lines, because this target is ILP32 (32-bit long)
       and macOS is LP64 — saturation to 2147483647/4294967295 with ERANGE is
       the CORRECT answer here;
     - wcstol(L"0x", 16) consumes 1, not 0. C says the subject sequence is
       the LONGEST initial subsequence of the expected form, and with no hex
       digit after the prefix that is just "0". glibc agrees; the BSD/macOS
       libc consumes nothing. We follow the standard. */
int main(void) {
  t(L"123", 10);
  t(L"-123", 10);
  t(L"+42", 10);
  t(L"   \t 7", 10);          // leading whitespace is skipped
  t(L"0x1f", 16);
  t(L"0x1f", 0);              // base 0 sniffs the 0x prefix
  t(L"017", 0);               // base 0 sniffs octal
  t(L"17", 0);                // ...and plain decimal
  t(L"1010", 2);
  t(L"zz", 36);
  t(L"123abc", 10);           // stops at the first non-digit
  t(L"abc", 10);              // no conversion: endptr must be nptr
  t(L"", 10);
  t(L"  -", 10);              // sign with no digits is also no conversion
  t(L"0x", 16);               // "0x" with no digit: consumes just the "0"
  t(L"2147483647", 10);       // LONG_MAX on ILP32
  t(L"-2147483648", 10);      // LONG_MIN on ILP32
  t(L"999999999999", 10);     // overflow -> saturate + ERANGE
  t(L"-999999999999", 10);
  tu(L"4294967295", 10);      // ULONG_MAX on ILP32
  tu(L"-1", 10);              // C says strtoul NEGATES rather than rejecting
  tu(L"99999999999999", 10);

  // long long / unsigned long long entry points
  wchar_t *e;
  errno = 0;
  long long ll = wcstoll(L"-9223372036854775808", &e, 10);
  printf("wcstoll_min=%lld erange=%d\n", ll, errno == ERANGE);
  errno = 0;
  unsigned long long ull = wcstoull(L"18446744073709551615", &e, 10);
  printf("wcstoull_max=%llu erange=%d\n", ull, errno == ERANGE);

  // wcstod shares strtod's rounding rather than growing a second parser.
  // NB one named array, not two occurrences of the same literal: subtracting
  // pointers into distinct objects is undefined, and whether identical
  // literals get merged is a per-implementation choice (macOS merges, we do
  // not) — so the two-literal spelling reads as a libc difference when it is
  // really undefined behaviour in the test.
  const wchar_t *pi = L"3.14159265358979";
  printf("wcstod=%.17g\n", wcstod(pi, &e));
  printf("wcstod_consumed=%d\n", (int)(e - pi));

  // A non-ASCII character must STOP the scan, not be transliterated.
  const wchar_t *uni = L"12³4";        // "12" then U+00B3 then "4"
  errno = 0;
  long v = wcstol(uni, &e, 10);
  printf("stops_at_nonascii v=%ld consumed=%d\n", v, (int)(e - uni));
  return 0;
}
