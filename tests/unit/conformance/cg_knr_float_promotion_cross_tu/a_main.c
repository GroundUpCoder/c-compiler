// BUG: a K&R definition with a float parameter kept f32 in its wasm signature while calls through an empty-parens decl pushed the default-promoted f64 — "internal compiler error: emitted invalid WebAssembly: call[0] expected type f32, found f64.promote_f32"
// C11: C89 6.5.2.2p6 / 6.9.1 — calls through a declaration with no prototype apply the default argument promotions (float->double); a K&R definition's parameter ABI is in promoted terms, converted back to the declared type on entry
// EXPECT: zoom(1.5f, 2) crosses the TU boundary as double and computes 3; matches native clang -std=c89
#include <stdio.h>
double zoom();
int main(void) {
  float x = 1.5f;
  printf("%g\n", zoom(x, 2));
  return 0;
}
