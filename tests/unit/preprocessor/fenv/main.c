#include <stdio.h>
#include <fenv.h>

int main(void) {
  // fenv.h should compile and functions should be callable (no-ops on WASM)
  printf("FE_TONEAREST: %d\n", FE_TONEAREST);
  printf("FE_ALL_EXCEPT: %d\n", FE_ALL_EXCEPT);
  printf("round: %d\n", fegetround());
  feclearexcept(FE_ALL_EXCEPT);
  fesetround(FE_TONEAREST);
  printf("ok\n");
  return 0;
}
