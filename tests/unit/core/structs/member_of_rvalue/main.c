#include <stdio.h>

struct Point { int x; int y; };

struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

/* Member access on struct-returning function call */
void test_member_of_call(void) {
  int x = make_point(10, 20).x;
  int y = make_point(30, 40).y;
  printf("x=%d y=%d\n", x, y);
}

/* Multiple member accesses in a binary expression */
void test_multiple_members(void) {
  int sum = make_point(5, 6).x + make_point(7, 8).y;
  printf("sum=%d\n", sum);
}

/* Member access in a conditional */
void test_member_in_cond(void) {
  if (make_point(1, 0).x) {
    printf("true\n");
  }
  if (make_point(0, 1).x) {
    printf("should not print\n");
  } else {
    printf("false\n");
  }
}

int main(void) {
  printf("=== member of call ===\n");
  test_member_of_call();
  printf("=== multiple members ===\n");
  test_multiple_members();
  printf("=== member in cond ===\n");
  test_member_in_cond();
  return 0;
}
