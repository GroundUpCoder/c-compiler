#include <stdio.h>

// C99: static in array parameter declaration
void print_first(int arr[static 1]) {
  printf("%d\n", arr[0]);
}

// C99: const qualifier in array parameter
void print_sum(const int arr[const 3], int n) {
  int sum = 0;
  for (int i = 0; i < n; i++) sum += arr[i];
  printf("%d\n", sum);
}

int main(void) {
  int a[] = {10, 20, 30};
  print_first(a);
  print_sum(a, 3);
  return 0;
}
