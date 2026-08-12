// BUG: a function-like macro invoked with too many arguments silently
//      DROPPED the extras — M(1,2,3,4) expanded as M(1,2,3) (#642).
// C11: 6.10.3p4 (constraint) — the number of arguments shall equal the
//      number of parameters, unless the definition ends in `...`. A
//      variadic macro absorbs extras into __VA_ARGS__; a fixed-arity one
//      must diagnose them. Also covers extras on a zero-parameter macro.
// EXPECT: compile error (exit 1).
#define M(a,b,c) ((a) + (b) + (c))
#define Z() 5

int main(void) {
  int x = M(1, 2, 3, 4);
  int y = Z(1);
  return x + y;
}
