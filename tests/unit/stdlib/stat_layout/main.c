#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <stddef.h>

/* Pins the 64-bit struct stat ABI: sizeof + field offsets must match host.js's
   three writeStatBuf implementations exactly, and a functional stat() round-trip
   proves the wide fields (size, times) are read back at the right offsets — a
   wrong offset garbles size or time. */
int main(void) {
  printf("sizeof %d\n", (int)sizeof(struct stat));
  printf("off size=%d blocks=%d atime=%d mtime=%d ctime=%d\n",
    (int)offsetof(struct stat, st_size), (int)offsetof(struct stat, st_blocks),
    (int)offsetof(struct stat, st_atime), (int)offsetof(struct stat, st_mtime),
    (int)offsetof(struct stat, st_ctime));
  printf("off mtim.sec=%d mtim.nsec=%d\n",
    (int)(offsetof(struct stat, st_mtim) + offsetof(struct timespec, tv_sec)),
    (int)(offsetof(struct stat, st_mtim) + offsetof(struct timespec, tv_nsec)));

  FILE *f = fopen("/data.bin", "w");
  if (!f) { printf("FAIL fopen\n"); return 1; }
  fwrite("hello, 64-bit world!", 1, 20, f);
  fclose(f);

  struct stat st;
  if (stat("/data.bin", &st) != 0) { printf("FAIL stat\n"); return 2; }
  printf("size %lld\n", (long long)st.st_size);
  printf("isreg %d\n", S_ISREG(st.st_mode) ? 1 : 0);
  printf("mtime_ok %d\n", st.st_mtime > 0 ? 1 : 0);
  printf("mtim_sec_eq %d\n", (st.st_mtim.tv_sec == st.st_mtime) ? 1 : 0);
  /* nsec is 0 on v3 (second-granularity) and may be nonzero on v4 (ms); either
     way it must be a valid nanosecond fraction. */
  printf("nsec_ok %d\n", (st.st_mtim.tv_nsec >= 0 && st.st_mtim.tv_nsec < 1000000000L) ? 1 : 0);
  printf("blksize %ld\n", (long)st.st_blksize);
  return 0;
}
