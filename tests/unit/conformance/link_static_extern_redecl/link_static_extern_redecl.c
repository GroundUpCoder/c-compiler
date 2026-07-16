// BUG: `static int x = 4; extern int x;` failed to link ("Undefined symbol
//      'x'"): linkTranslationUnits partitions declarations by storage class,
//      so the extern re-declaration was looked up in the external scope and
//      never found the internal-linkage definition in the TU scope.
// C11: 6.2.2p4 — a declaration with `extern` (or, for functions via 6.2.2p5,
//      with no storage class) after a visible prior declaration with internal
//      or external linkage inherits the PRIOR declaration's linkage: it
//      re-declares the SAME object/function, not a new external one.
// EXPECT: clang-verified output below.
#include <stdio.h>

static int x = 4;
extern int x;              /* same internal-linkage object */

static int t;              /* tentative internal definition */
extern int t;              /* still that object */
static int t2;
extern int t2;
static int t2 = 8;         /* later initialized definition wins */

static int f(void) { return 7; }
extern int f(void);        /* function version of the same rule */

static int g(void);
int g(void);               /* 6.2.2p5: no storage class acts like extern */
static int g(void) { return 9; }

int a;                     /* plain external object... */
extern int a;              /* ...still one external object */

int main(void) {
  int *p = &x;             /* address through the re-declaration binding */
  t = 5;
  a = 6;
  printf("%d %d %d %d %d %d %d\n", x, *p, t, t2, f(), g(), a);
  return 0;
}
