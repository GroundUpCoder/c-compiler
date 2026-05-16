// Regression test: fopen() on a non-existent file must return NULL
// cleanly, not trap, not throw, not crash. Quake's COM_LoadPackFile
// relies on this — it probes pak0.pak, pak1.pak, … until one fails,
// expecting NULL on the first absent file.
//
// The bug that motivated this test wasn't in fopen itself; it was a
// stack-overflow blowing up a giant local array in the caller, which
// presented as "fopen seems to crash on missing file." This test pins
// down the actual fopen contract so future regressions are obvious.
#include <stdio.h>

int main(void) {
    // 1. Plain missing file → NULL
    FILE *f = fopen("definitely_does_not_exist_xyz123.dat", "rb");
    if (f != NULL) { printf("FAIL: case 1 got non-NULL\n"); return 1; }
    printf("ok: missing file returns NULL\n");

    // 2. Missing file via relative path with a missing parent dir
    f = fopen("./no_such_dir/no_such_file.pak", "rb");
    if (f != NULL) { printf("FAIL: case 2 got non-NULL\n"); return 1; }
    printf("ok: missing parent dir returns NULL\n");

    // 3. Same path repeated in a tight loop (Quake's pak0..pakN pattern).
    for (int i = 0; i < 5; i++) {
        char path[64];
        sprintf(path, "./id1/pak%d.pak", i);
        f = fopen(path, "rb");
        if (f != NULL) {
            printf("FAIL: case 3 iteration %d got non-NULL\n", i);
            return 1;
        }
    }
    printf("ok: tight loop all return NULL\n");

    // 4. fopen with various read-mode strings
    if (fopen("nope1.dat", "r")  != NULL) { printf("FAIL: case 4a\n"); return 1; }
    if (fopen("nope2.dat", "rb") != NULL) { printf("FAIL: case 4b\n"); return 1; }
    if (fopen("nope3.dat", "r+") != NULL) { printf("FAIL: case 4c\n"); return 1; }
    printf("ok: all read-mode strings handle missing\n");

    printf("PASS\n");
    return 0;
}
