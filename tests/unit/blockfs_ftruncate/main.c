#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>

int main() {
  // Create and write
  FILE *f = fopen("/trunc.txt", "w");
  if (!f) { printf("FAIL: fopen"); return 1; }
  char data[100];
  memset(data, 'X', 100);
  fwrite(data, 1, 100, f);
  fclose(f);

  // Truncate to 30
  f = fopen("/trunc.txt", "r+");
  if (!f) { printf("FAIL: fopen r+"); return 2; }
  if (ftruncate(fileno(f), 30) != 0) { printf("FAIL: ftruncate"); return 3; }
  fclose(f);

  // Verify
  f = fopen("/trunc.txt", "r");
  char buf[100] = {0};
  int n = fread(buf, 1, 100, f);
  fclose(f);
  if (n != 30) { printf("FAIL: size=%d", n); return 4; }
  for (int i = 0; i < 30; i++) {
    if (buf[i] != 'X') { printf("FAIL: byte %d", i); return 5; }
  }
  printf("OK: ftruncate");
  return 0;
}
