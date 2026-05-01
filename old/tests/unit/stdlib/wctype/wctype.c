#include <stdio.h>
#include <wctype.h>

int main() {
  /* iswupper */
  printf("iswupper A=%d\n", iswupper('A') != 0);
  printf("iswupper Z=%d\n", iswupper('Z') != 0);
  printf("iswupper a=%d\n", iswupper('a') != 0);
  printf("iswupper 5=%d\n", iswupper('5') != 0);

  /* iswlower */
  printf("iswlower a=%d\n", iswlower('a') != 0);
  printf("iswlower z=%d\n", iswlower('z') != 0);
  printf("iswlower A=%d\n", iswlower('A') != 0);

  /* iswalpha */
  printf("iswalpha Q=%d\n", iswalpha('Q') != 0);
  printf("iswalpha q=%d\n", iswalpha('q') != 0);
  printf("iswalpha 3=%d\n", iswalpha('3') != 0);

  /* iswdigit */
  printf("iswdigit 0=%d\n", iswdigit('0') != 0);
  printf("iswdigit 9=%d\n", iswdigit('9') != 0);
  printf("iswdigit a=%d\n", iswdigit('a') != 0);

  /* iswalnum */
  printf("iswalnum a=%d\n", iswalnum('a') != 0);
  printf("iswalnum 5=%d\n", iswalnum('5') != 0);
  printf("iswalnum !=%d\n", iswalnum('!') != 0);

  /* iswspace */
  printf("iswspace sp=%d\n", iswspace(' ') != 0);
  printf("iswspace tab=%d\n", iswspace('\t') != 0);
  printf("iswspace nl=%d\n", iswspace('\n') != 0);
  printf("iswspace a=%d\n", iswspace('a') != 0);

  /* iswblank */
  printf("iswblank sp=%d\n", iswblank(' ') != 0);
  printf("iswblank tab=%d\n", iswblank('\t') != 0);
  printf("iswblank nl=%d\n", iswblank('\n') != 0);

  /* iswpunct */
  printf("iswpunct !=%d\n", iswpunct('!') != 0);
  printf("iswpunct .=%d\n", iswpunct('.') != 0);
  printf("iswpunct a=%d\n", iswpunct('a') != 0);

  /* iswcntrl */
  printf("iswcntrl 0=%d\n", iswcntrl(0) != 0);
  printf("iswcntrl 31=%d\n", iswcntrl(31) != 0);
  printf("iswcntrl 127=%d\n", iswcntrl(127) != 0);
  printf("iswcntrl 32=%d\n", iswcntrl(32) != 0);

  /* iswprint / iswgraph */
  printf("iswprint sp=%d\n", iswprint(' ') != 0);
  printf("iswprint a=%d\n", iswprint('a') != 0);
  printf("iswprint 0=%d\n", iswprint(0) != 0);
  printf("iswgraph sp=%d\n", iswgraph(' ') != 0);
  printf("iswgraph a=%d\n", iswgraph('a') != 0);

  /* iswxdigit */
  printf("iswxdigit a=%d\n", iswxdigit('a') != 0);
  printf("iswxdigit F=%d\n", iswxdigit('F') != 0);
  printf("iswxdigit g=%d\n", iswxdigit('g') != 0);
  printf("iswxdigit 9=%d\n", iswxdigit('9') != 0);

  /* towlower / towupper */
  printf("towlower A=%c\n", (char)towlower('A'));
  printf("towlower a=%c\n", (char)towlower('a'));
  printf("towupper a=%c\n", (char)towupper('a'));
  printf("towupper A=%c\n", (char)towupper('A'));

  /* WEOF */
  printf("WEOF=%u\n", (unsigned)WEOF);

  return 0;
}
