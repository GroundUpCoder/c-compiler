#include <stdio.h>

// Multiple statics in one function
void multi_static(void) {
  static int a = 10;
  static int b = 20;
  printf("%d %d\n", a, b);
  a = a + 1;
  b = b + 2;
}

// Static array with init list
void static_array(void) {
  static int arr[3] = {10, 20, 30};
  printf("%d %d %d\n", arr[0], arr[1], arr[2]);
  arr[0] = arr[0] + 1;
}

// Static alongside regular local
int mixed_locals(void) {
  static int s = 0;
  int x = 5;
  s = s + x;
  return s;
}

// Two functions with same-named static
int func_a(void) {
  static int val = 0;
  val = val + 1;
  return val;
}
int func_b(void) {
  static int val = 100;
  val = val + 1;
  return val;
}

// Static string
void static_string(void) {
  static char msg[6] = "hello";
  printf("%s\n", msg);
  msg[0] = 'H';
}

// No initializer (should zero-init)
int no_init(void) {
  static int x;
  x = x + 1;
  return x;
}

// Static inside nested block
int nested_block(void) {
  if (1) {
    static int n = 0;
    n = n + 1;
    return n;
  }
  return -1;
}

// Static struct
struct Pair { int a; int b; };
struct Pair *get_pair(void) {
  static struct Pair p = {42, 99};
  return &p;
}

int main(void) {
  printf("=== multi ===\n");
  multi_static();
  multi_static();

  printf("=== array ===\n");
  static_array();
  static_array();

  printf("=== mixed ===\n");
  printf("%d\n", mixed_locals());
  printf("%d\n", mixed_locals());

  printf("=== same name ===\n");
  printf("%d %d\n", func_a(), func_b());
  printf("%d %d\n", func_a(), func_b());

  printf("=== string ===\n");
  static_string();
  static_string();

  printf("=== no init ===\n");
  printf("%d\n", no_init());
  printf("%d\n", no_init());

  printf("=== nested ===\n");
  printf("%d\n", nested_block());
  printf("%d\n", nested_block());

  printf("=== struct ===\n");
  struct Pair *pp = get_pair();
  printf("%d %d\n", pp->a, pp->b);

  return 0;
}
