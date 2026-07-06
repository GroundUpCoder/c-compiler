/* /bin/ls — minimal native ls until the busybox coreutils land
 * (todos/0005 follow-up). Sorted names, -a for dotfiles. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <dirent.h>
#include <sys/stat.h>

static int namecmp(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static int ls_one(const char *path, int all) {
    struct stat st;
    if (stat(path, &st) != 0) {
        fprintf(stderr, "ls: %s: %s\n", path, strerror(errno));
        return 1;
    }
    if (!S_ISDIR(st.st_mode)) { puts(path); return 0; }
    DIR *d = opendir(path);
    if (!d) { fprintf(stderr, "ls: %s: %s\n", path, strerror(errno)); return 1; }
    char *names[512];
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)) && n < 512) {
        if (!all && de->d_name[0] == '.') continue;
        names[n++] = strdup(de->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof names[0], namecmp);
    for (int i = 0; i < n; i++) { puts(names[i]); free(names[i]); }
    return 0;
}

int main(int argc, char **argv) {
    int all = 0, i = 1, rc = 0, seen = 0;
    for (; i < argc && argv[i][0] == '-'; i++)
        if (strchr(argv[i], 'a')) all = 1;
    for (; i < argc; i++) { rc |= ls_one(argv[i], all); seen = 1; }
    if (!seen) rc = ls_one(".", all);
    return rc;
}
