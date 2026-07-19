// Unicode Phase B: C.UTF-8 locale discovery. The libc's charset is
// unconditionally UTF-8 (the real mb/wc codec, MB_CUR_MAX 4), so
// setlocale accepts "C.UTF-8", "" selects it as the native locale, and
// nl_langinfo(CODESET) answers "UTF-8" — the probe busybox and ports key
// UTF-8-aware behavior off.
#include <stdio.h>
#include <locale.h>
#include <langinfo.h>

static void show(const char *tag, const char *s) {
  printf("%s: [%s]\n", tag, s ? s : "(null)");
}

int main(void) {
  show("query", setlocale(LC_ALL, NULL));
  show("C", setlocale(LC_ALL, "C"));
  show("C.UTF-8", setlocale(LC_ALL, "C.UTF-8"));
  show("requery", setlocale(LC_ALL, NULL));
  show("codeset", nl_langinfo(CODESET));
  show("default", setlocale(LC_CTYPE, ""));
  show("bogus", setlocale(LC_ALL, "de_DE"));
  show("radix", nl_langinfo(RADIXCHAR));
  show("day1", nl_langinfo(DAY_1));
  show("abmon12", nl_langinfo(ABMON_12));
  show("oob", nl_langinfo(999));
  return 0;
}
