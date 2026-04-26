/* Compile error: cannot take address of a bit-field via dot */
struct S { int x : 3; };
int main() {
  struct S s;
  int *p = &s.x;
  return *p;
}
