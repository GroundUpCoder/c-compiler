#include <stdio.h>
#include <sys/param.h>

int main(void) {
    printf("min=%d max=%d\n", MIN(3, 7), MAX(3, 7));
    printf("nbby=%d maxpath=%d\n", NBBY, MAXPATHLEN);
    printf("howmany=%d roundup=%d\n", howmany(10, 4), roundup(10, 4));
    printf("p2_8=%d p2_6=%d\n", powerof2(8), powerof2(6) != 0);
    return 0;
}
