#include <stdio.h>
#include <paths.h>

int main(void) {
    printf("%s\n", _PATH_BSHELL);
    printf("%s\n", _PATH_DEVNULL);
    printf("%s\n", _PATH_TMP);
    printf("%s\n", _PATH_DEFPATH);
    return 0;
}
