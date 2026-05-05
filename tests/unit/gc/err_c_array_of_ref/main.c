// C arrays of GC ref types are not allowed — refs live on the GC heap, not
// in linear memory.
__struct Foo { int x; };
int main(void) {
  __struct Foo *arr[10];
  return 0;
}
