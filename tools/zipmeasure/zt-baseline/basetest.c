/* baseline for the 0350 measurement — the frontend-ish overhead WITHOUT any
 * archive library: stdio + malloc + zlib deflate/inflate round-trip. Both
 * ziptest flavors link exactly this substrate (libc runtime + zlib), so
 * lib-attributable size = ziptest.wasm - basetest.wasm. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define BLOB_N 4096

static unsigned char blob[BLOB_N];

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : "/tmp/basetest.bin";
    unsigned s = 12345;
    for (int i = 0; i < BLOB_N; i++) { s = s * 1103515245 + 12345; blob[i] = (unsigned char)(s >> 16); }

    uLongf zn = compressBound(BLOB_N);
    unsigned char *zbuf = malloc(zn);
    if (compress2(zbuf, &zn, blob, BLOB_N, 9) != Z_OK) { fprintf(stderr, "compress failed\n"); return 1; }

    FILE *f = fopen(path, "wb");
    if (!f || fwrite(zbuf, 1, zn, f) != zn) { fprintf(stderr, "write failed\n"); return 1; }
    fclose(f);

    f = fopen(path, "rb");
    unsigned char *rbuf = malloc(zn);
    if (!f || fread(rbuf, 1, zn, f) != zn) { fprintf(stderr, "read failed\n"); return 1; }
    fclose(f);

    unsigned char *out = malloc(BLOB_N);
    uLongf on = BLOB_N;
    if (uncompress(out, &on, rbuf, zn) != Z_OK || on != BLOB_N || memcmp(out, blob, BLOB_N) != 0) {
        fprintf(stderr, "round-trip mismatch\n");
        return 1;
    }
    printf("basetest: OK (%lu -> %lu)\n", (unsigned long)BLOB_N, (unsigned long)zn);
    return 0;
}
