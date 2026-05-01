#include <stdio.h>

// Test 1: Nested arrays (2D array)
void test_nested_arrays() {
  int arr[2][3];
  arr[0][0] = 1;
  arr[0][1] = 2;
  arr[0][2] = 3;
  arr[1][0] = 4;
  arr[1][1] = 5;
  arr[1][2] = 6;

  printf("Test 1: Nested arrays\n");
  printf("arr[0][0] = %d (expect 1)\n", arr[0][0]);
  printf("arr[0][1] = %d (expect 2)\n", arr[0][1]);
  printf("arr[1][2] = %d (expect 6)\n", arr[1][2]);
}

// Test 2: Arrays within structs
struct WithArray {
  int x;
  int arr[3];
  int y;
};

void test_array_in_struct() {
  struct WithArray s;
  s.x = 10;
  s.arr[0] = 100;
  s.arr[1] = 200;
  s.arr[2] = 300;
  s.y = 20;

  printf("\nTest 2: Array in struct\n");
  printf("s.x = %d (expect 10)\n", s.x);
  printf("s.arr[0] = %d (expect 100)\n", s.arr[0]);
  printf("s.arr[1] = %d (expect 200)\n", s.arr[1]);
  printf("s.arr[2] = %d (expect 300)\n", s.arr[2]);
  printf("s.y = %d (expect 20)\n", s.y);
}

// Test 3: Structs within structs
struct Inner {
  int a;
  int b;
};

struct Outer {
  int x;
  struct Inner inner;
  int y;
};

void test_struct_in_struct() {
  struct Outer o;
  o.x = 1;
  o.inner.a = 2;
  o.inner.b = 3;
  o.y = 4;

  printf("\nTest 3: Struct in struct\n");
  printf("o.x = %d (expect 1)\n", o.x);
  printf("o.inner.a = %d (expect 2)\n", o.inner.a);
  printf("o.inner.b = %d (expect 3)\n", o.inner.b);
  printf("o.y = %d (expect 4)\n", o.y);
}

// Test 4: Nested structs with arrays
struct Point {
  int coords[2];
};

struct Rectangle {
  struct Point corners[2];
};

void test_complex_nesting() {
  struct Rectangle rect;
  rect.corners[0].coords[0] = 0;   // top-left x
  rect.corners[0].coords[1] = 0;   // top-left y
  rect.corners[1].coords[0] = 10;  // bottom-right x
  rect.corners[1].coords[1] = 20;  // bottom-right y

  printf("\nTest 4: Complex nesting (struct with array of structs with arrays)\n");
  printf("rect.corners[0].coords[0] = %d (expect 0)\n", rect.corners[0].coords[0]);
  printf("rect.corners[0].coords[1] = %d (expect 0)\n", rect.corners[0].coords[1]);
  printf("rect.corners[1].coords[0] = %d (expect 10)\n", rect.corners[1].coords[0]);
  printf("rect.corners[1].coords[1] = %d (expect 20)\n", rect.corners[1].coords[1]);
}

int main() {
  test_nested_arrays();
  test_array_in_struct();
  test_struct_in_struct();
  test_complex_nesting();
  printf("\nAll tests completed!\n");
  return 0;
}
