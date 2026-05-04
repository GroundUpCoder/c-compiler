int main(void) {
  __eqref e = 42;
  e += 5;   // compound assignment has no meaning on a ref type
  return 0;
}
