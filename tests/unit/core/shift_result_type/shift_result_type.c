// Test that left-shift result type is the promoted left operand type,
// NOT the usual arithmetic conversion of both operands.
// C99 6.5.7#3: "The integer promotions are performed on each of the
// operands. The type of the result is that of the promoted left operand."
#include <stdio.h>

// Returns -sizeof(type) for signed, +sizeof(type) for unsigned,
// using the promoted type of M (via +0).
#define PTYPE(M) ((M) < 0 || -(M) < 0 ? -1 : 1) * (int) sizeof((M)+0)

static int nfailed = 0;

static void check(const char *desc, int expected, int actual) {
  if (expected != actual) {
    printf("FAIL: %s: expected %d, got %d\n", desc, expected, actual);
    nfailed++;
  }
}

int main() {
  // short promotes to int (signed, 4 bytes) => PTYPE = -4
  // Shift result should also be int regardless of right operand type
  short s = 1;
  check("short << short",        -4, PTYPE(s << (short)1));
  check("short << unsigned short",-4, PTYPE(s << (unsigned short)1));
  check("short << int",          -4, PTYPE(s << (int)1));
  check("short << unsigned int", -4, PTYPE(s << (unsigned int)1));
  check("short << long",         -4, PTYPE(s << (long)1));
  check("short << unsigned long",-4, PTYPE(s << (unsigned long)1));

  // int (signed, 4 bytes) => PTYPE = -4
  int i = 1;
  check("int << short",          -4, PTYPE(i << (short)1));
  check("int << unsigned int",   -4, PTYPE(i << (unsigned int)1));
  check("int << long",           -4, PTYPE(i << (long)1));
  check("int << unsigned long",  -4, PTYPE(i << (unsigned long)1));
  check("int << long long",      -4, PTYPE(i << (long long)1));

  // unsigned int (unsigned, 4 bytes) => PTYPE = 4
  unsigned int ui = 1;
  check("uint << short",          4, PTYPE(ui << (short)1));
  check("uint << int",            4, PTYPE(ui << (int)1));
  check("uint << long long",      4, PTYPE(ui << (long long)1));

  // long long (signed, 8 bytes) => PTYPE = -8
  long long ll = 1;
  check("llong << short",        -8, PTYPE(ll << (short)1));
  check("llong << int",          -8, PTYPE(ll << (int)1));
  check("llong << unsigned int", -8, PTYPE(ll << (unsigned int)1));

  // unsigned long long (unsigned, 8 bytes) => PTYPE = 8
  unsigned long long ull = 1;
  check("ullong << short",        8, PTYPE(ull << (short)1));
  check("ullong << int",          8, PTYPE(ull << (int)1));

  if (nfailed == 0) {
    printf("all shift type tests passed\n");
  } else {
    printf("%d shift type test(s) failed\n", nfailed);
  }
  return nfailed != 0;
}
