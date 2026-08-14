// BUG: __builtin_bswap16/32/64 were preprocessor macros in the builtin
//      prelude, substituting the argument text 2/4/8 times —
//      __builtin_bswap32(i++) left i == 4 (#680, promoted from the #12
//      triage, 0087 gap 7). GCC documents them as builtin FUNCTIONS; a
//      function call evaluates its argument exactly once.
// C11: n/a (GNU extension). Governing contract: GCC "Other Built-in
//      Functions" — uint16_t __builtin_bswap16(uint16_t) etc., "Returns x
//      with the order of the bytes reversed".
// EXPECT: the argument evaluates ONCE at every width (evals 1 1 1); values
//      stay correct for runtime operands (codegen path) and constant
//      operands; the argument converts to the uintN_t parameter type
//      (wide int -> u16 truncation, negative int sign-extends to u64);
//      constant operands still fold as an INTEGER CONSTANT EXPRESSION —
//      enum value, array bound, static initializer, case label (the ICE
//      regression guard: the old macros folded, the builtin must too).
#include <stdio.h>

enum { K = __builtin_bswap32(0x01000000u) };  /* ICE: enum value == 1 */
static char bound[__builtin_bswap16(0x0200)]; /* ICE: array bound == 2 */
unsigned g32 = __builtin_bswap32(0x11223344u);          /* static init */
unsigned long long g64 = __builtin_bswap64(0x1122334455667788ull);

int main(void) {
  int i = 0;
  unsigned short r16 = __builtin_bswap16(i++);
  int c16 = i;
  i = 0;
  unsigned r32 = __builtin_bswap32(i++);
  int c32 = i;
  i = 0;
  unsigned long long r64 = __builtin_bswap64((unsigned long long)(i++));
  int c64 = i;
  printf("evals %d %d %d\n", c16, c32, c64);
  printf("zero %u %u %llu\n", (unsigned)r16, r32, r64);

  volatile unsigned short v16 = 0x1122;
  volatile unsigned v32 = 0x11223344u;
  volatile unsigned long long v64 = 0x1122334455667788ull;
  volatile int neg = -1;
  volatile int wide = 0x123456;
  printf("run %x %x %llx\n", __builtin_bswap16(v16),
         __builtin_bswap32(v32), __builtin_bswap64(v64));
  printf("conv %x %x %llx\n", __builtin_bswap16(wide),
         __builtin_bswap32(neg), __builtin_bswap64(neg));
  printf("ice %d %d %u %llx\n", K, (int)sizeof(bound), g32, g64);
  switch (v32 & 0u) {
    case __builtin_bswap32(0u): printf("case ok\n"); break;
    default: printf("case BAD\n"); break;
  }
  return 0;
}
