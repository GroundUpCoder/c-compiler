// `if (struct)` is illegal in C — the controlling expression must be
// scalar. Without the bool-context check, this previously compiled
// silently to garbage wasm.
struct S { int a; };
int main(void) {
  struct S s = {1};
  if (s) return 1;
  return 0;
}
