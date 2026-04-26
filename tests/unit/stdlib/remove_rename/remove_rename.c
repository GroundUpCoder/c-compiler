#include <stdio.h>
#include <string.h>

int main() {
    const char *path1 = "build/__test_remove_rename_1.tmp";
    const char *path2 = "build/__test_remove_rename_2.tmp";

    /* Create a file */
    FILE *f = fopen(path1, "w");
    if (!f) {
        printf("FAIL: could not create file\n");
        return 1;
    }
    fprintf(f, "hello");
    fclose(f);
    printf("created\n");

    /* Rename it */
    if (rename(path1, path2) != 0) {
        printf("FAIL: rename failed\n");
        return 1;
    }
    printf("renamed\n");

    /* Verify renamed file has correct contents */
    f = fopen(path2, "r");
    if (!f) {
        printf("FAIL: could not open renamed file\n");
        return 1;
    }
    char buf[64];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    buf[n] = '\0';
    fclose(f);
    if (strcmp(buf, "hello") != 0) {
        printf("FAIL: contents mismatch: %s\n", buf);
        return 1;
    }
    printf("verified\n");

    /* Original path should be gone — fopen should fail */
    f = fopen(path1, "r");
    if (f) {
        fclose(f);
        printf("FAIL: original file still exists\n");
        return 1;
    }
    printf("original gone\n");

    /* Remove the renamed file */
    if (remove(path2) != 0) {
        printf("FAIL: remove failed\n");
        return 1;
    }
    printf("removed\n");

    /* Confirm it's gone */
    f = fopen(path2, "r");
    if (f) {
        fclose(f);
        printf("FAIL: removed file still exists\n");
        return 1;
    }
    printf("confirmed gone\n");

    return 0;
}
