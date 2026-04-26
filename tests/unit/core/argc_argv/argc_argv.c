#include <stdio.h>

int main(int argc, char **argv) {
  printf("argc=%d\n", argc);
  // argv[0] is the wasm path (varies), just verify it exists
  if (argc > 0 && argv[0]) {
    printf("argv[0] is set\n");
  }
  // Print the actual user arguments
  for (int i = 1; i < argc; i++) {
    printf("argv[%d]=%s\n", i, argv[i]);
  }
  // Verify null terminator
  if (argc > 0 && argv[argc] == 0) {
    printf("argv is null-terminated\n");
  }
  return 0;
}
