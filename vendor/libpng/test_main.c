#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "png.h"

static unsigned char *read_png_file(const char *path, int *out_w, int *out_h) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    if (!png) { fclose(f); return NULL; }
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_read_struct(&png, NULL, NULL); fclose(f); return NULL; }
    if (setjmp(png_jmpbuf(png))) {
        png_destroy_read_struct(&png, &info, NULL);
        fclose(f);
        return NULL;
    }
    png_init_io(png, f);
    png_read_info(png, info);
    int w = png_get_image_width(png, info);
    int h = png_get_image_height(png, info);
    int color_type = png_get_color_type(png, info);
    int bit_depth = png_get_bit_depth(png, info);
    if (color_type == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(png);
    if (color_type == PNG_COLOR_TYPE_GRAY && bit_depth < 8) png_set_expand_gray_1_2_4_to_8(png);
    if (color_type == PNG_COLOR_TYPE_GRAY || color_type == PNG_COLOR_TYPE_GRAY_ALPHA)
        png_set_gray_to_rgb(png);
    if (bit_depth == 16) png_set_strip_16(png);
    if (color_type & PNG_COLOR_MASK_ALPHA) png_set_strip_alpha(png);
    png_read_update_info(png, info);
    unsigned char *pixels = (unsigned char *)malloc(w * h * 3);
    for (int y = 0; y < h; y++)
        png_read_row(png, pixels + y * w * 3, NULL);
    png_read_end(png, info);
    png_destroy_read_struct(&png, &info, NULL);
    fclose(f);
    *out_w = w;
    *out_h = h;
    return pixels;
}

static int write_png_file(const char *path, int w, int h, const unsigned char *pixels) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    if (!png) { fclose(f); return 0; }
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_write_struct(&png, NULL); fclose(f); return 0; }
    if (setjmp(png_jmpbuf(png))) {
        png_destroy_write_struct(&png, &info);
        fclose(f);
        return 0;
    }
    png_init_io(png, f);
    png_set_IHDR(png, info, w, h, 8, PNG_COLOR_TYPE_RGB,
                 PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT,
                 PNG_FILTER_TYPE_DEFAULT);
    png_write_info(png, info);
    for (int y = 0; y < h; y++)
        png_write_row(png, (png_bytep)(pixels + y * w * 3));
    png_write_end(png, info);
    png_destroy_write_struct(&png, &info);
    fclose(f);
    return 1;
}

static unsigned char *load_rgb(const char *path, int *out_w, int *out_h) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    int w, h;
    if (fscanf(f, "%d %d", &w, &h) != 2) { fclose(f); return NULL; }
    unsigned char *pixels = (unsigned char *)malloc(w * h * 3);
    for (int i = 0; i < w * h; i++) {
        int r, g, b;
        if (fscanf(f, "%d,%d,%d", &r, &g, &b) != 3) { free(pixels); fclose(f); return NULL; }
        pixels[i*3] = (unsigned char)r;
        pixels[i*3+1] = (unsigned char)g;
        pixels[i*3+2] = (unsigned char)b;
    }
    fclose(f);
    *out_w = w;
    *out_h = h;
    return pixels;
}

static int compare_files(const char *a, const char *b) {
    FILE *fa = fopen(a, "rb");
    FILE *fb = fopen(b, "rb");
    if (!fa || !fb) { if (fa) fclose(fa); if (fb) fclose(fb); return 0; }
    int match = 1;
    while (1) {
        int ca = fgetc(fa), cb = fgetc(fb);
        if (ca != cb) { match = 0; break; }
        if (ca == EOF) break;
    }
    fclose(fa);
    fclose(fb);
    return match;
}

// test read <png> <rgb>
//   Read <png>, compare every pixel to <rgb> reference.
// test write <rgb> <out.png> <golden.png>
//   Load pixel data from <rgb>, write <out.png>, compare bytes to <golden.png>.
int main(int argc, char **argv) {
    if (argc < 2) {
        printf("usage:\n");
        printf("  %s read <png> <rgb>\n", argv[0]);
        printf("  %s write <rgb> <out.png> <golden.png>\n", argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "read") == 0 && argc == 4) {
        const char *png_path = argv[2];
        const char *rgb_path = argv[3];
        int pw, ph, rw, rh;
        unsigned char *decoded = read_png_file(png_path, &pw, &ph);
        if (!decoded) { printf("FAIL: cannot read %s\n", png_path); return 1; }
        unsigned char *expected = load_rgb(rgb_path, &rw, &rh);
        if (!expected) { printf("FAIL: cannot read %s\n", rgb_path); free(decoded); return 1; }
        if (pw != rw || ph != rh) {
            printf("FAIL: size %dx%d expected %dx%d\n", pw, ph, rw, rh);
            free(decoded); free(expected);
            return 1;
        }
        int errors = 0;
        for (int i = 0; i < pw * ph * 3; i += 3) {
            if (decoded[i] != expected[i] || decoded[i+1] != expected[i+1] || decoded[i+2] != expected[i+2]) {
                int idx = i / 3;
                if (errors < 5)
                    printf("FAIL: pixel (%d,%d) got (%d,%d,%d) expected (%d,%d,%d)\n",
                           idx % pw, idx / pw,
                           decoded[i], decoded[i+1], decoded[i+2],
                           expected[i], expected[i+1], expected[i+2]);
                errors++;
            }
        }
        free(decoded); free(expected);
        if (errors) {
            printf("FAIL: %d/%d pixels wrong\n", errors, pw * ph);
            return 1;
        }
        printf("OK read %s %dx%d %d pixels\n", png_path, pw, ph, pw * ph);
        return 0;

    } else if (strcmp(argv[1], "write") == 0 && argc == 5) {
        const char *rgb_path = argv[2];
        const char *out_path = argv[3];
        const char *golden_path = argv[4];
        int w, h;
        unsigned char *pixels = load_rgb(rgb_path, &w, &h);
        if (!pixels) { printf("FAIL: cannot read %s\n", rgb_path); return 1; }
        if (!write_png_file(out_path, w, h, pixels)) {
            printf("FAIL: cannot write %s\n", out_path);
            free(pixels);
            return 1;
        }
        free(pixels);
        if (!compare_files(out_path, golden_path)) {
            printf("FAIL: %s not byte-identical to %s\n", out_path, golden_path);
            return 1;
        }
        printf("OK write %s %dx%d\n", out_path, w, h);
        return 0;
    }

    printf("FAIL: unknown command\n");
    return 1;
}
