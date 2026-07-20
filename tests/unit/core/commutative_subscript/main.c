// Commutative subscripts like N[arr] are legal C (C11 6.5.2.1p2:
// E1[E2] == *(E1+E2), addition is commutative), equal to arr[N].
// Previously rejected; fixed in todos/0193.
int main() {
  int arr[3] = {10, 20, 30};
  return 1[arr];   // == arr[1] == 20
}
