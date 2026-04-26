// samples/02.c - Tests struct support and stdint.h
// Everything here compiles and runs.

#include <stdint.h>
#include <stdio.h>

// === Simple Struct ===

struct Point {
  int x;
  int y;
};

// === Struct with Mixed Types ===

struct Mixed {
  char c;
  int i;
  long long ll;
};

// === Nested Struct ===

struct Rect {
  struct Point topLeft;
  struct Point bottomRight;
};

// === Global Structs ===

struct Point g_origin;
struct Mixed g_mixed;

// === Functions Taking Struct Pointers ===

int point_sum(struct Point *p) { return p->x + p->y; }

void point_scale(struct Point *p, int factor) {
  p->x *= factor;
  p->y *= factor;
}

void point_set(struct Point *p, int x, int y) {
  p->x = x;
  p->y = y;
}

int point_dot(struct Point *a, struct Point *b) { return a->x * b->x + a->y * b->y; }

void point_add(struct Point *result, struct Point *a, struct Point *b) {
  result->x = a->x + b->x;
  result->y = a->y + b->y;
}

int rect_area(struct Rect *r) {
  int width = r->bottomRight.x - r->topLeft.x;
  int height = r->bottomRight.y - r->topLeft.y;
  return width * height;
}

// === Struct Returning via Pointer ===

void make_point(struct Point *out, int x, int y) {
  out->x = x;
  out->y = y;
}

// === Test Functions ===

void test_global_struct() {
  printf("%s\n", "=== Global Struct ===");

  // Direct assignment
  g_origin.x = 10;
  g_origin.y = 20;
  printf("%d\n", g_origin.x);            // 10
  printf("%d\n", g_origin.y);            // 20
  printf("%d\n", point_sum(&g_origin));  // 30

  // Modify via pointer
  point_scale(&g_origin, 3);
  printf("%d\n", g_origin.x);  // 30
  printf("%d\n", g_origin.y);  // 60

  // Compound assignment
  g_origin.x += 5;
  g_origin.y -= 10;
  printf("%d\n", g_origin.x);  // 35
  printf("%d\n", g_origin.y);  // 50
}

void test_local_struct() {
  printf("%s\n", "=== Local Struct ===");

  struct Point p;
  p.x = 5;
  p.y = 7;
  printf("%d\n", p.x);            // 5
  printf("%d\n", p.y);            // 7
  printf("%d\n", point_sum(&p));  // 12

  // Multiple local structs
  struct Point a;
  struct Point b;
  a.x = 3;
  a.y = 4;
  b.x = 5;
  b.y = 6;
  printf("%d\n", point_dot(&a, &b));  // 3*5 + 4*6 = 15 + 24 = 39

  // Result via pointer
  struct Point sum;
  point_add(&sum, &a, &b);
  printf("%d\n", sum.x);  // 8
  printf("%d\n", sum.y);  // 10
}

void test_mixed_struct() {
  printf("%s\n", "=== Mixed Types Struct ===");

  struct Mixed m;
  m.c = 65;  // 'A'
  m.i = 1000;
  m.ll = 9999999999LL;
  printf("%d\n", m.c);   // 65
  printf("%d\n", m.i);   // 1000
  printf("%lld\n", m.ll);  // 9999999999

  // Global mixed struct
  g_mixed.c = 66;  // 'B'
  g_mixed.i = 2000;
  g_mixed.ll = 1234567890123LL;
  printf("%d\n", g_mixed.c);   // 66
  printf("%d\n", g_mixed.i);   // 2000
  printf("%lld\n", g_mixed.ll);  // 1234567890123
}

void test_nested_struct() {
  printf("%s\n", "=== Nested Struct ===");

  struct Rect r;
  r.topLeft.x = 10;
  r.topLeft.y = 20;
  r.bottomRight.x = 50;
  r.bottomRight.y = 80;

  printf("%d\n", r.topLeft.x);      // 10
  printf("%d\n", r.topLeft.y);      // 20
  printf("%d\n", r.bottomRight.x);  // 50
  printf("%d\n", r.bottomRight.y);  // 80
  printf("%d\n", rect_area(&r));    // (50-10) * (80-20) = 40 * 60 = 2400
}

void test_pointer_operations() {
  printf("%s\n", "=== Pointer Operations ===");

  struct Point p;
  struct Point *ptr = &p;

  ptr->x = 100;
  ptr->y = 200;
  printf("%d\n", p.x);     // 100
  printf("%d\n", p.y);     // 200
  printf("%d\n", ptr->x);  // 100
  printf("%d\n", ptr->y);  // 200

  // Compound assignment via pointer
  ptr->x += 50;
  ptr->y *= 2;
  printf("%d\n", p.x);  // 150
  printf("%d\n", p.y);  // 400
}

void test_struct_array() {
  printf("%s\n", "=== Struct in Array ===");

  struct Point points[3];
  points[0].x = 1;
  points[0].y = 2;
  points[1].x = 3;
  points[1].y = 4;
  points[2].x = 5;
  points[2].y = 6;

  int sumX = 0;
  int sumY = 0;
  for (int i = 0; i < 3; i++) {
    sumX += points[i].x;
    sumY += points[i].y;
  }
  printf("%d\n", sumX);  // 1+3+5 = 9
  printf("%d\n", sumY);  // 2+4+6 = 12

  // Access via pointer arithmetic
  struct Point *p = points;
  printf("%d\n", p[0].x);  // 1
  printf("%d\n", p[1].x);  // 3
  printf("%d\n", p[2].x);  // 5
}

void test_stdint() {
  printf("%s\n", "=== stdint.h Types ===");

  // Test fixed-width types
  int8_t i8 = -100;
  uint8_t u8 = 200;
  int16_t i16 = -30000;
  uint16_t u16 = 60000;
  int32_t i32 = -2000000000;
  uint32_t u32 = 4000000000U;
  int64_t i64 = -9000000000000000000LL;
  uint64_t u64 = 18000000000000000000ULL;

  printf("%d\n", i8);   // -100
  printf("%d\n", u8);   // 200
  printf("%d\n", i16);  // -30000
  printf("%d\n", u16);  // 60000
  printf("%d\n", i32);  // -2000000000
  printf("%lld\n", (long long)u32);  // 4000000000
  printf("%lld\n", i64);  // -9000000000000000000
  printf("%lld\n", (long long)u64);  // 18000000000000000000 (will wrap)

  // Test pointer types
  printf("%s\n", "=== intptr_t/uintptr_t ===");
  int value[1];
  value[0] = 42;
  intptr_t iptr = (intptr_t)value;
  uintptr_t uptr = (uintptr_t)value;
  int *recovered = (int *)iptr;
  printf("%d\n", *recovered);  // 42
  printf("%d\n", iptr == (intptr_t)uptr);  // 1 (same address)

  // Test MIN/MAX macros
  printf("%s\n", "=== MIN/MAX Macros ===");
  printf("%d\n", INT8_MIN);   // -128
  printf("%d\n", INT8_MAX);   // 127
  printf("%d\n", UINT8_MAX);  // 255
  printf("%d\n", INT16_MIN);  // -32768
  printf("%d\n", INT16_MAX);  // 32767
  printf("%d\n", UINT16_MAX); // 65535
  printf("%d\n", INT32_MIN);  // -2147483648
  printf("%d\n", INT32_MAX);  // 2147483647
  printf("%lld\n", (long long)UINT32_MAX);  // 4294967295
  printf("%lld\n", INT64_MIN);  // -9223372036854775808
  printf("%lld\n", INT64_MAX);  // 9223372036854775807

  // Verify INTPTR matches INT32 for wasm32
  printf("%d\n", INTPTR_MIN == INT32_MIN);  // 1
  printf("%d\n", INTPTR_MAX == INT32_MAX);  // 1
  printf("%d\n", UINTPTR_MAX == UINT32_MAX);  // 1
}

int main() {
  test_global_struct();
  test_local_struct();
  test_mixed_struct();
  test_nested_struct();
  test_pointer_operations();
  test_struct_array();
  test_stdint();

  return 0;
}

/*
 * Expected output:
 * === Global Struct ===
 * 10
 * 20
 * 30
 * 30
 * 60
 * 35
 * 50
 * === Local Struct ===
 * 5
 * 7
 * 12
 * 39
 * 8
 * 10
 * === Mixed Types Struct ===
 * 65
 * 1000
 * 9999999999
 * 66
 * 2000
 * 1234567890123
 * === Nested Struct ===
 * 10
 * 20
 * 50
 * 80
 * 2400
 * === Pointer Operations ===
 * 100
 * 200
 * 100
 * 200
 * 150
 * 400
 * === Struct in Array ===
 * 9
 * 12
 * 1
 * 3
 * 5
 * === stdint.h Types ===
 * -100
 * 200
 * -30000
 * 60000
 * -2000000000
 * 4000000000
 * -9000000000000000000
 * -446744073709551616
 * === intptr_t/uintptr_t ===
 * 42
 * 1
 * === MIN/MAX Macros ===
 * -128
 * 127
 * 255
 * -32768
 * 32767
 * 65535
 * -2147483648
 * 2147483647
 * 4294967295
 * -9223372036854775808
 * 9223372036854775807
 * 1
 * 1
 * 1
 */
