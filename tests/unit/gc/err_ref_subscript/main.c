// Subscript on a struct ref is not allowed (use __array(T) instead).
__struct Foo { int x; };
int main(void) {
  __struct Foo *p = __new(__struct Foo *, 1);
  int x = p[0];
  return 0;
}
