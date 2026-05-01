#include <stdio.h>

int gx = 10;
int gy = 100;

void modify_via_ptr(int x) {
  int *p = &x;
  *p = 99;
  printf("x inside function after *p = 99: %d (expected 99)\n", x);
}

void double_value(int n) {
  int *pn = &n;
  *pn = *pn * 2;
  printf("n doubled: %d\n", n);
}

void test_param_address() {
  printf("=== Address of parameters ===\n");
  modify_via_ptr(42);
  double_value(50);
}

void test_local_address() {
  printf("=== Address of local scalars ===\n");
  int x = 10;
  int *p = &x;
  *p = 20;
  printf("x after *p = 20: %d (expected 20)\n", x);

  int y = 100;
  int *q = &y;
  *q += 5;
  printf("y after *q += 5: %d (expected 105)\n", y);

  int a = 1;
  int b = 2;
  int *pa = &a;
  int *pb = &b;
  *pa = *pb;
  printf("a after *pa = *pb: %d (expected 2)\n", a);
}

void test_global_address() {
  printf("=== Address of global scalars ===\n");
  int *p = &gx;
  printf("gx initial: %d (expected 10)\n", gx);
  printf("*p initial: %d (expected 10)\n", *p);

  *p = 20;
  printf("gx after *p = 20: %d (expected 20)\n", gx);

  int *q = &gy;
  *q += 5;
  printf("gy after *q += 5: %d (expected 105)\n", gy);

  *p = *q;
  printf("gx after *p = *q: %d (expected 105)\n", gx);
}

int main() {
  test_param_address();
  test_local_address();
  test_global_address();
  return 0;
}
