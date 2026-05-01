#include <stdio.h>
#include <string.h>

int main() {
  /* memchr */
  char buf[] = "hello";
  printf("memchr found: %c\n", *(char *)memchr(buf, 'l', 5));
  printf("memchr null: %d\n", memchr(buf, 'z', 5) == 0);

  /* strncat */
  char dst[20] = "hello";
  strncat(dst, " world!!!", 6);
  printf("strncat: %s\n", dst);

  /* strspn */
  printf("strspn: %lu\n", (unsigned long)strspn("123abc", "0123456789"));
  printf("strspn none: %lu\n", (unsigned long)strspn("abc", "0123456789"));

  /* strcspn */
  printf("strcspn: %lu\n", (unsigned long)strcspn("hello, world", ", "));
  printf("strcspn all: %lu\n", (unsigned long)strcspn("hello", ", "));

  /* strpbrk */
  char *p = strpbrk("hello, world", ", ");
  printf("strpbrk: %c\n", *p);
  printf("strpbrk null: %d\n", strpbrk("hello", "xyz") == 0);

  /* strtok */
  char tok_buf[] = "one,two,,three";
  char *tok = strtok(tok_buf, ",");
  while (tok) {
    printf("tok: %s\n", tok);
    tok = strtok(0, ",");
  }

  /* strcoll (same as strcmp in C locale) */
  printf("strcoll eq: %d\n", strcoll("abc", "abc"));
  printf("strcoll lt: %d\n", strcoll("abc", "abd") < 0);
  printf("strcoll gt: %d\n", strcoll("abd", "abc") > 0);

  /* strxfrm */
  char xbuf[10];
  size_t len = strxfrm(xbuf, "hello", 10);
  printf("strxfrm: %s len=%lu\n", xbuf, (unsigned long)len);
  size_t len2 = strxfrm(xbuf, "hello world", 4);
  printf("strxfrm trunc: %s len=%lu\n", xbuf, (unsigned long)len2);

  /* strerror */
  printf("strerror: %s\n", strerror(0));

  printf("ALL TESTS PASSED\n");
  return 0;
}
