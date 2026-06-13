#include <stdio.h>
#include <string.h>

int main() {
  FILE *f = fopen("/src.txt", "w");
  fwrite("source", 1, 6, f); fclose(f);

  f = fopen("/dst.txt", "w");
  fwrite("dest-data", 1, 9, f); fclose(f);

  // Rename src over dst (overwrites)
  if (rename("/src.txt", "/dst.txt") != 0) {
    printf("FAIL: rename"); return 1;
  }

  // Old src should be gone
  f = fopen("/src.txt", "r");
  if (f) { printf("FAIL: src still exists"); return 2; }

  // New dst should have src's data
  f = fopen("/dst.txt", "r");
  if (!f) { printf("FAIL: dst gone"); return 3; }
  char buf[20] = {0};
  fread(buf, 1, 20, f); fclose(f);
  if (strcmp(buf, "source") != 0) { printf("FAIL: content=%s", buf); return 4; }

  printf("OK: rename overwrite");
  return 0;
}
