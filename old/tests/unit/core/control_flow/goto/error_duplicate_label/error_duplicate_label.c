// Rule 4: No duplicate labels in the same function
int main() {
  goto target;
target:
  return 0;
target:
  return 1;
}
