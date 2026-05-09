// `p->a` where `p` is `int *` (not a struct pointer) is illegal —
// the pointee must be a struct/union.
int main(void) {
  int *p;
  return p->a;
}
