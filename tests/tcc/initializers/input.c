/* Braced initializers also failed under the goto-normalizer bug. */
struct Point { double x, y; int tag; };
struct Point origin = { 0.0, 0.0, 1 };
struct Point grid[2][2] = { { {1.0, 2.0, 3}, {4.0, 5.0, 6} },
                            { {7.0, 8.0, 9}, {10.0, 11.0, 12} } };
int arr[8] = { 1, 2, 3 };
char msg[] = "hello";
struct Nested { struct Point p; int v[4]; } n = { {1.5, 2.5, 7}, {9, 8, 7, 6} };
union U { int i; float f; char c[8]; } u = { 42 };
int sum(void) {
  int t = 0;
  for (int i = 0; i < 8; i++) t += arr[i];
  return t + origin.tag + n.v[0];
}
