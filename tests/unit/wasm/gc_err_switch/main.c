__struct Foo { int x; };
int main(void) {
  __struct Foo a;
  switch (a) { default: return 0; }
}
