unsigned long long mix64(unsigned long long x) {
  x ^= x >> 33; x *= 0xff51afd7ed558ccdULL; x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ULL; x ^= x >> 33;
  return x;
}
long long divmod(long long a, long long b) { return a / b + a % b; }
unsigned long long shifts(unsigned long long v, int s) {
  return (v << s) | (v >> (64 - s));
}
int popcnt64(unsigned long long v) {
  int c = 0;
  while (v) { v &= v - 1; c++; }
  return c;
}
