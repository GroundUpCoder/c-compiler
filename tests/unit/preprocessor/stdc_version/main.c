#include <stdio.h>

int main(void) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
  printf("C11 or later: %ld\n", (long)__STDC_VERSION__);
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L
  printf("C99 or later: %ld\n", (long)__STDC_VERSION__);
#else
  printf("Pre-C99\n");
#endif
  return 0;
}
