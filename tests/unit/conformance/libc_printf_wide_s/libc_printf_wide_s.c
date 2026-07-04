// BUG: %ls prints only the first wide character of the string instead of the whole string.
// C11: 7.21.6.1p8 (l with s) — the argument is a pointer to wchar_t array; characters up to (not including) the null wide character are converted and written.
// EXPECT: "[Hi]\n" (verified against native clang).
#include <stdio.h>
#include <wchar.h>

int main(void) {
  wchar_t ws[] = {'H', 'i', 0};
  printf("[%ls]\n", ws);
  return 0;
}
