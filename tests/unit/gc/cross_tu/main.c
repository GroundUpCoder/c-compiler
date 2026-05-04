#include <stdio.h>

__struct Point { int x; int y; };

extern __struct Point *make_point(int a, int b);
extern int point_sum(__struct Point *p);
extern __array(int) make_seq(int n);

int main(void) {
  __struct Point *p = make_point(3, 7);
  printf("sum: %d\n", point_sum(p));   // 10

  __array(int) a = make_seq(5);
  for (int i = 0; i < __array_len(a); i++) printf("%d ", a[i]);
  printf("\n");

  // Same type from different TU is ref-eq compatible
  __struct Point *q = make_point(3, 7);
  printf("identity (same call args): %d\n", p == q);  // 0 (different objects)

  return 0;
}
