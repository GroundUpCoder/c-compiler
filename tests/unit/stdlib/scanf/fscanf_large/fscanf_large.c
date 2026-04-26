#include <stdio.h>

int main() {
    /* Write 2000 integers to a file (well over 1024 bytes, exercises shift-and-refill) */
    FILE *fp = fopen("/tmp/fscanf_large_test.txt", "w");
    if (!fp) { printf("fopen write failed\n"); return 1; }
    for (int i = 0; i < 2000; i++) {
        fprintf(fp, "%d\n", i * 3 + 1);
    }
    fclose(fp);

    /* Read them back with fscanf */
    fp = fopen("/tmp/fscanf_large_test.txt", "r");
    if (!fp) { printf("fopen read failed\n"); return 1; }

    int count = 0;
    long sum = 0;
    int val;
    while (fscanf(fp, "%d", &val) == 1) {
        sum += val;
        count++;
    }
    fclose(fp);

    printf("count=%d sum=%ld\n", count, sum);
    /* Expected: 2000 values, each is i*3+1 for i=0..1999
       Sum = 3*sum(0..1999)+2000 = 3*(1999*2000/2)+2000 = 3*1999000+2000 = 5999000 */
    return 0;
}
