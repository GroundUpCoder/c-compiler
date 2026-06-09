/* setjmp outside the recognized lowering patterns used to crash the
 * compiler with a raw JS exception; it must be a clean diagnostic. */
#include <setjmp.h>
jmp_buf buf;
int main(void) {
  int r = setjmp(buf) + 1;
  return r;
}
