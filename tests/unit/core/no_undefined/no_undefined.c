// Test that --no-undefined causes linker errors for unused undefined symbols.

int unused_function(int x);
extern int unused_var;

int main(void) {
  return 0;
}
