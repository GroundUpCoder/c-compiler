#include <stdio.h>

int main() {
  // Test i32 convenience syntax
  int a = __wasm(int, (), i32 42);
  printf("%d\n", a);  // 42

  int b = __wasm(int, (), i32 - 99);
  printf("%d\n", b);  // -99

  // Test i64 convenience syntax
  long long c = __wasm(long long, (), i64 1234567890123);
  printf("%lld\n", c);  // 1234567890123

  // Test f32 convenience syntax
  float d = __wasm(float, (), f32 3.14);
  printf("%f\n", (double)d);  // ~3.14

  // Test f64 convenience syntax
  double e = __wasm(double, (), f64 3.141592653589793);
  printf("%f\n", e);  // 3.141592653589793

  // Test binary operation with old op syntax
  int x = 10;
  int y = 32;
  int sum = __wasm(int, (x, y), op 0x6A);  // i32.add
  printf("%d\n", sum);                      // 42

  return 0;
}
