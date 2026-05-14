#include <stdio.h>
#include "png.h"

int main(void) {
    printf("libpng version: %s\n", png_libpng_ver);
    printf("header version: %s\n", PNG_LIBPNG_VER_STRING);
    return 0;
}
