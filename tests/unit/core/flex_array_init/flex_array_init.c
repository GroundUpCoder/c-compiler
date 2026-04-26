/* Bug: flexible array member (FAM) initialization stores wrong data.
 *
 * struct { char c; char p[]; } a = { 'o', "wx" };
 * a.p[0] should be 'w' (119) but the compiler stores garbage.
 * The FAM data seems to be placed at the wrong offset or
 * the initializer entries are being mixed up.
 *
 * From GCC torture test: 20010924-1.c
 */
#include <stdio.h>

struct flex {
    char c;
    char p[];
};

struct flex a1 = { 'A', "BC" };
struct flex a2 = { 'X', { 'Y', 'Z' } };

int main(void) {
    printf("a1.c=%c a1.p[0]=%c a1.p[1]=%c\n", a1.c, a1.p[0], a1.p[1]);
    if (a1.c != 'A' || a1.p[0] != 'B' || a1.p[1] != 'C') {
        printf("FAIL a1\n");
        return 1;
    }

    printf("a2.c=%c a2.p[0]=%c a2.p[1]=%c\n", a2.c, a2.p[0], a2.p[1]);
    if (a2.c != 'X' || a2.p[0] != 'Y' || a2.p[1] != 'Z') {
        printf("FAIL a2\n");
        return 1;
    }

    printf("OK\n");
    return 0;
}
