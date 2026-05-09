// `int[i]` is illegal — the base must be a pointer or array. Without
// the base-indexable check, codegen would treat the int's bit-value
// as a memory address and read garbage.
int main(void) {
  int x = 5;
  return x[0];
}
