/* #772 C-only ABI control. This does NOT claim Objective-C aggregate support.
 * It exercises the existing hidden-return-pointer indirect-call machinery. */
struct Pair { long long integer; double floating; };
static struct Pair combine(int n, double x) {
  struct Pair p = { 4294967296LL + n, x * 2.0 }; return p;
}
static struct Pair invoke(struct Pair (*method)(int, double), int n, double x) {
  return method(n, x);
}
int main(void) {
  struct Pair p = invoke(combine, 3, 1.25);
  return p.integer != 4294967299LL || p.floating != 2.5;
}
