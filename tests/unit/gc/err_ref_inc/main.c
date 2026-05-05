// Increment / decrement on ref types is not allowed.
__struct Foo { int x; };
int main(void) {
  __struct Foo *p = __struct_new(Foo, 1);
  p++;
  return 0;
}
