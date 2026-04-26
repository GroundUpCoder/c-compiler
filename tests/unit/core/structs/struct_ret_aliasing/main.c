#include <stdio.h>

struct Point { int x; int y; };

struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

/*
 * BUG: When multiple struct-returning function calls are used as
 * arguments to the same function call, their temporary return
 * spaces overlap. The SP is restored after each call, so the next
 * call allocates the same memory region, overwriting the previous
 * call's returned struct data.
 */

struct Point add_points(struct Point a, struct Point b) {
  return make_point(a.x + b.x, a.y + b.y);
}

void print_two(int a, int b) {
  printf("%d %d\n", a, b);
}

void test_struct_args_aliasing(void) {
  /* add_points receives two struct args from make_point calls.
   * make_point(3,4) overwrites make_point(1,2)'s return space.
   * Result: add_points sees {3,4} for both args → {6,8} not {4,6}. */
  struct Point r = add_points(make_point(1, 2), make_point(3, 4));
  printf("r: %d %d\n", r.x, r.y);
}

void test_member_nonvariadic(void) {
  /* Non-variadic: member values are loaded onto the WASM stack
   * immediately, so the second call can't clobber the first value.
   * This case works correctly. */
  print_two(make_point(100, 200).x, make_point(300, 400).y);
}

void test_member_variadic(void) {
  /* Variadic (printf): struct return in make_point().x clobbers
   * tempLocalIdx, which varargs code uses for the base pointer.
   * The varargs pointer and subsequent slot addresses are wrong. */
  printf("%d %d\n", make_point(100, 200).x, make_point(300, 400).y);
}

int main(void) {
  printf("=== struct args aliasing ===\n");
  test_struct_args_aliasing();
  printf("=== member nonvariadic ===\n");
  test_member_nonvariadic();
  printf("=== member variadic ===\n");
  test_member_variadic();
  return 0;
}
