// Commutative subscripts like 0[arr] should be rejected.
int main() {
  int arr[3] = {10, 20, 30};
  return 1[arr];
}
