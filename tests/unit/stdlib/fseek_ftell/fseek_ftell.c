#include <stdio.h>
#include <string.h>

int main() {
  const char *path = TEST_TMPDIR "fseek_ftell.txt";

  /* Write known data */
  FILE *f = fopen(path, "w");
  if (!f) { printf("fopen write failed\n"); return 1; }
  fwrite("ABCDEFGHIJ", 1, 10, f);
  fclose(f);

  /* Open for reading and test seek/tell */
  f = fopen(path, "r");
  if (!f) { printf("fopen read failed\n"); return 1; }

  /* Read first 3 bytes */
  char buf[16];
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, 3, f);
  printf("first3: %s\n", buf);

  /* ftell should be at 3 */
  long pos = ftell(f);
  printf("pos after 3: %ld\n", pos);

  /* Seek to offset 5 from start */
  fseek(f, 5, SEEK_SET);
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, 3, f);
  printf("at5: %s\n", buf);

  /* Seek back 2 from current */
  fseek(f, -2, SEEK_CUR);
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, 2, f);
  printf("back2: %s\n", buf);

  /* Seek from end */
  fseek(f, -4, SEEK_END);
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, 4, f);
  printf("last4: %s\n", buf);

  /* rewind */
  rewind(f);
  pos = ftell(f);
  printf("after rewind: %ld\n", pos);
  memset(buf, 0, sizeof(buf));
  fread(buf, 1, 2, f);
  printf("rewind read: %s\n", buf);

  fclose(f);
  return 0;
}
