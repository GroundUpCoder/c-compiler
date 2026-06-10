/* C99 6.10.3.3p4 example: the space before a pasted ## token must
 * survive stringization ("x ## y", not "x## y"). */
#include <stdio.h>

#define hash_hash # ## #
#define mkstr(a) #a
#define in_between(a) mkstr(a)
#define join(c, d) in_between(c hash_hash d)

int main(void) {
  printf("%s\n", join(x, y));
  return 0;
}
