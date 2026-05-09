// Exercises every C99 array/function decay context the parser inserts
// EDecay at, plus the no-decay contexts (sizeof, &, string-literal init).

#include <stdio.h>

int sum2(int *p, int n) { int s = 0; for (int i = 0; i < n; i++) s += p[i]; return s; }
int first(int (*fn)(int *, int), int *arr, int n) { return fn(arr, n); }

int g_int_arr[4] = {10, 20, 30, 40};
char g_str[] = "hello";

int main(void) {
  int arr[5] = {1, 2, 3, 4, 5};

  // --- decay site: subscript array operand ---
  printf("subscript: %d\n", arr[2]);                       // 3

  // --- decay site: pointer arithmetic ---
  printf("p+i: %d\n", *(arr + 3));                         // 4
  printf("i+p: %d\n", *(2 + arr));                         // 3
  int *end = arr + 5;
  printf("p-arr: %d\n", (int)(end - arr));                 // 5
  printf("p-i: %d\n", *(end - 1));                         // 5

  // --- decay site: dereference *arr ---
  printf("*arr: %d\n", *arr);                              // 1

  // --- decay site: comparison operands ---
  printf("arr == &arr[0]: %d\n", arr == &arr[0]);          // 1
  int *q = arr;
  printf("q == arr: %d\n", q == arr);                      // 1

  // --- decay site: ternary branches ---
  int *t = (1 ? arr : g_int_arr);
  printf("ternary: %d\n", t[1]);                           // 2
  int *t2 = (0 ? arr : g_int_arr);
  printf("ternary2: %d\n", t2[1]);                         // 20

  // --- decay site: cast operand ---
  char *cp = (char *)arr;
  printf("cast: %d\n", (int)(cp != 0));                    // 1

  // --- decay site: initialization of pointer from array ---
  int *p_init = arr;
  printf("init: %d\n", p_init[0]);                         // 1

  // --- decay site: assignment rhs ---
  int *p_asn;
  p_asn = arr;
  printf("assign: %d\n", p_asn[4]);                        // 5

  // --- decay site: call argument ---
  printf("arg: %d\n", sum2(arr, 5));                       // 15

  // --- decay site: function callee (function-to-pointer decay) ---
  // Plain `sum2(...)` already works; `(&sum2)(...)` and `(*sum2)(...)`
  // exercise the decay round-trip.
  printf("(&fn)(args): %d\n", (&sum2)(arr, 5));            // 15
  printf("(*fn)(args): %d\n", (*sum2)(arr, 5));            // 15

  // --- decay site: function passed as argument ---
  printf("fn-arg: %d\n", first(sum2, arr, 5));             // 15

  // --- decay site: return (returning a global array as pointer) ---
  // (Indirectly: g_int_arr decays when used in expressions below.)
  int *gp = g_int_arr;
  printf("global-init: %d %d\n", gp[0], gp[3]);            // 10 40

  // --- NO-decay: sizeof(arr) gives full array size, not pointer size ---
  printf("sizeof(arr): %d\n", (int)sizeof(arr));           // 20
  printf("sizeof(arr)/sizeof(arr[0]): %d\n", (int)(sizeof(arr) / sizeof(arr[0]))); // 5

  // --- NO-decay: &arr is "pointer to array", not "pointer to pointer" ---
  int (*pa)[5] = &arr;
  printf("(*pa)[3]: %d\n", (*pa)[3]);                      // 4

  // --- NO-decay: string literal init for char[] copies the bytes ---
  char buf[] = "world";
  printf("buf: %s sz=%d\n", buf, (int)sizeof(buf));         // world sz=6

  // --- string used elsewhere DOES decay (passed to printf) ---
  printf("g_str: %s\n", g_str);                            // hello

  // --- multi-dim array decay: int a[3][4] decays to int (*)[4] ---
  int m[2][3] = {{1,2,3},{4,5,6}};
  int (*row)[3] = m;        // m decays to pointer-to-array
  printf("multidim: %d %d\n", row[0][2], row[1][0]);       // 3 4

  printf("PASS\n");
  return 0;
}
