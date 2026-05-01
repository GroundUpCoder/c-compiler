#include <stdio.h>

struct Point { int x; int y; };

union IntOrFloat { int i; float f; };

struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

union IntOrFloat make_union_int(int v) {
  union IntOrFloat u;
  u.i = v;
  return u;
}

/*
 * Assign to a struct parameter.
 * The parameter lives in stack memory (paramMemoryOffsets), but
 * emitAssignment finds it in localVarToWasmLocalIdx first and
 * takes the register path, which only updates the WASM local
 * (the original source address) instead of copying data into the
 * parameter's memory slot. Subsequent member access still reads
 * from the unchanged memory slot.
 */
void test_assign_to_struct_param(struct Point p) {
  printf("before: x=%d y=%d\n", p.x, p.y);
  p = make_point(99, 100);
  printf("after: x=%d y=%d\n", p.x, p.y);
}

/* Same issue with union parameters */
void test_assign_to_union_param(union IntOrFloat u) {
  printf("before: i=%d\n", u.i);
  u = make_union_int(999);
  printf("after: i=%d\n", u.i);
}

/* Assign struct param from another struct variable */
void test_assign_param_from_var(struct Point p) {
  struct Point q;
  q.x = 50;
  q.y = 60;
  p = q;
  printf("p: x=%d y=%d\n", p.x, p.y);
}

int main(void) {
  struct Point pt;
  pt.x = 1;
  pt.y = 2;
  printf("=== assign to struct param ===\n");
  test_assign_to_struct_param(pt);

  union IntOrFloat uf;
  uf.i = 42;
  printf("=== assign to union param ===\n");
  test_assign_to_union_param(uf);

  printf("=== assign param from var ===\n");
  test_assign_param_from_var(pt);

  return 0;
}
