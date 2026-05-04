// Note: structurally tagged — matches main.c's __struct Point shape, so the
// cross-TU link unifies them to one WASM type.
__struct Point { int x; int y; };

__struct Point *make_point(int a, int b) {
  return __new(__struct Point *, a, b);
}

int point_sum(__struct Point *p) {
  return p->x + p->y;
}

__array(int) make_seq(int n) {
  __array(int) a = __new(__array(int), n);
  for (int i = 0; i < n; i++) a[i] = (i + 1) * 10;
  return a;
}
