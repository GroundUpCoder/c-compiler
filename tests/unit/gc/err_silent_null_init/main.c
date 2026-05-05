// __new of a struct with a non-eqref ref field, passing a non-zero int as
// initializer, used to silently null the field. Now rejected.
__struct Item { int n; };
__struct Bag { __struct Item *item; };
int main(void) {
  __struct Bag *b = __new(__struct Bag *, 42);
  return 0;
}
