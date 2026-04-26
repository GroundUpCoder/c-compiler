#include <stdio.h>

int main() {
    /* Write 1100 'A' chars with no whitespace — single field > BUFSIZ */
    FILE *fp = fopen("/tmp/fscanf_trap_test.txt", "w");
    if (!fp) { printf("fopen write failed\n"); return 1; }
    for (int i = 0; i < 1100; i++) {
        fputc('A', fp);
    }
    fclose(fp);

    /* Try to fscanf with %s — should trap (exit code 1) */
    fp = fopen("/tmp/fscanf_trap_test.txt", "r");
    if (!fp) { printf("fopen read failed\n"); return 1; }

    char buf[2048];
    fscanf(fp, "%s", buf);

    /* Should not reach here */
    printf("ERROR: should have trapped\n");
    fclose(fp);
    return 0;
}
