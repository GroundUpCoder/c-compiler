/*
 * Tests for side effects in lvalue expressions.
 *
 * BUG: The code generator re-evaluates lvalue address expressions multiple
 * times during assignment, causing side effects (post-increment, function
 * calls, etc.) to execute more than once.
 *
 * Root cause (compiler.cc emitAssignment ~line 10332):
 *   The `emitAddr` lambda is called 2x for simple assignment (store + reload)
 *   and 3x for compound assignment (load + store + reload).
 *   Each call re-evaluates the entire index/address expression including
 *   any side effects.
 *
 * Same pattern affects emitIncDec (~line 10717) and emitAddressOf (~line 10046)
 * which are also called multiple times for a single operation.
 */
#include <stdio.h>

int call_count;

int *returns_ptr(int *p) {
  call_count++;
  return p;
}

struct S { int x; int y; };

struct S *returns_sp(struct S *p) {
  call_count++;
  return p;
}

int main() {
  int arr[4] = {10, 20, 30, 40};
  int i;

  printf("=== SUBSCRIPT with post-increment index ===\n");

  /* arr[i++] = val: simple assignment */
  i = 0;
  arr[i++] = 42;
  printf("subscript_assign: i=%d (expect 1)\n", i);

  /* arr[i++] += val: compound assignment */
  arr[0] = 10;
  i = 0;
  arr[i++] += 5;
  printf("subscript_compound: i=%d arr[0]=%d (expect i=1 arr[0]=15)\n", i, arr[0]);

  /* arr[--i] = val: pre-decrement */
  i = 3;
  arr[--i] = 99;
  printf("subscript_predec: i=%d arr[2]=%d (expect i=2 arr[2]=99)\n", i, arr[2]);

  printf("\n=== DEREF with side-effecting operand ===\n");

  /* *(func()) = val: deref simple assignment */
  arr[0] = 10;
  call_count = 0;
  *(returns_ptr(arr)) = 99;
  printf("deref_assign: calls=%d (expect 1)\n", call_count);

  /* *(func()) += val: deref compound assignment */
  arr[0] = 10;
  call_count = 0;
  *(returns_ptr(arr)) += 1;
  printf("deref_compound: calls=%d arr[0]=%d (expect calls=1 arr[0]=11)\n", call_count, arr[0]);

  printf("\n=== ARROW with side-effecting base ===\n");

  /* func()->field = val: arrow simple assignment */
  struct S s = {0, 0};
  call_count = 0;
  returns_sp(&s)->x = 42;
  printf("arrow_assign: calls=%d s.x=%d (expect calls=1 s.x=42)\n", call_count, s.x);

  /* func()->field += val: arrow compound assignment */
  s.x = 10;
  call_count = 0;
  returns_sp(&s)->x += 5;
  printf("arrow_compound: calls=%d s.x=%d (expect calls=1 s.x=15)\n", call_count, s.x);

  printf("\n=== INCREMENT/DECREMENT on complex lvalue ===\n");

  /* ++*(func()): pre-increment on deref */
  arr[0] = 10;
  call_count = 0;
  ++*returns_ptr(arr);
  printf("preinc_deref: calls=%d arr[0]=%d (expect calls=1 arr[0]=11)\n", call_count, arr[0]);

  /* (*(func()))++: post-increment on deref */
  arr[0] = 10;
  call_count = 0;
  (*returns_ptr(arr))++;
  printf("postinc_deref: calls=%d arr[0]=%d (expect calls=1 arr[0]=11)\n", call_count, arr[0]);

  /* ++func()->x: pre-increment on arrow */
  s.x = 10;
  call_count = 0;
  ++returns_sp(&s)->x;
  printf("preinc_arrow: calls=%d s.x=%d (expect calls=1 s.x=11)\n", call_count, s.x);

  return 0;
}
