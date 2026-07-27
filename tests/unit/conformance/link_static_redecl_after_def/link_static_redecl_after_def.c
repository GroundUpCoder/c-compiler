// BUG: a `static` function re-declared AFTER its definition failed to link
//      ("Undefined symbol"). The re-declaration REPLACED the definition in
//      varScope, so callers bound the body-less node; the per-TU tree-shake
//      marks reachability by NODE identity over unit.staticFunctions, so the
//      definition was never marked live and got filtered out. Predates
//      todos/0219 — that fix covered `extern`/no-storage-class
//      re-declarations only and left the repeated-`static` cell broken.
//      Two shapes: def->decl (below: b/e/g) and decl->use->decl->def (h),
//      where the call bound the FIRST declaration and the definition's
//      back-pointer landed on the second. todos/0321.
// C11: 6.7p4 — a declaration may be repeated in the same scope; 6.2.2p4/p5 —
//      a re-declaration of an internal-linkage function names the SAME
//      function. Exactly the shape CPython's Argument Clinic emits: the
//      generated clinic/<file>.c.h forward-declares every `_impl` and is
//      #included near the BOTTOM of the .c file, i.e. after the definitions
//      (168 of 173 link errors on a whole-program CPython 3.13.5 build).
// EXPECT: clang-verified output below.
#include <stdio.h>

/* decl -> def (already worked; guard against regression) */
static int a(int);
static int a(int x) { return x + 1; }

/* def -> decl (the 0321 repro) */
static int b(int x) { return x + 2; }
static int b(int);

/* def -> extern decl (the todos/0219 case; must not regress) */
static int c(int x) { return x + 3; }
extern int c(int);

/* def -> no-storage-class decl (0219's 6.2.2p5 form) */
static int d(int x) { return x + 4; }
int d(int);

/* decl -> decl -> def */
static int e(int);
static int e(int);
static int e(int x) { return x + 5; }

/* def -> decl -> decl (repeated re-declarations after the definition) */
static int f(int x) { return x + 6; }
static int f(int);
static int f(int);

/* def -> decl, with the only call site AFTER the re-declaration */
static int g(int x) { return x + 7; }
static int g(int);

/* decl -> use -> decl -> def: the call binds the FIRST declaration while
   the definition's back-pointer lands on the second. */
static int h(int);
static int h_user(void) { return h(1); }
static int h(int);
static int h(int x) { return x + 8; }

int main(void)
{
    printf("%d %d %d %d %d %d %d %d\n",
           a(1), b(1), c(1), d(1), e(1), f(1), g(1), h_user());
    return 0;
}
