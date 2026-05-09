// `!struct` is illegal — the operand of unary ! must be scalar. Same
// rule as if/while/etc., enforced via the same predicate.
struct S { int a; };
int main(void) {
  struct S s = {0};
  return !s;
}
