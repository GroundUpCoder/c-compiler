#include <stdio.h>
#include <wchar.h>

int main() {
  /* wcslen */
  wchar_t hello[] = { 'H', 'e', 'l', 'l', 'o', 0 };
  wchar_t empty[] = { 0 };
  printf("wcslen hello=%lu\n", (unsigned long)wcslen(hello));
  printf("wcslen empty=%lu\n", (unsigned long)wcslen(empty));

  /* wcscmp / wcsncmp */
  wchar_t abc[] = { 'a', 'b', 'c', 0 };
  wchar_t abd[] = { 'a', 'b', 'd', 0 };
  wchar_t ab[] = { 'a', 'b', 0 };
  printf("wcscmp eq=%d\n", wcscmp(abc, abc));
  printf("wcscmp lt=%d\n", wcscmp(abc, abd) < 0 ? -1 : 1);
  printf("wcscmp gt=%d\n", wcscmp(abd, abc) > 0 ? 1 : -1);
  printf("wcsncmp 2=%d\n", wcsncmp(abc, abd, 2));
  printf("wcsncmp 3=%d\n", wcsncmp(abc, abd, 3) < 0 ? -1 : 1);

  /* wcscpy / wcsncpy */
  wchar_t buf[32];
  wcscpy(buf, hello);
  printf("wcscpy=%d\n", wcscmp(buf, hello) == 0);
  wchar_t buf2[8] = { 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X' };
  wcsncpy(buf2, ab, 5);
  printf("wcsncpy val=%d\n", buf2[0] == 'a' && buf2[1] == 'b' && buf2[2] == 0 && buf2[3] == 0 && buf2[4] == 0);

  /* wcscat / wcsncat */
  wchar_t cat[32] = { 'H', 'i', 0 };
  wchar_t there[] = { '!', '!', 0 };
  wcscat(cat, there);
  printf("wcscat len=%lu\n", (unsigned long)wcslen(cat));
  wchar_t ncat[32] = { 'A', 0 };
  wcsncat(ncat, hello, 3);
  printf("wcsncat=%d\n", ncat[0] == 'A' && ncat[1] == 'H' && ncat[2] == 'e' && ncat[3] == 'l' && ncat[4] == 0);

  /* wcschr / wcsrchr */
  printf("wcschr found=%d\n", wcschr(hello, 'l') == &hello[2]);
  printf("wcschr null=%d\n", wcschr(hello, 'x') == NULL);
  printf("wcschr nul=%d\n", wcschr(hello, 0) == &hello[5]);
  printf("wcsrchr=%d\n", wcsrchr(hello, 'l') == &hello[3]);

  /* wcsstr */
  wchar_t ll[] = { 'l', 'l', 0 };
  wchar_t zz[] = { 'z', 'z', 0 };
  printf("wcsstr found=%d\n", wcsstr(hello, ll) == &hello[2]);
  printf("wcsstr miss=%d\n", wcsstr(hello, zz) == NULL);
  printf("wcsstr empty=%d\n", wcsstr(hello, empty) == hello);

  /* wcsspn / wcscspn */
  wchar_t vowels[] = { 'H', 'e', 0 };
  printf("wcsspn=%lu\n", (unsigned long)wcsspn(hello, vowels));
  wchar_t stop[] = { 'l', 0 };
  printf("wcscspn=%lu\n", (unsigned long)wcscspn(hello, stop));

  /* wcspbrk */
  wchar_t lo[] = { 'l', 'o', 0 };
  printf("wcspbrk=%d\n", wcspbrk(hello, lo) == &hello[2]);

  /* wcstok */
  wchar_t tokstr[] = { 'a', ',', 'b', ',', ',', 'c', 0 };
  wchar_t delim[] = { ',', 0 };
  wchar_t *save;
  wchar_t *t1 = wcstok(tokstr, delim, &save);
  wchar_t *t2 = wcstok(NULL, delim, &save);
  wchar_t *t3 = wcstok(NULL, delim, &save);
  wchar_t *t4 = wcstok(NULL, delim, &save);
  printf("tok1=%d\n", t1 && t1[0] == 'a' && t1[1] == 0);
  printf("tok2=%d\n", t2 && t2[0] == 'b' && t2[1] == 0);
  printf("tok3=%d\n", t3 && t3[0] == 'c' && t3[1] == 0);
  printf("tok4=%d\n", t4 == NULL);

  /* wcscoll / wcsxfrm */
  printf("wcscoll=%d\n", wcscoll(abc, abd) < 0 ? -1 : 1);
  wchar_t xbuf[16];
  size_t xlen = wcsxfrm(xbuf, abc, 16);
  printf("wcsxfrm len=%lu cmp=%d\n", (unsigned long)xlen, wcscmp(xbuf, abc));

  /* wmemcpy / wmemmove / wmemset / wmemcmp / wmemchr */
  wchar_t m1[4] = { 1, 2, 3, 4 };
  wchar_t m2[4];
  wmemcpy(m2, m1, 4);
  printf("wmemcpy=%d\n", wmemcmp(m1, m2, 4) == 0);
  wmemmove(m1 + 1, m1, 3);
  printf("wmemmove=%d\n", m1[0] == 1 && m1[1] == 1 && m1[2] == 2 && m1[3] == 3);
  wmemset(m2, 42, 4);
  printf("wmemset=%d\n", m2[0] == 42 && m2[3] == 42);
  printf("wmemchr=%d\n", wmemchr(m2, 42, 4) == m2);
  printf("wmemchr miss=%d\n", wmemchr(m2, 99, 4) == NULL);

  /* btowc / wctob */
  printf("btowc A=%d\n", (int)btowc('A'));
  printf("btowc EOF=%d\n", (int)btowc(-1));
  printf("wctob 65=%d\n", wctob(65));
  printf("wctob big=%d\n", wctob(0x1000));

  /* mbsinit */
  mbstate_t ps = {0};
  printf("mbsinit=%d\n", mbsinit(&ps));

  return 0;
}
