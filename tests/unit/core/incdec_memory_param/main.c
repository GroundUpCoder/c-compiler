#include <stdio.h>

/*
 * When a scalar parameter has its address taken, it gets
 * allocClass == MEMORY and its data lives in the stack frame.
 * emitIncDec finds the parameter in localVarToWasmLocalIdx
 * (since all params are added there) and uses the register path,
 * which operates on the stale WASM local instead of the memory
 * location. Subsequent reads via emitExpr or pointer dereference
 * go through paramMemoryOffsets and see the old value.
 */

/* Pre-increment on address-taken param */
void test_pre_inc(int x) {
  int *p = &x;
  ++x;
  printf("x=%d *p=%d\n", x, *p);
}

/* Post-increment on address-taken param */
void test_post_inc(int x) {
  int *p = &x;
  int old = x++;
  printf("old=%d x=%d *p=%d\n", old, x, *p);
}

/* Pre-decrement on address-taken param */
void test_pre_dec(int x) {
  int *p = &x;
  --x;
  printf("x=%d *p=%d\n", x, *p);
}

/* Post-decrement on address-taken param */
void test_post_dec(int x) {
  int *p = &x;
  int old = x--;
  printf("old=%d x=%d *p=%d\n", old, x, *p);
}

/* Multiple increments */
void test_multiple_inc(int x) {
  int *p = &x;
  x++;
  x++;
  x++;
  printf("x=%d *p=%d\n", x, *p);
}

/* Compound assignment on address-taken param (tests emitAssignment) */
void test_compound_assign(int x) {
  int *p = &x;
  x += 10;
  printf("x=%d *p=%d\n", x, *p);
}

/* Simple assignment on address-taken param (tests emitAssignment) */
void test_simple_assign(int x) {
  int *p = &x;
  x = 42;
  printf("x=%d *p=%d\n", x, *p);
}

int main(void) {
  printf("=== pre-increment ===\n");
  test_pre_inc(10);

  printf("=== post-increment ===\n");
  test_post_inc(10);

  printf("=== pre-decrement ===\n");
  test_pre_dec(10);

  printf("=== post-decrement ===\n");
  test_post_dec(10);

  printf("=== multiple increments ===\n");
  test_multiple_inc(10);

  printf("=== compound assignment ===\n");
  test_compound_assign(5);

  printf("=== simple assignment ===\n");
  test_simple_assign(5);

  return 0;
}
