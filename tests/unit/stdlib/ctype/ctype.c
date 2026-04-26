#include <ctype.h>
#include <stdio.h>

int main() {
  // isdigit
  printf("isdigit('5')=%d\n", !!isdigit('5'));
  printf("isdigit('a')=%d\n", !!isdigit('a'));

  // isalpha
  printf("isalpha('A')=%d\n", !!isalpha('A'));
  printf("isalpha('z')=%d\n", !!isalpha('z'));
  printf("isalpha('3')=%d\n", !!isalpha('3'));

  // isalnum
  printf("isalnum('B')=%d\n", !!isalnum('B'));
  printf("isalnum('9')=%d\n", !!isalnum('9'));
  printf("isalnum('!')=%d\n", !!isalnum('!'));

  // isupper / islower
  printf("isupper('Z')=%d\n", !!isupper('Z'));
  printf("isupper('z')=%d\n", !!isupper('z'));
  printf("islower('a')=%d\n", !!islower('a'));
  printf("islower('A')=%d\n", !!islower('A'));

  // isspace
  printf("isspace(' ')=%d\n", !!isspace(' '));
  printf("isspace('\\t')=%d\n", !!isspace('\t'));
  printf("isspace('a')=%d\n", !!isspace('a'));

  // ispunct
  printf("ispunct('!')=%d\n", !!ispunct('!'));
  printf("ispunct('a')=%d\n", !!ispunct('a'));

  // iscntrl
  printf("iscntrl(0)=%d\n", !!iscntrl(0));
  printf("iscntrl(127)=%d\n", !!iscntrl(127));
  printf("iscntrl('a')=%d\n", !!iscntrl('a'));

  // isprint / isgraph
  printf("isprint(' ')=%d\n", !!isprint(' '));
  printf("isprint(0)=%d\n", !!isprint(0));
  printf("isgraph(' ')=%d\n", !!isgraph(' '));
  printf("isgraph('!')=%d\n", !!isgraph('!'));

  // isxdigit
  printf("isxdigit('f')=%d\n", !!isxdigit('f'));
  printf("isxdigit('F')=%d\n", !!isxdigit('F'));
  printf("isxdigit('g')=%d\n", !!isxdigit('g'));

  // tolower / toupper
  printf("tolower('A')=%c\n", tolower('A'));
  printf("tolower('a')=%c\n", tolower('a'));
  printf("toupper('a')=%c\n", toupper('a'));
  printf("toupper('A')=%c\n", toupper('A'));
  printf("tolower('5')=%c\n", tolower('5'));

  return 0;
}
