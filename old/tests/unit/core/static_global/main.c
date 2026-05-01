#include <stdio.h>

static int counter = 0;
static int data[3] = {10, 20, 30};

static void increment() {
  counter++;
}

static int get_counter() {
  return counter;
}

int main() {
  printf("%d\n", get_counter());
  increment();
  increment();
  increment();
  printf("%d\n", get_counter());

  // Static global array
  printf("%d %d %d\n", data[0], data[1], data[2]);

  // Modify static global
  data[1] = 99;
  printf("%d\n", data[1]);

  return 0;
}
