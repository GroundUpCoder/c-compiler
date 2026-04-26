#include <stdio.h>

// Global arrays with explicit initialization
int g_arr[3] = {10, 20, 30};
int g_arr2[] = {1, 2, 3, 4};
int g_partial[5] = {1, 2};
int g_partial2[10] = {100, 200, 300};

// Different element sizes
char g_chars[4] = {'H', 'i', '!', 0};
short g_shorts[] = {100, 200, 300, 400};

int sum3(int a, int b, int c) { return a + b + c; }

void test_basic_init() {
  printf("=== Basic array init ===\n");
  printf("%d\n", g_arr[0]);      // 10
  printf("%d\n", g_arr[2]);      // 30
  printf("%d\n", g_arr2[3]);     // 4
  printf("%d\n", g_partial[4]);  // 0

  int arr[3] = {100, 200, 300};
  int arr2[] = {5, 6, 7};
  printf("%d\n", arr[1]);   // 200
  printf("%d\n", arr2[2]);  // 7
}

void test_expressions_and_partial() {
  printf("=== Expressions and partial init ===\n");
  printf("%d\n", g_partial2[0]);  // 100
  printf("%d\n", g_partial2[5]);  // 0
  printf("%d\n", g_partial2[9]);  // 0

  int arr[4] = {1 + 1, 2 * 2, 3 + 3, 4 * 4};
  printf("%d\n", arr[0]);  // 2
  printf("%d\n", arr[1]);  // 4
  printf("%d\n", arr[2]);  // 6
  printf("%d\n", arr[3]);  // 16

  int vals[] = {10, 20, 30};
  printf("%d\n", sum3(vals[0], vals[1], vals[2]));  // 60

  int x[] = {42};
  printf("%d\n", x[0]);  // 42
}

void test_element_sizes() {
  printf("=== Element sizes ===\n");
  printf("%d\n", g_chars[0]);   // 72 ('H')
  printf("%d\n", g_chars[1]);   // 105 ('i')
  printf("%d\n", g_chars[2]);   // 33 ('!')
  printf("%d\n", g_chars[3]);   // 0
  printf("%d\n", g_shorts[0]);  // 100
  printf("%d\n", g_shorts[3]);  // 400

  char local_chars[] = {65, 66, 67};
  printf("%d\n", local_chars[0]);  // 65
  printf("%d\n", local_chars[2]);  // 67

  short local_shorts[3] = {1000, 2000, 3000};
  printf("%d\n", local_shorts[1]);  // 2000
}

void test_local_partial() {
  printf("=== Local partial init ===\n");
  int arr[5] = {1, 2};
  printf("%d\n", arr[0]);  // 1
  printf("%d\n", arr[1]);  // 2
  printf("%d\n", arr[2]);  // 0
  printf("%d\n", arr[3]);  // 0
  printf("%d\n", arr[4]);  // 0
}

int main() {
  test_basic_init();
  test_expressions_and_partial();
  test_element_sizes();
  test_local_partial();
  return 0;
}
