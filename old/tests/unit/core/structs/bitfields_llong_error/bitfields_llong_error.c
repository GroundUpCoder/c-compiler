/* Compile error: long long bit-fields are not supported */
struct S { long long x : 10; };
int main() {
  struct S s;
  s.x = 5;
  return s.x;
}
