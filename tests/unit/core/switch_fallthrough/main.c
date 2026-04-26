#include <stdio.h>

int main() {
  // Basic fallthrough
  int x = 2;
  switch (x) {
    case 1: printf("1 ");
    case 2: printf("2 ");
    case 3: printf("3 ");
    case 4: printf("4\n");
      break;
    case 5: printf("5\n"); break;
  }

  // Fallthrough from default
  switch (99) {
    default: printf("d ");
    case 1: printf("1\n"); break;
  }

  // Duff's device style: fallthrough with no body
  int total = 0;
  int val = 3;
  switch (val) {
    case 5: total += 1;
    case 4: total += 1;
    case 3: total += 1;
    case 2: total += 1;
    case 1: total += 1;
  }
  printf("total=%d\n", total);

  // Fallthrough into default
  switch (2) {
    case 1: printf("1 ");
    case 2: printf("2 ");
    default: printf("d\n"); break;
  }

  return 0;
}
