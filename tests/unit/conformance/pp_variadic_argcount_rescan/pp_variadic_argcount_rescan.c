// BUG: a function-like macro NAME produced by an inner (count-dispatch)
//      expansion is NOT re-scanned when its ( … ) argument list comes from the
//      SAME replacement list, so SUM(...) mis-expands to a literal `SUM_N (
//      args )` — the selector token SUM_N is never re-invoked — and the
//      program fails to compile (SUM_N is not a real function).
// C11: 6.10.3.4 — the fully expanded replacement list is rescanned for further
//      macro names, including function-like invocations formed only during that
//      expansion. This is jq's JV_ARRAY / JV_OBJECT / BLOCK variadic
//      arg-count dispatch idiom (IDX(__VA_ARGS__, NAME_N, …)(__VA_ARGS__)).
// EXPECT: SUM(10)=11, SUM(10,20)=32, SUM(10,20,30)=63.
#include <stdio.h>

#define SUM_1(a)     ((a) + 1)
#define SUM_2(a,b)   ((a) + (b) + 2)
#define SUM_3(a,b,c) ((a) + (b) + (c) + 3)
#define SUM_IDX(_1,_2,_3,NAME,...) NAME
#define SUM(...) SUM_IDX(__VA_ARGS__, SUM_3, SUM_2, SUM_1, dummy)(__VA_ARGS__)

int main(void) {
  printf("%d %d %d\n", SUM(10), SUM(10, 20), SUM(10, 20, 30));
  return 0;
}
