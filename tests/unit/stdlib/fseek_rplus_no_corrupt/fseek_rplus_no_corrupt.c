/* Regression: fseek on an "r+b" stream must not flush stale read-buffer
 * data back to the file.
 *
 * Bug: when fopen mode included write access (r+, w+, a+, or any +b
 * variant), fread filled the FILE's internal buffer with on-disk data,
 * then fseek's pre-flush saw __F_WRITE | (buf_pos > 0) and wrote that
 * buffer to the file at the *current* FD position — overwriting the
 * sector(s) immediately after the just-read range. Subsequent reads
 * returned the corrupted bytes.
 *
 * Real-world impact: tinyemu's virtio_blk driver opens its disk image
 * in r+b for read-modify-write of sectors. The bug corrupted every
 * read with the previous sector's content, so ext2 group descriptors
 * mounted as superblock bytes and Linux panicked at root mount.
 *
 * The repro carefully picks region sizes so the corruption lands in
 * a DIFFERENT region than the one whose bytes are in the read buffer:
 *
 *   - Each region is 256 bytes (smaller than BUFSIZ).
 *   - File holds 8 regions = 2048 bytes total (> BUFSIZ = 1024).
 *   - fread(16) from offset 0 fills the FILE buffer with bytes 0..1023
 *     (regions 1..4), consumes 16, leaves buf_pos = 16.
 *     The host's underlying fd position is now at 1024.
 *   - The buggy fseek's flush would then write buf[0..15] (sixteen
 *     0x01 bytes) at fd position 1024 — the start of region 5,
 *     replacing 0x05 with 0x01. */
#include <stdio.h>
#include <string.h>

#define REGION_BYTES 256
#define NUM_REGIONS 8

int main(void) {
  const char *path = TEST_TMPDIR "fseek_rplus.bin";

  /* Build a 2 KB file with 8 distinct 256-byte regions; each is filled
   * with its 1-based region number so we can tell which bytes ended
   * up where. */
  FILE *f = fopen(path, "wb");
  if (!f) { puts("setup: fopen wb failed"); return 1; }
  unsigned char region[REGION_BYTES];
  for (int r = 1; r <= NUM_REGIONS; r++) {
    memset(region, r, REGION_BYTES);
    fwrite(region, 1, REGION_BYTES, f);
  }
  fclose(f);

  /* Reopen in r+b — same mode tinyemu uses for virtio_blk. */
  f = fopen(path, "r+b");
  if (!f) { puts("fopen r+b failed"); return 1; }

  unsigned char buf[16];

  /* Read the first 16 bytes of region 1. The internal buffer fills
   * with the first BUFSIZ bytes of the file but fread consumes only
   * 16, leaving buf_pos = 16. The underlying fd position is now at
   * BUFSIZ (one full buffer past offset 0). */
  fseek(f, 0, SEEK_SET);
  fread(buf, 1, 16, f);
  printf("region1: 0x%02x (want 0x01)\n", buf[0]);

  /* Seek to region 7 and read. With the bug, fseek's pre-flush would
   * write region 1's bytes back at the current fd position (offset
   * 1024 = start of region 5 in this layout), clobbering region 5. */
  fseek(f, 6 * REGION_BYTES, SEEK_SET);
  fread(buf, 1, 16, f);
  printf("region7: 0x%02x (want 0x07)\n", buf[0]);

  fclose(f);

  /* Re-open read-only and verify every region's first byte. With the
   * bug, region 5 (offset 1024) shows 0x01 instead of 0x05. */
  f = fopen(path, "rb");
  if (!f) { puts("verify: fopen rb failed"); return 1; }
  for (int r = 1; r <= NUM_REGIONS; r++) {
    unsigned char first;
    fseek(f, (r - 1) * REGION_BYTES, SEEK_SET);
    fread(&first, 1, 1, f);
    printf("on-disk region%d: 0x%02x\n", r, first);
  }
  fclose(f);

  return 0;
}
