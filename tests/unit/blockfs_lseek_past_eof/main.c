#include <stdio.h>

int main() {
  FILE *f = fopen("/seek.txt", "w+");
  if (!f) { printf("FAIL: fopen"); return 1; }

  // Write 5 bytes
  fwrite("hello", 1, 5, f);

  // Seek past EOF
  if (fseek(f, 100, SEEK_SET) != 0) { printf("FAIL: fseek"); return 2; }
  long pos = ftell(f);
  if (pos != 100) { printf("FAIL: pos=%ld", pos); return 3; }

  // Write at the new position — extends the file
  fwrite("world", 1, 5, f);
  fclose(f);

  // Verify total size
  f = fopen("/seek.txt", "r");
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  if (size != 105) { printf("FAIL: size=%ld", size); return 4; }
  fclose(f);

  printf("OK: lseek past eof");
  return 0;
}
