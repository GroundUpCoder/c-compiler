// BUG: `DFunc.isInline` came from each declaration's OWN specifiers, so an
//      `inline` spelled only on a prototype, on a re-declaration after the
//      definition, or on a block-scope declaration never reached the
//      definition node. `fnMeta.inlineHint` stayed false and the WAST
//      inliner used calleeCap (64 nodes) instead of hintCalleeCap (256) —
//      measurably different codegen for the same function. todos/0328.
// C11: 6.7.4p1 — "a function declared with an inline function specifier is
//      an inline function"; the specifier is a property of the FUNCTION,
//      not of one declaration of it, so it accumulates across
//      re-declarations the way attributes already did (todos/0214).
//      NB this is distinct from 6.7.4p7 (whether a translation unit
//      provides an EXTERNAL definition), which requires ALL file-scope
//      declarations to carry `inline` and is decided separately.
// EXPECT: all five spellings compute the same answer. `inline` is only an
//      optimization hint, so it may never change an observable result —
//      this pins the behaviour; the hint itself is asserted in
//      tests/unit/inline_hint_propagation.js.
#include <stdio.h>

#define BODY(nm) \
  { int a=x+1,b=x+2,c=x+3,d=x+4,e=x+5; \
    a+=b; b+=c; c+=d; d+=e; e+=a; \
    a^=b; b^=c; c^=d; d^=e; e^=a; \
    a*=3; b*=5; c*=7; d*=11; e*=13; \
    a-=b; b-=c; c-=d; d-=e; e-=a; \
    a|=b; b|=c; c|=d; d|=e; e|=a; \
    a&=0xffff; b&=0xffff; c&=0xffff; d&=0xffff; e&=0xffff; \
    return a+b+c+d+e; }

/* 1. no `inline` anywhere */
static int plain(int x) BODY(plain)

/* 2. `inline` on the definition itself */
static inline int on_def(int x) BODY(on_def)

/* 3. `inline` on a prototype only */
static inline int on_proto(int x);
static int on_proto(int x) BODY(on_proto)

/* 4. `inline` on a re-declaration AFTER the definition */
static int on_tail(int x) BODY(on_tail)
static inline int on_tail(int x);

/* 5. `inline` on a block-scope declaration only (see main) */
static int on_block(int x) BODY(on_block)

/* 6. `inline` on a block-scope declaration that PRECEDES the definition —
      the declaration is out of scope again by the time the definition is
      parsed, so there is no node left to carry the specifier */
int on_fwd(int x);

static int sum(int (*f)(int)) { return f(1) + f(2) + f(3); }

int main(void) {
  inline int on_block(int);          /* block-scope declaration */
  inline int on_fwd(int);            /* …before on_fwd is defined, below */

  int a = plain(1)    + plain(2)    + plain(3);
  int b = on_def(1)   + on_def(2)   + on_def(3);
  int c = on_proto(1) + on_proto(2) + on_proto(3);
  int d = on_tail(1)  + on_tail(2)  + on_tail(3);
  int e = on_block(1) + on_block(2) + on_block(3);
  int f = on_fwd(1)   + on_fwd(2)   + on_fwd(3);

  printf("%d %d %d %d %d %d\n", a, b, c, d, e, f);
  printf("agree=%d\n", a == b && b == c && c == d && d == e && e == f);

  /* the same functions reached indirectly must agree too — an inlined
     copy must not diverge from the out-of-line body left for the table */
  printf("%d %d %d %d %d %d\n", sum(plain), sum(on_def), sum(on_proto),
         sum(on_tail), sum(on_block), sum(on_fwd));
  return 0;
}

int on_fwd(int x) BODY(on_fwd)
