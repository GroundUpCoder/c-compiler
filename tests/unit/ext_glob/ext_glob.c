/* glob via the optional libc-ext.js (vendored musl glob). Globs files this test
   creates under TEST_TMPDIR with a unique prefix, so it is deterministic and
   independent of anything else in the directory. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <glob.h>

#ifndef TEST_TMPDIR
#define TEST_TMPDIR "/tmp/"
#endif

static void mk(const char *path) {
    FILE *f = fopen(path, "w");
    if (f) { fputs("x", f); fclose(f); }
}

int main(void) {
    char a[512], b[512], c[512], pat[512];
    snprintf(a, sizeof a, "%sext_glob_aa.txt", TEST_TMPDIR);
    snprintf(b, sizeof b, "%sext_glob_bb.txt", TEST_TMPDIR);
    snprintf(c, sizeof c, "%sext_glob_cc.dat", TEST_TMPDIR);   /* must NOT match *.txt */
    snprintf(pat, sizeof pat, "%sext_glob_*.txt", TEST_TMPDIR);
    mk(a); mk(b); mk(c);

    glob_t g;
    int r = glob(pat, 0, 0, &g);
    printf("r=%d n=%lu\n", r, (unsigned long)g.gl_pathc);
    /* gl_pathv is sorted by default */
    for (size_t i = 0; i < g.gl_pathc; i++) {
        const char *base = strrchr(g.gl_pathv[i], '/');
        printf("  %s\n", base ? base + 1 : g.gl_pathv[i]);
    }
    globfree(&g);

    glob_t none;
    printf("nomatch=%d (GLOB_NOMATCH=%d)\n",
           glob("/no/such/dir/ext_glob_*.zzz", 0, 0, &none), GLOB_NOMATCH);
    return 0;
}
