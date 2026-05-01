/* Compile error: cannot take address of a bit-field via arrow */
struct S { unsigned int x : 5; };
int main() {
  struct S s;
  struct S *p = &s;
  unsigned int *q = &p->x;
  return *q;
}
