// `int.foo` is illegal — `.` requires a struct/union on the left.
int main(void) {
  int x = 5;
  return x.foo;
}
