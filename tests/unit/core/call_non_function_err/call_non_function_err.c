// Calling a non-function value is illegal — `callee()` requires
// `callee` to be a function or function-pointer (after decay).
int main(void) {
  int x = 5;
  return x();
}
