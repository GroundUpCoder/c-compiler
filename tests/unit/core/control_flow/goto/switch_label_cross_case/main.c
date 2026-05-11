/* Pattern from SQLite's sqlite3_str_vappendf:
 *
 *   switch (xtype) {
 *     case A: ...; goto shared_tail;        // forward goto
 *     case B: ...; shared_tail: ...; break; // label inside case B
 *     case C: ...; goto shared_tail;        // sibling-case goto (the
 *                                           //   target lives in a
 *                                           //   prior case's body)
 *   }
 *
 * Without the loop-switch lowering pass this is irreducible — wasm
 * blocks can't model "jump from one case body into another case body."
 * The codegen surfaces "target label not in scope" for the goto in
 * case C; the lowering then converts the function to a state machine
 * which handles it cleanly.
 *
 * Bug history: an earlier version of the switch codegen forgot to
 * clean up `openLoopLabels` between cases. The leftover entry kept
 * the goto's lookup returning a stale (too-deep) wasm block depth,
 * which silently produced a `br` with a negative delta — invalid wasm
 * that the validator caught only at instantiation time. The defensive
 * `depth > blockDepth` check in the SGoto handler catches this class
 * of bug and routes it through the lowering, but the underlying fix
 * is to actually close per-case loop labels in the SSwitch handler.
 *
 * This test exercises that path together with the lowering fallback. */
#include <stdio.h>

int dispatch(int mode, int v) {
  int r = 0;
  int flag = 1;
  if (flag > 0) {           /* outer scope adds depth so the bug shows up */
    switch (mode) {
      case 1:
        if (v > 0) { r = v + 10; }
        else       { r = v + 20; }
        goto adjust;        /* forward — label is later in switch body */
      case 2:
        if (v > 0) { r = v * 2; }
        else       { r = v * 3; }
      adjust:                /* label inside case 2's body */
        r += 100;
        break;
      case 3:
        if (v > 0) { r = v - 1; }
        else       { r = v - 2; }
        goto adjust;        /* sibling-case goto (target in case 2) */
    }
  }
  return r;
}

int main(void) {
  printf("%d\n", dispatch(1, 5));   /* (5+10)+100 = 115 */
  printf("%d\n", dispatch(2, 5));   /* (5*2)+100 = 110 */
  printf("%d\n", dispatch(3, 5));   /* (5-1)+100 = 104 */
  return 0;
}
