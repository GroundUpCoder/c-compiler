// BOTH label `sink` whose body does NOT terminate. A subsequent FORWARD
// label `bar` closes sink's loop scope per wasm structured-block rules.
// The inliner must refuse (sink's body falls through), and codegen
// surfaces the scope-closed error.
int classify(int op) {
  int x = 0;
  if (op == 1) goto sink;     // forward to sink (BOTH)
  if (op == 2) goto bar;       // forward to bar (FORWARD)
  return x;

 sink:
  x = 100;                     // non-terminating body — inliner refuses

 bar:                          // FORWARD label after sink — closes its loop
  x = 200;
  if (op == 3) goto sink;      // backward — FAILS to codegen
  return x;
}

int main(void) { return 0; }
