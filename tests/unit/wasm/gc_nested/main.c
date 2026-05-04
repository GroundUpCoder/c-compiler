#include <stdio.h>

__struct Point { int x; int y; };
__struct Pair { __struct Point a; __struct Point b; };

void test_nested_struct(void) {
  printf("=== nested struct ===\n");
  __struct Pair p = __new(__struct Pair);
  printf("%d\n", __ref_is_null(p.a));    // 1: default-init nested ref is null
  p.a = __new(__struct Point, 1, 2);
  p.b = __new(__struct Point, 3, 4);
  printf("(%d,%d) (%d,%d)\n", p.a.x, p.a.y, p.b.x, p.b.y);
}

void test_array_of_struct(void) {
  printf("=== array of struct ===\n");
  __array(__struct Point) arr = __new(__array(__struct Point), 3);
  for (int i = 0; i < 3; i++) {
    arr[i] = __new(__struct Point, i + 1, (i + 1) * 10);
  }
  for (int i = 0; i < 3; i++) {
    printf("(%d,%d)\n", arr[i].x, arr[i].y);
  }
}

void test_array_of_array(void) {
  printf("=== array of array ===\n");
  __array(__array(int)) m = __new(__array(__array(int)), 2);
  m[0] = __new(__array(int), 3);
  m[1] = __new(__array(int), 3);
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 3; j++) {
      m[i][j] = i * 10 + j;
    }
  }
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 3; j++) {
      printf("%d ", m[i][j]);
    }
    printf("\n");
  }
}

int main(void) {
  test_nested_struct();
  test_array_of_struct();
  test_array_of_array();
  return 0;
}
