/*
 * FreeType text rendering demo for C-to-WASM compiler.
 * Renders a text string to a 24-bit BMP file.
 *
 * Usage: demo <font.ttf> [text] [output.bmp]
 */
#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- BMP writing --- */

static void write_bmp(const char *filename,
                      unsigned char *pixels,
                      int width, int height)
{
    FILE *f = fopen(filename, "wb");
    if (!f) {
        printf("Error: cannot open %s for writing\n", filename);
        return;
    }

    int row_stride = (width * 3 + 3) & ~3;  /* rows padded to 4 bytes */
    int pixel_data_size = row_stride * height;
    int file_size = 14 + 40 + pixel_data_size;

    /* BMP file header (14 bytes) */
    unsigned char bfh[14];
    memset(bfh, 0, 14);
    bfh[0] = 'B'; bfh[1] = 'M';
    bfh[2] = file_size & 0xFF;
    bfh[3] = (file_size >> 8) & 0xFF;
    bfh[4] = (file_size >> 16) & 0xFF;
    bfh[5] = (file_size >> 24) & 0xFF;
    bfh[10] = 54;  /* offset to pixel data */
    fwrite(bfh, 1, 14, f);

    /* BMP info header (40 bytes) */
    unsigned char bih[40];
    memset(bih, 0, 40);
    bih[0] = 40;  /* header size */
    bih[4] = width & 0xFF;
    bih[5] = (width >> 8) & 0xFF;
    bih[6] = (width >> 16) & 0xFF;
    bih[7] = (width >> 24) & 0xFF;
    bih[8] = height & 0xFF;
    bih[9] = (height >> 8) & 0xFF;
    bih[10] = (height >> 16) & 0xFF;
    bih[11] = (height >> 24) & 0xFF;
    bih[12] = 1;   /* planes */
    bih[14] = 24;  /* bits per pixel */
    fwrite(bih, 1, 40, f);

    /* Write pixel rows bottom-to-top (BMP format) */
    unsigned char pad[3] = {0, 0, 0};
    int pad_bytes = row_stride - width * 3;
    for (int y = height - 1; y >= 0; y--) {
        unsigned char *row = pixels + y * width * 3;
        fwrite(row, 1, width * 3, f);
        if (pad_bytes > 0)
            fwrite(pad, 1, pad_bytes, f);
    }

    fclose(f);
}

/* --- Main --- */

int main(int argc, char **argv) {
    const char *font_path = "font.ttf";
    const char *text = "Hello, World!";
    const char *output_path = "output.bmp";
    int font_size = 48;

    if (argc >= 2) font_path = argv[1];
    if (argc >= 3) text = argv[2];
    if (argc >= 4) output_path = argv[3];

    /* Initialize FreeType */
    FT_Library library;
    FT_Error error;

    error = FT_Init_FreeType(&library);
    if (error) {
        printf("Error: FT_Init_FreeType failed (error %d)\n", error);
        return 1;
    }

    /* Load font face */
    FT_Face face;
    error = FT_New_Face(library, font_path, 0, &face);
    if (error) {
        printf("Error: cannot load font '%s' (error %d)\n", font_path, error);
        FT_Done_FreeType(library);
        return 1;
    }

    error = FT_Set_Pixel_Sizes(face, 0, font_size);
    if (error) {
        printf("Error: FT_Set_Pixel_Sizes failed (error %d)\n", error);
        FT_Done_Face(face);
        FT_Done_FreeType(library);
        return 1;
    }

    /* Pass 1: compute total bounding box */
    int text_len = strlen(text);
    int pen_x = 0;
    int y_min = 0;
    int y_max = 0;

    for (int i = 0; i < text_len; i++) {
        FT_UInt glyph_index = FT_Get_Char_Index(face, (unsigned char)text[i]);
        error = FT_Load_Glyph(face, glyph_index, FT_LOAD_DEFAULT);
        if (error) continue;
        error = FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL);
        if (error) continue;

        FT_GlyphSlot slot = face->glyph;
        int glyph_top = slot->bitmap_top;
        int glyph_bottom = glyph_top - (int)slot->bitmap.rows;

        if (glyph_top > y_max) y_max = glyph_top;
        if (glyph_bottom < y_min) y_min = glyph_bottom;

        pen_x += slot->advance.x >> 6;
    }

    int img_width = pen_x + 2;  /* small margin */
    int img_height = y_max - y_min + 2;
    int baseline = y_max + 1;  /* baseline position from top */

    if (img_width < 1) img_width = 1;
    if (img_height < 1) img_height = 1;

    /* Allocate image buffer (white background) */
    unsigned char *pixels = (unsigned char *)malloc(img_width * img_height * 3);
    memset(pixels, 255, img_width * img_height * 3);  /* white */

    /* Pass 2: render glyphs */
    pen_x = 0;
    for (int i = 0; i < text_len; i++) {
        FT_UInt glyph_index = FT_Get_Char_Index(face, (unsigned char)text[i]);
        error = FT_Load_Glyph(face, glyph_index, FT_LOAD_DEFAULT);
        if (error) continue;
        error = FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL);
        if (error) continue;

        FT_GlyphSlot slot = face->glyph;
        FT_Bitmap *bmp = &slot->bitmap;

        int x0 = pen_x + slot->bitmap_left;
        int y0 = baseline - slot->bitmap_top;

        for (int row = 0; row < (int)bmp->rows; row++) {
            for (int col = 0; col < (int)bmp->width; col++) {
                int px = x0 + col;
                int py = y0 + row;
                if (px < 0 || px >= img_width || py < 0 || py >= img_height)
                    continue;

                unsigned char alpha = bmp->buffer[row * bmp->pitch + col];
                /* Blend black text onto white background */
                int idx = (py * img_width + px) * 3;
                int bg = pixels[idx];
                int blended = bg - (alpha * bg / 255);
                pixels[idx + 0] = blended;  /* B */
                pixels[idx + 1] = blended;  /* G */
                pixels[idx + 2] = blended;  /* R */
            }
        }

        pen_x += slot->advance.x >> 6;
    }

    /* Write BMP */
    write_bmp(output_path, pixels, img_width, img_height);
    printf("Wrote %dx%d BMP to %s\n", img_width, img_height, output_path);

    /* Cleanup */
    free(pixels);
    FT_Done_Face(face);
    FT_Done_FreeType(library);

    return 0;
}
