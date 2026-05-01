#include <stdio.h>

// Multiple functions each independently declare 'extern int counter'
// and all must resolve to the same definition in helper.c

void increment() {
  extern int counter;
  counter++;
}

void add_ten() {
  extern int counter;
  counter += 10;
}

int read_counter() {
  extern int counter;
  return counter;
}

int main() {
  printf("%d\n", read_counter());
  increment();
  printf("%d\n", read_counter());
  add_ten();
  printf("%d\n", read_counter());
  increment();
  increment();
  printf("%d\n", read_counter());
  return 0;
}
