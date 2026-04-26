// Rule 1: Cannot jump into a nested block
int main() {
  goto inside;
  {
inside:
    return 0;
  }
}
