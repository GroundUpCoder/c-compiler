#include <stdio.h>

/* Exercises fgetpos/fsetpos (now 64-bit fpos_t, routed through lseek) and pins
   that they round-trip a mid-file position across buffered reads. */
int main(void) {
  printf("sizeof_fpos_t: %d\n", (int)sizeof(fpos_t));

  FILE *f = fopen("/fpos.bin", "w+b");
  if (!f) { printf("FAIL fopen\n"); return 1; }
  fputs("0123456789ABCDEF", f);   /* 16 bytes */
  rewind(f);

  /* Read 4 bytes, then snapshot the position. */
  char a[4];
  fread(a, 1, 4, f);
  fpos_t pos;
  if (fgetpos(f, &pos) != 0) { printf("FAIL fgetpos\n"); return 2; }
  printf("pos_after_4: %lld\n", (long long)pos);

  /* Read 4 more (now at 8), then restore to the snapshot (4). */
  char b[4];
  fread(b, 1, 4, f);
  if (fsetpos(f, &pos) != 0) { printf("FAIL fsetpos\n"); return 3; }

  /* Reading from the restored position must yield bytes 4..7 again. */
  char c[5] = {0};
  fread(c, 1, 4, f);
  printf("restored_read: %s\n", c);

  fclose(f);
  return 0;
}
