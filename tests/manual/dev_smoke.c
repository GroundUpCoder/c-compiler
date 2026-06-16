/* End-to-end /dev exercise: a real C program using the v4 character devices
 * through the full libc + wasm syscall path. Driven by tests/manual/dev_smoke.js.
 *
 * Lives in tests/manual/ rather than tests/unit/ because /dev only exists on a
 * v4 BLOCK_FS mount (the C-level unit harness also runs on v3, and run.py uses
 * the host Node fs where "/dev/*" would hit the real OS) — so it needs a v4
 * mount set up explicitly, which the harness does.
 */
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>

int main(void) {
  struct stat st;

  /* /dev/zero is a character device with the expected device number. */
  if (stat("/dev/zero", &st) != 0) { printf("FAIL stat /dev/zero\n"); return 1; }
  printf("zero_ischr %d\n", S_ISCHR(st.st_mode) ? 1 : 0);
  printf("zero_dev %d:%d\n", major(st.st_rdev), minor(st.st_rdev));

  /* Read from /dev/zero → all zero bytes. */
  int z = open("/dev/zero", O_RDONLY);
  if (z < 0) { printf("FAIL open /dev/zero\n"); return 2; }
  unsigned char b[64];
  memset(b, 0xAB, sizeof b);
  ssize_t n = read(z, b, sizeof b);
  int all_zero = (n == (ssize_t)sizeof b);
  for (size_t i = 0; i < sizeof b; i++) if (b[i] != 0) all_zero = 0;
  printf("zero_read_ok %d\n", all_zero);
  close(z);

  /* Write to /dev/null → swallowed, returns the full count. */
  int nul = open("/dev/null", O_WRONLY);
  if (nul < 0) { printf("FAIL open /dev/null\n"); return 3; }
  ssize_t w = write(nul, "discard me", 10);
  printf("null_write %d\n", w == 10 ? 1 : 0);
  /* And /dev/null reads as immediate EOF. */
  ssize_t re = read(open("/dev/null", O_RDONLY), b, sizeof b);
  printf("null_eof %d\n", re == 0 ? 1 : 0);
  close(nul);

  /* /dev/urandom yields varied bytes. */
  int r = open("/dev/urandom", O_RDONLY);
  if (r < 0) { printf("FAIL open /dev/urandom\n"); return 4; }
  unsigned char rb[256];
  memset(rb, 0, sizeof rb);
  read(r, rb, sizeof rb);
  int nonzero = 0;
  for (size_t i = 0; i < sizeof rb; i++) if (rb[i] != 0) nonzero++;
  printf("urandom_varied %d\n", nonzero > 0 ? 1 : 0);
  close(r);

  printf("DONE\n");
  return 0;
}
