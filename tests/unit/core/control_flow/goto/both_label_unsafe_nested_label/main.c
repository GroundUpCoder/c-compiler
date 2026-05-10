// BOTH label whose body contains a nested label with its own gotos.
// Inlining would duplicate the nested label, breaking single-label
// semantics. The transform must refuse.
int f(int op) {
  int x = 0;
  if (op == 1) goto outer;     // forward to outer (BOTH)
  if (op == 2) goto bar;        // forward to bar (FORWARD; closes outer's loop)
  return x;

 outer:
  x = 1;
  goto inner;                   // body contains nested goto
inner:
  x = 2;
  return x;

 bar:
  x = 3;
  goto outer;                   // backward — would need to inline `goto inner` etc.
}
int main(void) { return 0; }
