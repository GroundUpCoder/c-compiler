#include <stdio.h>

// static 'x' with internal linkage
static int x = 10;

void set_x(int val);

// Uses the file-scope static x
void print_static_x() {
  printf("%d\n", x);
}

// C11 6.2.2p4: the file-scope static x is VISIBLE here, so this
// block-scope extern inherits its internal linkage and denotes that same
// static object — it does NOT reach helper.c's external-linkage x
// (clang-verified; the pre-todos/0219 golden encoded the opposite).
void print_extern_x() {
  extern int x;
  printf("%d\n", x);
}

int main() {
  // Both name the internal x = 10.
  print_static_x();
  print_extern_x();

  // set_x mutates helper.c's own external x — a DIFFERENT object; the
  // internal x is untouched.
  set_x(77);
  print_static_x();
  print_extern_x();

  // Mutate the static x directly
  x = 55;
  print_static_x();
  print_extern_x();

  return 0;
}
