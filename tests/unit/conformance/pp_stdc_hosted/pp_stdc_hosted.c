// BUG: __STDC_HOSTED__ was not predefined at all (an undeclared
//      identifier), though this is a hosted implementation.
// C11: 6.10.8.1 — __STDC_HOSTED__ is a required predefined macro; 1 for
//      a hosted implementation.
// EXPECT: defined, and equal to 1.
#include <stdio.h>
int main(void) {
#ifdef __STDC_HOSTED__
  printf("hosted=%d\n", __STDC_HOSTED__);
#else
  printf("undefined\n");
#endif
  return 0;
}
