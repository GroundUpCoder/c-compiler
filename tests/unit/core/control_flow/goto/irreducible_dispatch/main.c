/* Pattern from SQLite's VDBE: a switch over opcodes where each case
 * goto's into one of several shared "cleanup" labels outside the
 * switch. The label is structurally a sibling of the switch, but the
 * gotos are nested several scopes deep. Classic dispatch-interpreter
 * shape; impossible to express with wasm block/loop directly.
 *
 * Without the loop-switch lowering pass, the codegen produces:
 *   "target label not in scope"
 * for every goto here. This test passes only if the pass is wired up
 * and produces correct semantics for shared cleanup labels.
 */
#include <stdio.h>

int dispatch(int op, int v) {
  int result = 0;
  switch (op) {
    case 0:
      if (v < 0) goto bad;
      result = v + 1;
      goto done;
    case 1:
      if (v == 0) goto bad;
      result = v * 2;
      goto done;
    case 2: {
      int t = v - 1;
      if (t < 0) goto bad;
      result = t;
      goto done;
    }
    default:
      goto bad;
  }
bad:
  result = -1;
  goto done;
done:
  return result;
}

int main(void) {
  printf("%d\n", dispatch(0, 5));    /* 6 */
  printf("%d\n", dispatch(0, -1));   /* -1 (bad) */
  printf("%d\n", dispatch(1, 7));    /* 14 */
  printf("%d\n", dispatch(1, 0));    /* -1 (bad) */
  printf("%d\n", dispatch(2, 10));   /* 9 */
  printf("%d\n", dispatch(2, 0));    /* -1 (bad: t = -1) */
  printf("%d\n", dispatch(99, 0));   /* -1 (default → bad) */
  return 0;
}
