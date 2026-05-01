// Tests that non-i32 values used as conditions are properly converted.
// Conditions in if/while/for/do-while must be i32 in WASM.
#include <stdio.h>

int main() {
  // double as condition
  double d = 1.5;
  if (d) {
    printf("double true\n");
  }
  double dz = 0.0;
  if (dz) {
    printf("BUG\n");
  } else {
    printf("double zero false\n");
  }

  // float as condition
  float f = 0.1f;
  if (f) {
    printf("float true\n");
  }

  // long long as condition
  long long ll = 1;
  if (ll) {
    printf("llong true\n");
  }
  long long llz = 0;
  if (llz) {
    printf("BUG\n");
  } else {
    printf("llong zero false\n");
  }

  // while with double condition
  double count = 3.0;
  while (count > 0.5) {
    printf("w");
    count = count - 1.0;
  }
  printf("\n");

  // for with float condition
  float fi;
  for (fi = 3.0f; fi > 0.5f; fi = fi - 1.0f) {
    printf("f");
  }
  printf("\n");

  return 0;
}
