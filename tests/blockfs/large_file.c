/* Large-file (>4 GiB) end-to-end exercise for BLOCK_FS v4 + the 64-bit ABI.
 *
 * Driven by tests/blockfs/large_file.js (a standalone harness, NOT part of the
 * default suite — it allocates multi-GiB buffers and takes a while). It proves
 * the whole 64-bit chain works on a single file past the 2^32 boundary:
 *   - off_t / lseek across the wasm<->host i64 boundary at offsets > 4 GiB
 *   - the inode's 64-bit data_size (fstat reports the true size)
 *   - a single contiguous TLSF64 extent larger than 4 GiB
 *   - read/write returning correct bytes at offsets straddling 2^31 and 2^32
 *
 * TARGET_BYTES is injected by the harness (-D); default just over 4 GiB. Each
 * 8-byte word stores its own absolute file offset, so any read is self-verifying
 * without holding an expected copy in memory.
 */
#include <stdio.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

#ifndef TARGET_BYTES
#define TARGET_BYTES (4ULL * 1024 * 1024 * 1024 + 64ULL * 1024 * 1024)
#endif
#define CHUNK (4 * 1024 * 1024)

static unsigned char buf[CHUNK];

int main(void) {
  const char *path = "/big.bin";
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) { printf("FAIL open\n"); return 1; }

  unsigned long long total = TARGET_BYTES;

  /* Pre-grow the extent in one shot so the bulk writes stay inside it and
     never trigger a realloc (which would copy gigabytes per growth step). */
  if (ftruncate(fd, (off_t)total) != 0) { printf("FAIL ftruncate\n"); return 2; }

  /* Bulk write: each 8-byte word carries its own absolute file offset. */
  unsigned long long off = 0;
  while (off < total) {
    unsigned long long n = total - off;
    if (n > CHUNK) n = CHUNK;
    uint64_t *w = (uint64_t *)buf;
    for (unsigned long long i = 0; i < n / 8; i++) w[i] = off + i * 8;
    if (lseek(fd, (off_t)off, SEEK_SET) != (off_t)off) { printf("FAIL lseek-w %llu\n", off); return 3; }
    long wr = (long)write(fd, buf, (unsigned)n);
    if (wr != (long)n) { printf("FAIL write %llu got %ld\n", off, wr); return 4; }
    off += n;
  }

  struct stat st;
  if (fstat(fd, &st) != 0) { printf("FAIL fstat\n"); return 5; }
  printf("size %lld\n", (long long)st.st_size);
  printf("size_ok %d\n", (long long)st.st_size == (long long)total ? 1 : 0);

  /* Full sequential read-back + verify. */
  unsigned long long bad = 0;
  off = 0;
  if (lseek(fd, 0, SEEK_SET) != 0) { printf("FAIL lseek0\n"); return 6; }
  while (off < total) {
    unsigned long long n = total - off;
    if (n > CHUNK) n = CHUNK;
    long rd = (long)read(fd, buf, (unsigned)n);
    if (rd != (long)n) { printf("FAIL read %llu got %ld\n", off, rd); return 7; }
    uint64_t *r = (uint64_t *)buf;
    for (unsigned long long i = 0; i < n / 8; i++) {
      if (r[i] != off + i * 8) { bad++; if (bad <= 3) printf("MISMATCH @%llu\n", off + i * 8); }
    }
    off += n;
  }
  printf("read_verify_ok %d\n", bad == 0 ? 1 : 0);

  /* Boundary spot-checks straddling 2^31 and 2^32. */
  unsigned long long probes[3];
  probes[0] = 0x80000000ULL;          /* 2 GiB */
  probes[1] = 0x100000000ULL - 4096;  /* straddles 4 GiB */
  probes[2] = 0x100000000ULL;         /* exactly 4 GiB */
  int spot_ok = 1;
  for (int p = 0; p < 3; p++) {
    unsigned long long po = probes[p];
    if (lseek(fd, (off_t)po, SEEK_SET) != (off_t)po) { printf("FAIL lseek-probe %llu\n", po); return 8; }
    long rd = (long)read(fd, buf, 4096);
    if (rd != 4096) { printf("FAIL read-probe %llu got %ld\n", po, rd); return 9; }
    uint64_t *r = (uint64_t *)buf;
    for (int i = 0; i < 4096 / 8; i++) {
      if (r[i] != po + (unsigned long long)i * 8) { spot_ok = 0; break; }
    }
  }
  printf("spot_ok %d\n", spot_ok);

  close(fd);
  printf("DONE\n");
  return (bad == 0 && spot_ok) ? 0 : 10;
}
