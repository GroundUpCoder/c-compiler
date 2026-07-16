// BUG: a compound literal used as an lvalue (assignment target, ++/--
// operand) crashed codegen with a raw "emitLValue: unsupported
// expression ECompoundLiteral" throw (G9, todos/0217).
// C11: 6.5.2.5p4 — a compound literal IS an lvalue; block-scope
// evaluations have automatic storage, file-scope ones static storage.
// EXPECT: clang-verified output below.
#include <stdio.h>
struct P { int x, y; };
int *gp = &(int){77};
int main(void) {
  int *p = &(int){40};
  *p += 2;
  printf("amp %d\n", *p);
  printf("assign %d\n", (int){5} = 6);
  printf("preinc %d\n", ++(int){8});
  printf("postinc %d\n", ((int){8})++);
  printf("predec %d\n", --(int){8});
  struct P *sp = &(struct P){1, 2};
  sp->y = 9;
  printf("struct %d %d\n", sp->x, sp->y);
  *gp += 1;
  printf("file %d\n", *gp);
  return 0;
}
