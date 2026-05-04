__struct A { int x; };
int main(void) {
  __struct A a;
  __struct A b;
  return a < b;  // relational on refs is meaningless — should error
}
