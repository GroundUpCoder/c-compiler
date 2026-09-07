// BUG: aggregate-return temporaries were allocated by a runtime shadow-stack
// bump whose release point was a codegen counter (callNesting == 0), not a
// language construct. This pins the observable lifetime rules the frame-slot
// redesign (#773) must preserve.
// C11: 6.2.4p8 - a non-lvalue structure temporary returned by a function call
// lives until the end of the enclosing full expression.
// EXPECT: every line matches clang.
#include <stdio.h>
#include <stdlib.h>
#include <alloca.h>

typedef struct { int x, y; } P;
typedef struct { int a[6]; int tag; } Big;

static int calls;

static P mk(int a, int b) { calls++; P p; p.x = a; p.y = b; return p; }
static P addp(P a, P b) { return mk(a.x + b.x, a.y + b.y); }
static int sum2(P a, P b) { return a.x + a.y + b.x + b.y; }
static Big mkbig(int seed) {
  Big b;
  for (int i = 0; i < 6; i++) b.a[i] = seed + i;
  b.tag = seed * 100;
  return b;
}
static int usebig(Big b, Big c) { return b.a[0] + b.tag + c.a[5] + c.tag; }

// An aggregate return inside a function that also uses alloca: the alloca
// region must survive the call, and the return temp must not land on top of it.
static int with_alloca(int n) {
  int *scratch = (int *)alloca(n * sizeof(int));
  for (int i = 0; i < n; i++) scratch[i] = i * 3;
  P p = addp(mk(1, 2), mk(3, 4));
  int acc = 0;
  for (int i = 0; i < n; i++) acc += scratch[i];
  return acc + p.x + p.y;
}

static P *slot(P *store, int *hits) { (*hits)++; return store; }

int main(void) {
  // 1. sibling aggregate calls in one argument list - both temps live at once
  printf("sibling %d\n", sum2(mk(1, 2), mk(3, 4)));

  // 2. nested aggregate calls - inner temp outlives its own call
  P n = addp(mk(1, 2), addp(mk(3, 4), mk(5, 6)));
  printf("nested %d %d\n", n.x, n.y);

  // 3. aggregate return through a conditional operator
  for (int c = 0; c < 2; c++) {
    P q = c ? mk(10, 20) : mk(30, 40);
    printf("cond%d %d %d\n", c, q.x, q.y);
  }

  // 4. member access directly off a returned temporary, in a variadic call
  printf("member %d %d\n", mk(7, 8).x, mk(9, 11).y);

  // 5. returned temporary passed straight into a by-value aggregate parameter
  printf("byval %d\n", sum2(addp(mk(1, 1), mk(2, 2)), mk(5, 5)));

  // 6. LHS of the assignment itself contains a call
  P store = mk(0, 0);
  int hits = 0;
  *slot(&store, &hits) = addp(mk(2, 3), mk(4, 5));
  printf("lhs %d %d %d\n", store.x, store.y, hits);

  // 7. large aggregates, above any plausible small-struct threshold
  printf("big %d\n", usebig(mkbig(1), mkbig(2)));

  // 8. alloca coexistence
  printf("alloca %d\n", with_alloca(5));

  // 9. a loop: the temporary must be reclaimed every iteration, not leaked
  P acc = mk(0, 0);
  for (int i = 0; i < 20000; i++) acc = addp(acc, mk(1, 2));
  printf("loop %d %d\n", acc.x, acc.y);

  printf("calls %d\n", calls);
  return 0;
}
