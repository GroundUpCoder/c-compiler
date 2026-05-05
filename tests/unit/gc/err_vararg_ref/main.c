// Refs cannot pass through vararg storage (linear memory).
__struct Foo { int x; };
extern int printf(const char *, ...);
int main(void) {
  __struct Foo *p = __new(__struct Foo *, 1);
  printf("%p\n", p);
  return 0;
}
