#include <stdio.h>
#include <string.h>

int main(void) {
    const char *path = TEST_TMPDIR "freopen.txt";

    /* Write text to file */
    FILE *f = fopen(path, "w");
    if (!f) { printf("fopen failed\n"); return 1; }
    fprintf(f, "hello world\n");
    fclose(f);

    /* Open in text mode, then reopen in binary mode (same file) */
    f = fopen(path, "r");
    if (!f) { printf("fopen read failed\n"); return 1; }

    f = freopen(path, "rb", f);
    if (!f) { printf("freopen failed\n"); return 1; }

    char buf[64];
    memset(buf, 0, sizeof(buf));
    size_t n = fread(buf, 1, sizeof(buf), f);
    printf("read %d bytes: %s", (int)n, buf);
    fclose(f);

    /* Reopen to write new content, reusing the stream */
    f = fopen(path, "r");
    if (!f) { printf("fopen2 failed\n"); return 1; }

    f = freopen(path, "w", f);
    if (!f) { printf("freopen write failed\n"); return 1; }
    fprintf(f, "replaced\n");
    fclose(f);

    /* Verify the replacement */
    f = fopen(path, "r");
    if (!f) { printf("fopen3 failed\n"); return 1; }
    memset(buf, 0, sizeof(buf));
    fread(buf, 1, sizeof(buf), f);
    printf("after rewrite: %s", buf);
    fclose(f);

    printf("PASS\n");
    return 0;
}
