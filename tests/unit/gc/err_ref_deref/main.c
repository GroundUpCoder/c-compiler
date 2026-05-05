// Unary `*` on a ref type is not allowed (use `->` for fields).
__struct Foo { int x; };
int main(void) {
  __struct Foo *p = __new(__struct Foo *, 42);
  __struct Foo *q = *p;
  return 0;
}
