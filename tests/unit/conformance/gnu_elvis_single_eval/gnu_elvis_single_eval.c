// BUG: the GNU conditional with omitted middle operand `a ?: b` was a parse
//      error ("Unexpected token in expression: PUNCT ':'") — #681, promoted
//      from the #12 triage (0087 gap 3). 12 sites across SameBoy and busybox
//      vi.c/time.c each paid a vendored patch for the absence.
// C11: n/a (GNU extension). Governing contract: GCC "Conditionals with
//      Omitted Operands" — "x ? : y is equivalent to x ? x : y ... the
//      expression x is evaluated only once"; the type and conversions are
//      the underlying conditional's (6.5.15).
// EXPECT: the first operand evaluates ONCE whichever arm is taken, and the
//      else arm does not evaluate on a truthy condition (evals 1 1 0); a
//      side-effecting operand's VALUE stays right (the #680 lesson:
//      duplication corrupts values, not only counts — incr 3 4 / 88 1); the
//      red control pins the instrument: the TEXTUAL desugaring f() ? f() : y
//      really does read 2 (redctl 2), so the single-eval asserts can fail;
//      volatile reads once; constant operands remain INTEGER CONSTANT
//      EXPRESSIONS (enum value, array bound, static initializer, case
//      label); ?: is right-associative like the ternary; the result type
//      takes the usual arithmetic conversions of the equivalent ternary
//      (int/unsigned -> unsigned, int/long long -> 8 bytes, int/double ->
//      double, u20 bit-field promotes to signed int); pointer arms and the
//      null-pointer-constant case work; the ordinary ternary is unaffected.
//      NB `?:` inside #if is NOT accepted — clang (the oracle) rejects it
//      there; the extension is a C-expression extension, not a cpp one.
#include <stdio.h>

enum { K = 4 ?: 9 };                 /* ICE: enum value == 4 */
static char bound[1 ?: 2];           /* ICE: array bound == 1 */
static int gi = 0 ?: 42;             /* static init, falsy arm */
static long long gll = 3 ?: 5LL;     /* static init, truthy arm + UAC */

static int n = 0;
static int f(void) { n++; return 5; }
static int z(void) { n++; return 0; }
static int g(void) { n += 100; return 77; }

struct bf { unsigned u20 : 20; };

int main(void) {
  /* single evaluation, both arms; else arm untouched on truthy cond */
  n = 0;
  int r1 = f() ?: g();               /* f once, g never */
  int c1 = n;
  n = 0;
  int r2 = z() ?: 42;                /* z once, falsy -> 42 */
  int c2 = n;
  printf("evals %d %d %d\n", c1, c2 % 100, c2 / 100);
  printf("vals %d %d\n", r1, r2);

  /* value correctness under a side-effecting operand */
  int i = 3;
  int r3 = i++ ?: 99;
  printf("incr %d %d\n", r3, i);
  i = 0;
  int r4 = i++ ?: 88;
  printf("incr %d %d\n", r4, i);

  /* RED CONTROL: the textual desugaring evaluates twice — proof the
     single-eval instrument (the n counter) can actually go red. */
  n = 0;
  int rc = f() ? f() : 99;
  printf("redctl %d %d\n", rc, n);

  /* volatile condition: read exactly once (count unobservable here, but the
     value leg keeps the load on the temp path honest) */
  volatile int v = 6;
  printf("vol %d %d\n", v ?: 9, (v - 6) ?: 9);

  /* ICE contexts */
  printf("ice %d %d %d %lld\n", K, (int)sizeof(bound), gi, gll);
  switch (r2 & 0) {
    case (1 ?: 3) - 1: printf("case ok\n"); break;
    default: printf("case BAD\n"); break;
  }

  /* right-associative nesting, like the ternary */
  printf("nest %d %d\n", 0 ?: 0 ?: 7, 1 ?: 2 ?: 3);

  /* type: usual arithmetic conversions of the equivalent ternary */
  printf("uac %d %d %d %u %.1f\n",
         (int)sizeof(1 ?: 2LL),      /* long long -> 8 */
         (0u ?: -1) > 0,             /* unsigned result: -1 -> UINT_MAX */
         (int)sizeof(0 ?: 1.0f),     /* float result -> 4 */
         1 ?: 2u,                    /* value survives int->unsigned */
         0 ?: 1.5);                  /* double result */

  /* u20 bit-field promotes to signed int (fits), as in the ternary */
  struct bf s; s.u20 = 5;
  int p1 = s.u20 ?: 3;
  s.u20 = 0;
  printf("bf %d %d\n", p1, (s.u20 ?: -1) < 0);

  /* pointer arms + null pointer constant */
  char *p = 0;
  printf("ptr %s %s %d\n", p ?: "dflt", "lit" ?: p, ("x" ?: 0) != 0);

  /* the ordinary ternary is unaffected */
  printf("tern %d %d\n", r2 - 42 ? 1 : 2, r1 ? r1 + 1 : 0);
  return 0;
}
