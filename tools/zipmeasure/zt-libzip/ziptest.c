/* ziptest (libzip flavor) — 0350 measurement frontend.
 * Same functional work as the libarchive flavor: create a zip with three
 * members (text, pseudo-random binary, pre-compressed payload), reopen it,
 * read every member back and verify byte identity. Exercises both the read
 * and write paths so tree-shaking keeps a representative slice of the lib. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zip.h>

#define BLOB_N 4096

static unsigned char blob[BLOB_N];
static unsigned char gzpayload[512];

static void fill_payloads(void) {
    unsigned s = 12345;
    for (int i = 0; i < BLOB_N; i++) { s = s * 1103515245 + 12345; blob[i] = (unsigned char)(s >> 16); }
    for (int i = 0; i < (int)sizeof(gzpayload); i++) { s = s * 1103515245 + 12345; gzpayload[i] = (unsigned char)(s >> 16); }
    memcpy(gzpayload, "\x1f\x8b\x08", 3);
}

static int add_member(zip_t *za, const char *name, const void *data, size_t n, int store) {
    zip_source_t *src = zip_source_buffer(za, data, n, 0);
    if (!src) return -1;
    zip_int64_t idx = zip_file_add(za, name, src, ZIP_FL_ENC_UTF_8);
    if (idx < 0) { zip_source_free(src); return -1; }
    if (store && zip_set_file_compression(za, (zip_uint64_t)idx, ZIP_CM_STORE, 0) < 0) return -1;
    return 0;
}

static int check_member(zip_t *za, const char *name, const void *want, size_t n) {
    zip_stat_t st;
    if (zip_stat(za, name, 0, &st) < 0) { fprintf(stderr, "stat %s: %s\n", name, zip_strerror(za)); return -1; }
    if (st.size != n) { fprintf(stderr, "%s: size %llu != %u\n", name, (unsigned long long)st.size, (unsigned)n); return -1; }
    zip_file_t *zf = zip_fopen(za, name, 0);
    if (!zf) { fprintf(stderr, "open %s: %s\n", name, zip_strerror(za)); return -1; }
    unsigned char *buf = malloc(n);
    zip_int64_t got = zip_fread(zf, buf, n);
    zip_fclose(zf);
    int ok = (got == (zip_int64_t)n) && memcmp(buf, want, n) == 0;
    free(buf);
    if (!ok) { fprintf(stderr, "%s: content mismatch\n", name); return -1; }
    return 0;
}

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : "/tmp/ziptest.zip";
    const char *text = "Hello from gucOS zip measurement.\n";
    int err = 0;
    fill_payloads();

    zip_t *za = zip_open(path, ZIP_CREATE | ZIP_TRUNCATE, &err);
    if (!za) { fprintf(stderr, "create %s failed: %d\n", path, err); return 1; }
    if (add_member(za, "hello.txt", text, strlen(text), 0) ||
        add_member(za, "data/blob.bin", blob, BLOB_N, 0) ||
        add_member(za, "already.gz", gzpayload, sizeof(gzpayload), 1)) {
        fprintf(stderr, "add failed: %s\n", zip_strerror(za));
        return 1;
    }
    if (zip_close(za) < 0) { fprintf(stderr, "close failed\n"); return 1; }

    za = zip_open(path, ZIP_RDONLY, &err);
    if (!za) { fprintf(stderr, "reopen failed: %d\n", err); return 1; }
    zip_int64_t nent = zip_get_num_entries(za, 0);
    if (nent != 3) { fprintf(stderr, "entries %lld != 3\n", (long long)nent); return 1; }
    for (zip_int64_t i = 0; i < nent; i++) printf("member: %s\n", zip_get_name(za, (zip_uint64_t)i, 0));
    if (check_member(za, "hello.txt", text, strlen(text)) ||
        check_member(za, "data/blob.bin", blob, BLOB_N) ||
        check_member(za, "already.gz", gzpayload, sizeof(gzpayload))) return 1;
    zip_discard(za);
    printf("ziptest(libzip): OK\n");
    return 0;
}
