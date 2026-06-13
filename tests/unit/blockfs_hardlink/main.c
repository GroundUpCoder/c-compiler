#include <stdio.h>
#include <unistd.h>
#include <string.h>

int main() {
  FILE *f = fopen("/orig.txt", "w");
  fwrite("hardlink test", 1, 13, f);
  fclose(f);

  if (link("/orig.txt", "/alias.txt") != 0) {
    printf("FAIL: link"); return 1;
  }

  // Both paths should read the same data
  f = fopen("/orig.txt", "r");
  char b1[20] = {0}; fread(b1, 1, 20, f); fclose(f);

  f = fopen("/alias.txt", "r");
  char b2[20] = {0}; fread(b2, 1, 20, f); fclose(f);

  if (strcmp(b1, b2) != 0) { printf("FAIL: mismatch"); return 2; }
  if (strcmp(b1, "hardlink test") != 0) { printf("FAIL: content"); return 3; }

  // Deleting the original should leave the alias intact
  unlink("/orig.txt");
  f = fopen("/alias.txt", "r");
  if (!f) { printf("FAIL: alias should survive"); return 4; }
  fclose(f);

  printf("OK: hardlink");
  return 0;
}
