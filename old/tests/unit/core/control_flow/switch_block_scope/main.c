#include <stdio.h>

int main() {
  // Block-scoped variables in switch case
  int val = 2;
  switch (val) {
    case 1: {
      int x = 10;
      printf("%d\n", x);
      break;
    }
    case 2: {
      int x = 20;
      printf("%d\n", x);
      break;
    }
    case 3: {
      int x = 30;
      printf("%d\n", x);
      break;
    }
  }
  return 0;
}
