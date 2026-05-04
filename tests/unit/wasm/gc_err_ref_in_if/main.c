__struct Foo { int x; };

int main(void) {
  __struct Foo a;
  if (a) return 1;
  return 0;
}
