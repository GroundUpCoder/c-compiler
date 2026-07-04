// BUG: a case label inside a while(0) body is unreachable-code-eliminated, so switch dispatch skips it and falls to default
// C11: 6.8.4.2p4 (a case label anywhere in the switch body is a valid jump target, even inside nested statements a la Duff's device); 6.8.6.3 (break exits the innermost while, then control falls through the default label)
// EXPECT: switch(2) jumps to case 2 inside the dead while, prints "two"; break leaves the while(0); execution falls through the default label and prints "def"; verified against native clang
#include <stdio.h>
int main(void) {
  volatile int k = 2;
  switch (k) {
    case 1: puts("one"); break;
    while (0) { case 2: puts("two"); break; }
    default: puts("def");
  }
  return 0;
}
