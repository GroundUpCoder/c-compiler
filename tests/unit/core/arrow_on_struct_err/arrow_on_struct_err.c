// `s->a` where `s` is a non-pointer struct is illegal — `->` requires
// a pointer-to-struct. Without the gate, lookup found `a` in the
// struct's members and built an EArrow with non-pointer base, then
// codegen crashed.
struct S { int a; };
int main(void) {
  struct S s = {1};
  return s->a;
}
