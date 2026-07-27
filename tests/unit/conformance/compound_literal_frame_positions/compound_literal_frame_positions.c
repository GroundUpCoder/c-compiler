// BUG: a block-scope compound literal that lost its frame slot was written at
//      the CALLER's frame base instead (todos/0319). Only the declaration-
//      initializer position actually mis-compiled, but the trigger is generic:
//      any pass that rewrites the AST node in place can desynchronise the
//      frame-layout walk from codegen. This is the per-position regression
//      guard for all five positions the 0319 investigation measured.
// C11: 6.5.2.5p5 — a compound literal at block scope has automatic storage
//      duration associated with the enclosing block, i.e. it IS a frame
//      object, and 6.5.2.5p4 — it is an lvalue.
// EXPECT: for every position, (a) the callee cannot touch the caller's locals
//      (guard stays all-zero) and (b) the literal's own values read back
//      correctly. Each literal carries a `-1` so the constant folder rebuilds
//      the ECompoundLiteral node — that node-identity churn is the trigger.
#include <stdio.h>

typedef struct { int a, b, c, d; } loc_t;

static loc_t sink;
static loc_t stat_obj;

/* 1. declaration initializer — the position that mis-compiled */
static void pos_decl_init(int n) {
  loc_t l = (loc_t){ n, n, -1, -1 };
  sink = l;
}

/* 2. plain assignment to an already-declared local */
static void pos_assign(int n) {
  loc_t l;
  l = (loc_t){ n, n, -1, -1 };
  sink = l;
}

/* 3. round-tripped through its own address (compound literals are lvalues) */
static void pos_addr_deref(int n) {
  loc_t l;
  l = *&(loc_t){ n, n, -1, -1 };
  sink = l;
}

/* 4. assignment into an object with static storage duration */
static void pos_static_dest(int n) {
  stat_obj = (loc_t){ n, n, -1, -1 };
  sink = stat_obj;
}

/* 5. member-access base — the literal is only read through, never named */
static void pos_member_base(int n) {
  sink.a = (loc_t){ n, n, -1, -1 }.a;
  sink.b = (loc_t){ n, n, -1, -1 }.b;
  sink.c = (loc_t){ n, n, -1, -1 }.c;
  sink.d = (loc_t){ n, n, -1, -1 }.d;
}

static void check(const char *what, void (*fn)(int)) {
  int guard[4] = { 0, 0, 0, 0 };
  sink = (loc_t){ 0, 0, 0, 0 };
  fn(0x5A);
  printf("%s guard=%d,%d,%d,%d val=%d,%d,%d,%d\n", what,
         guard[0], guard[1], guard[2], guard[3],
         sink.a, sink.b, sink.c, sink.d);
}

int main(void) {
  check("decl_init  ", pos_decl_init);
  check("assign     ", pos_assign);
  check("addr_deref ", pos_addr_deref);
  check("static_dest", pos_static_dest);
  check("member_base", pos_member_base);
  return 0;
}
