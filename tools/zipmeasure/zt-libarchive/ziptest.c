/* ziptest (libarchive flavor) — 0350 measurement frontend.
 * Same functional work as the libzip flavor: create a zip with three
 * members (text, pseudo-random binary, pre-compressed payload — the last
 * stored, not deflated), reopen it, read every member back and verify byte
 * identity. Exercises both read and write paths. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <archive.h>
#include <archive_entry.h>

#define BLOB_N 4096

static unsigned char blob[BLOB_N];
static unsigned char gzpayload[512];

static void fill_payloads(void) {
    unsigned s = 12345;
    for (int i = 0; i < BLOB_N; i++) { s = s * 1103515245 + 12345; blob[i] = (unsigned char)(s >> 16); }
    for (int i = 0; i < (int)sizeof(gzpayload); i++) { s = s * 1103515245 + 12345; gzpayload[i] = (unsigned char)(s >> 16); }
    memcpy(gzpayload, "\x1f\x8b\x08", 3);
}

static int add_member(struct archive *a, const char *name, const void *data, size_t n) {
    struct archive_entry *e = archive_entry_new();
    archive_entry_set_pathname(e, name);
    archive_entry_set_size(e, (la_int64_t)n);
    archive_entry_set_filetype(e, AE_IFREG);
    archive_entry_set_perm(e, 0644);
    if (archive_write_header(a, e) != ARCHIVE_OK) { fprintf(stderr, "header %s: %s\n", name, archive_error_string(a)); return -1; }
    if (archive_write_data(a, data, n) != (la_ssize_t)n) { fprintf(stderr, "data %s: %s\n", name, archive_error_string(a)); return -1; }
    archive_entry_free(e);
    return 0;
}

struct want { const char *name; const void *data; size_t n; int seen; };

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : "/tmp/ziptest.zip";
    const char *text = "Hello from gucOS zip measurement.\n";
    fill_payloads();

    struct archive *a = archive_write_new();
    archive_write_set_format_zip(a);
    if (archive_write_open_filename(a, path) != ARCHIVE_OK) { fprintf(stderr, "create: %s\n", archive_error_string(a)); return 1; }
    if (add_member(a, "hello.txt", text, strlen(text)) ||
        add_member(a, "data/blob.bin", blob, BLOB_N)) return 1;
    if (add_member(a, "already.gz", gzpayload, sizeof(gzpayload))) return 1;
    if (archive_write_close(a) != ARCHIVE_OK) { fprintf(stderr, "close: %s\n", archive_error_string(a)); return 1; }
    archive_write_free(a);

    struct want wants[3];
    wants[0].name = "hello.txt";     wants[0].data = text;      wants[0].n = strlen(text);        wants[0].seen = 0;
    wants[1].name = "data/blob.bin"; wants[1].data = blob;      wants[1].n = BLOB_N;              wants[1].seen = 0;
    wants[2].name = "already.gz";    wants[2].data = gzpayload; wants[2].n = sizeof(gzpayload);   wants[2].seen = 0;

    a = archive_read_new();
    archive_read_support_format_zip(a);
    archive_read_support_format_tar(a);
    archive_read_support_filter_gzip(a);
    if (archive_read_open_filename(a, path, 65536) != ARCHIVE_OK) { fprintf(stderr, "reopen: %s\n", archive_error_string(a)); return 1; }
    struct archive_entry *e;
    int nent = 0;
    while (archive_read_next_header(a, &e) == ARCHIVE_OK) {
        const char *name = archive_entry_pathname(e);
        printf("member: %s\n", name);
        for (int i = 0; i < 3; i++) {
            if (strcmp(name, wants[i].name) != 0) continue;
            size_t n = wants[i].n;
            unsigned char *buf = malloc(n + 1);
            la_ssize_t got = archive_read_data(a, buf, n + 1);
            if (got != (la_ssize_t)n || memcmp(buf, wants[i].data, n) != 0) {
                fprintf(stderr, "%s: content mismatch (got %ld)\n", name, (long)got);
                return 1;
            }
            free(buf);
            wants[i].seen = 1;
        }
        nent++;
    }
    archive_read_free(a);
    if (nent != 3 || !wants[0].seen || !wants[1].seen || !wants[2].seen) {
        fprintf(stderr, "entries wrong: %d\n", nent);
        return 1;
    }
    printf("ziptest(libarchive): OK\n");
    return 0;
}
