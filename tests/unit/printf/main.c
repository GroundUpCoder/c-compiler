#include <stdio.h>

int main() {
  // Basic string
  printf("Hello, World!\n");

  // Integer formats
  printf("Integer: %d\n", 42);
  printf("Negative: %d\n", -123);
  printf("Unsigned: %u\n", 4294967295u);
  printf("Hex: %x, %X\n", 255, 255);
  printf("Octal: %o\n", 64);

  // Character and string
  printf("Char: %c\n", 'A');
  printf("String: %s\n", "test string");

  // Width and padding
  printf("Width: [%10d]\n", 42);
  printf("Left:  [%-10d]\n", 42);
  printf("Zero:  [%010d]\n", 42);

  // Floating point
  printf("Float: %f\n", 3.14159);
  printf("Sci:   %e\n", 12345.6789);
  printf("Prec:  %.2f\n", 3.14159);

  // Multiple args
  printf("Multiple: %d + %d = %d\n", 2, 3, 5);

  // Percent literal
  printf("100%% done\n");

  // Pointer. Deliberately a FIXED pointer value, not the address of a string
  // literal: the literal's address moves whenever the libc's data segment
  // grows, so that spelling made this golden fail on every unrelated libc
  // addition while testing nothing about %p (todos/0382 tripped it). What is
  // under test here is %p's FORMATTING, which this pins exactly and stably.
  printf("Pointer: %p\n", (void *)0x1161c);

  // Test sprintf
  char buf[100];
  sprintf(buf, "Answer: %d", 42);
  printf("sprintf result: %s\n", buf);

  // Test snprintf
  char small[10];
  int n = snprintf(small, 10, "Hello, World!");
  printf("snprintf result: %s (would write %d)\n", small, n);

  return 0;
}
