#include <stdio.h>

int main() {
    /* Write a small file */
    FILE *fp = fopen("/tmp/fscanf_test.txt", "w");
    if (!fp) { printf("fopen write failed\n"); return 1; }
    fprintf(fp, "42 3.14 hello\n");
    fprintf(fp, "100 2.72 world\n");
    fclose(fp);

    /* Read it back */
    fp = fopen("/tmp/fscanf_test.txt", "r");
    if (!fp) { printf("fopen read failed\n"); return 1; }

    int a;
    float f;
    char s[64];

    int r = fscanf(fp, "%d %f %s", &a, &f, s);
    printf("line1: r=%d a=%d f=%.2f s='%s'\n", r, a, (double)f, s);

    r = fscanf(fp, "%d %f %s", &a, &f, s);
    printf("line2: r=%d a=%d f=%.2f s='%s'\n", r, a, (double)f, s);

    /* Check EOF */
    r = fscanf(fp, "%d", &a);
    printf("eof: r=%d\n", r);

    fclose(fp);
    return 0;
}
