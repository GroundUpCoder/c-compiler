// Global index-space shift: __gcstr imported globals occupy [0, K) of the
// index space, so EVERY defined global (stack pointer, heap base, scalars
// of all widths, mutable + ref globals, statics) shifts by K. A wrong index
// here fails validation (type clash with a (ref extern) import) or corrupts
// a neighbour — this test reads AND writes every defined-global kind with
// gcstr imports in play. todos/0041.
#include <stdio.h>
#include <guc.h>

int gi = 11;
unsigned int gu = 0xdeadbeefu;
long long gll = 0x1122334455667788ll;
float gf = 1.5f;
double gd = 2.25;
__externref gs1 = __gcstr("one");
int gi2 = 22;
__externref gs2 = __gcstr("two");
__struct Node { int v; };
__struct Node *gnode;          // ref-typed defined global, auto-null
__eqref geq;                   // abstract ref global, auto-null

void mutate(void) {
  gi += 100;
  gu ^= 0xffffffffu;
  gll += 1;
  gf *= 2.0f;
  gd *= 2.0;
  gi2 = gi + 1;
}

int main(void) {
  // alloca exercises the stack-pointer global (shifted too)
  char *p = __builtin(alloca, 32);
  p[0] = 'A'; p[1] = 0;

  printf("initial: %d %u %lld %g %g %d\n", gi, gu, gll, (double)gf, gd, gi2);
  mutate();
  printf("mutated: %d %u %lld %g %g %d\n", gi, gu, gll, (double)gf, gd, gi2);

  printf("gs1 len: %d\n", __wjs_length(gs1));
  printf("gs2 len: %d\n", __wjs_length(gs2));
  printf("gs1 != gs2: %d\n", !__wjs_equals(gs1, gs2));

  printf("gnode null: %d\n", gnode == 0);
  gnode = __new(__struct Node, 7);
  printf("gnode.v: %d\n", gnode->v);
  geq = __ref_as_eq(__ref_as_extern(gnode));
  printf("geq roundtrip: %d\n", __ref_cast(__struct Node, geq)->v);

  static long long sll = 42;
  sll *= 2;
  printf("static ll: %lld\n", sll);

  printf("alloca: %s\n", p);

  // heap_base (a patched defined global) must still point past static data
  printf("heap sane: %d\n", (unsigned int)__builtin(heap_base) > 0);
  return 0;
}
