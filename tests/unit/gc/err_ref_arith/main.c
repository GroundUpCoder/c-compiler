// Arithmetic / bitwise on ref types is meaningless and now rejected.
__struct Foo { int x; };
int main(void) {
  __struct Foo *p = __new(__struct Foo *, 1);
  __struct Foo *q;
  q = p + 1;
  return 0;
}
