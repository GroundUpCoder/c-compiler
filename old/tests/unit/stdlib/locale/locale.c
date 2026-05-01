#include <locale.h>
#include <stdio.h>

int main() {
  // setlocale: query current locale
  char *loc = setlocale(LC_ALL, 0);
  printf("default=%s\n", loc);

  // setlocale: set to "C"
  loc = setlocale(LC_ALL, "C");
  printf("set_C=%s\n", loc);

  // setlocale: set to ""  (should default to "C")
  loc = setlocale(LC_ALL, "");
  printf("set_empty=%s\n", loc);

  // setlocale: set to "POSIX"
  loc = setlocale(LC_CTYPE, "POSIX");
  printf("set_POSIX=%s\n", loc);

  // setlocale: unsupported locale returns NULL
  loc = setlocale(LC_ALL, "fr_FR");
  printf("set_fr=%d\n", loc == 0);

  // localeconv
  struct lconv *lc = localeconv();
  printf("decimal_point=%s\n", lc->decimal_point);
  printf("thousands_sep_empty=%d\n", lc->thousands_sep[0] == '\0');
  printf("int_frac_digits=%d\n", lc->int_frac_digits);

  return 0;
}
