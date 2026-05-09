// `arr[p]` where p is a pointer is illegal in C — the index must be
// integer. Without the makeSubscript check, this previously compiled
// to wild memory access (codegen multiplied p's bit-value by
// sizeof(elem) and added it to arr's address).
int main(void) {
  int arr[3] = {10, 20, 30};
  int *p = arr;
  return arr[p];
}
