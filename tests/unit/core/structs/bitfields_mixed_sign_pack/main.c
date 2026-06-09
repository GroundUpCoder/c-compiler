/* Regression: a signedness change between adjacent bitfields started a
 * new storage unit, inflating struct {int a:3; unsigned b:3; ...} to
 * 16 bytes where every major ABI (and clang) packs it into 4. */
#include <stdio.h>
#include <string.h>

struct B1 { int a:3; unsigned b:3; int c:17; unsigned d:9; };
struct B5 { unsigned a:3; int b:17; };
struct B7 { long long a:5; unsigned long long b:40; signed long long c:19; };

int main(void) {
  printf("%zu %zu %zu\n", sizeof(struct B1), sizeof(struct B5), sizeof(struct B7));

  struct B1 x;
  memset(&x, 0, sizeof x);
  x.a = -2; x.b = 5; x.c = -12345; x.d = 300;
  unsigned char raw[sizeof x];
  memcpy(raw, &x, sizeof x);
  for (size_t i = 0; i < sizeof x; i++) printf("%02x ", raw[i]);
  printf("\n");
  printf("%d %u %d %u\n", x.a, x.b, x.c, x.d);

  struct B7 y;
  memset(&y, 0, sizeof y);
  y.a = -7; y.b = 0x123456789AULL; y.c = -98765;
  unsigned char raw7[sizeof y];
  memcpy(raw7, &y, sizeof y);
  for (size_t i = 0; i < sizeof y; i++) printf("%02x ", raw7[i]);
  printf("\n");
  printf("%lld %llu %lld\n", y.a, y.b, y.c);
  return 0;
}
