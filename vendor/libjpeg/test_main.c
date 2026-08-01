#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include "jpeglib.h"
#include "jerror.h"

/* Fatal-error handler: longjmp instead of the library's exit(). */
struct err_jmp {
    struct jpeg_error_mgr mgr;
    jmp_buf jb;
};

static void err_exit(j_common_ptr cinfo) {
    struct err_jmp *e = (struct err_jmp *)cinfo->err;
    char buf[JMSG_LENGTH_MAX];
    (*cinfo->err->format_message)(cinfo, buf);
    printf("JPEG-ERROR: %s\n", buf);
    longjmp(e->jb, 1);
}

/* Decode <jpg> to 3-byte RGB (grayscale sources are up-converted). */
static unsigned char *read_jpeg_file(const char *path, int *out_w, int *out_h) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    struct jpeg_decompress_struct cinfo;
    struct err_jmp jerr;
    cinfo.err = jpeg_std_error(&jerr.mgr);
    jerr.mgr.error_exit = err_exit;
    unsigned char *pixels = NULL;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_decompress(&cinfo);
        fclose(f);
        free(pixels);
        return NULL;
    }
    jpeg_create_decompress(&cinfo);
    jpeg_stdio_src(&cinfo, f);
    jpeg_read_header(&cinfo, TRUE);
    cinfo.out_color_space = JCS_RGB;
    cinfo.dct_method = JDCT_ISLOW;
    jpeg_start_decompress(&cinfo);
    int w = cinfo.output_width, h = cinfo.output_height;
    if (cinfo.output_components != 3) {
        jpeg_destroy_decompress(&cinfo);
        fclose(f);
        return NULL;
    }
    pixels = (unsigned char *)malloc((size_t)w * h * 3);
    while (cinfo.output_scanline < cinfo.output_height) {
        JSAMPROW row = pixels + (size_t)cinfo.output_scanline * w * 3;
        jpeg_read_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    fclose(f);
    *out_w = w;
    *out_h = h;
    return pixels;
}

/* Encode RGB pixels to <path>. mode: 0 baseline, 1 progressive,
 * 2 arithmetic, 3 grayscale (RGB in, luma out). Fixed quality 85,
 * default islow DCT — fully deterministic. */
static int write_jpeg_file(const char *path, int w, int h,
                           const unsigned char *pixels, int mode) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    struct jpeg_compress_struct cinfo;
    struct err_jmp jerr;
    cinfo.err = jpeg_std_error(&jerr.mgr);
    jerr.mgr.error_exit = err_exit;
    if (setjmp(jerr.jb)) {
        jpeg_destroy_compress(&cinfo);
        fclose(f);
        return 0;
    }
    jpeg_create_compress(&cinfo);
    jpeg_stdio_dest(&cinfo, f);
    cinfo.image_width = w;
    cinfo.image_height = h;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, 85, TRUE);
    if (mode == 1) jpeg_simple_progression(&cinfo);
    if (mode == 2) cinfo.arith_code = TRUE;
    if (mode == 3) jpeg_set_colorspace(&cinfo, JCS_GRAYSCALE);
    jpeg_start_compress(&cinfo, TRUE);
    while (cinfo.next_scanline < cinfo.image_height) {
        JSAMPROW row = (JSAMPROW)(pixels + (size_t)cinfo.next_scanline * w * 3);
        jpeg_write_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    fclose(f);
    return 1;
}

/* .rgb text format (the libpng testdata format): "w h\n" then one
 * "r,g,b" per pixel. */
static unsigned char *load_rgb(const char *path, int *out_w, int *out_h) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    int w, h;
    if (fscanf(f, "%d %d", &w, &h) != 2) { fclose(f); return NULL; }
    unsigned char *pixels = (unsigned char *)malloc((size_t)w * h * 3);
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

static int save_rgb(const char *path, int w, int h, const unsigned char *pixels) {
    FILE *f = fopen(path, "w");
    if (!f) return 0;
    fprintf(f, "%d %d\n", w, h);
    for (int i = 0; i < w * h; i++)
        fprintf(f, "%d,%d,%d\n", pixels[i*3], pixels[i*3+1], pixels[i*3+2]);
    fclose(f);
    return 1;
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

// test read <jpg> <rgb>
//   Decode <jpg>, compare every pixel to <rgb> reference (exact).
// test write <rgb> <out.jpg> <golden.jpg> [prog|ari|gray]
//   Encode pixels from <rgb>, compare bytes to <golden.jpg>.
// test dump <jpg> <rgb>
//   Decode <jpg>, WRITE the .rgb reference (golden generator, native build).
// test corrupt <file>
//   Decode must FAIL cleanly (error-path control; exits 0 on rejection).
int main(int argc, char **argv) {
    if (argc < 2) {
        printf("usage:\n");
        printf("  %s read <jpg> <rgb>\n", argv[0]);
        printf("  %s write <rgb> <out.jpg> <golden.jpg> [prog|ari|gray]\n", argv[0]);
        printf("  %s dump <jpg> <rgb>\n", argv[0]);
        printf("  %s corrupt <file>\n", argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "read") == 0 && argc == 4) {
        int jw, jh, rw, rh;
        unsigned char *decoded = read_jpeg_file(argv[2], &jw, &jh);
        if (!decoded) { printf("FAIL: cannot read %s\n", argv[2]); return 1; }
        unsigned char *expected = load_rgb(argv[3], &rw, &rh);
        if (!expected) { printf("FAIL: cannot read %s\n", argv[3]); free(decoded); return 1; }
        if (jw != rw || jh != rh) {
            printf("FAIL: size %dx%d expected %dx%d\n", jw, jh, rw, rh);
            free(decoded); free(expected);
            return 1;
        }
        int errors = 0;
        for (int i = 0; i < jw * jh * 3; i += 3) {
            if (decoded[i] != expected[i] || decoded[i+1] != expected[i+1] || decoded[i+2] != expected[i+2]) {
                int idx = i / 3;
                if (errors < 5)
                    printf("FAIL: pixel (%d,%d) got (%d,%d,%d) expected (%d,%d,%d)\n",
                           idx % jw, idx / jw,
                           decoded[i], decoded[i+1], decoded[i+2],
                           expected[i], expected[i+1], expected[i+2]);
                errors++;
            }
        }
        free(decoded); free(expected);
        if (errors) {
            printf("FAIL: %d/%d pixels wrong\n", errors, jw * jh);
            return 1;
        }
        printf("OK read %s %dx%d %d pixels\n", argv[2], jw, jh, jw * jh);
        return 0;

    } else if (strcmp(argv[1], "write") == 0 && (argc == 5 || argc == 6)) {
        int mode = 0;
        if (argc == 6) {
            if (strcmp(argv[5], "prog") == 0) mode = 1;
            else if (strcmp(argv[5], "ari") == 0) mode = 2;
            else if (strcmp(argv[5], "gray") == 0) mode = 3;
            else { printf("FAIL: unknown mode %s\n", argv[5]); return 1; }
        }
        int w, h;
        unsigned char *pixels = load_rgb(argv[2], &w, &h);
        if (!pixels) { printf("FAIL: cannot read %s\n", argv[2]); return 1; }
        if (!write_jpeg_file(argv[3], w, h, pixels, mode)) {
            printf("FAIL: cannot write %s\n", argv[3]);
            free(pixels);
            return 1;
        }
        free(pixels);
        if (!compare_files(argv[3], argv[4])) {
            printf("FAIL: %s not byte-identical to %s\n", argv[3], argv[4]);
            return 1;
        }
        printf("OK write %s %dx%d\n", argv[3], w, h);
        return 0;

    } else if (strcmp(argv[1], "dump") == 0 && argc == 4) {
        int w, h;
        unsigned char *decoded = read_jpeg_file(argv[2], &w, &h);
        if (!decoded) { printf("FAIL: cannot read %s\n", argv[2]); return 1; }
        int ok = save_rgb(argv[3], w, h, decoded);
        free(decoded);
        if (!ok) { printf("FAIL: cannot write %s\n", argv[3]); return 1; }
        printf("OK dump %s %dx%d\n", argv[2], w, h);
        return 0;

    } else if (strcmp(argv[1], "corrupt") == 0 && argc == 3) {
        int w, h;
        unsigned char *decoded = read_jpeg_file(argv[2], &w, &h);
        if (decoded) {
            printf("FAIL: corrupt input %s decoded %dx%d\n", argv[2], w, h);
            free(decoded);
            return 1;
        }
        printf("OK corrupt %s rejected\n", argv[2]);
        return 0;
    }

    printf("FAIL: unknown command\n");
    return 1;
}
