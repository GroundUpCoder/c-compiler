/*
 * Copyright (C) 1999 and 2000 WIDE Project.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the project nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE PROJECT AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE PROJECT OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */
/*
 * $Id: png.c,v 1.6 2001/04/11 08:37:00 nishida Exp $
 */
#ifdef USE_PNG
#include <png.h>

#if 1
#define PNG_ALPHA_CHANNEL
#endif

#ifdef PNG_ALPHA_CHANNEL
#include "../mgp.h"
#else 
#include "image.h"
#endif

#define PNG_CHECK_BYTES 4

int 
pngIdent(char *fullname, char *name) {}
    
Image *
pngLoad(fullname, name, verbose)
    char *fullname, *name;
	unsigned int verbose;
{
	FILE *fp;
	png_structp 	png_ptr; 
	png_infop 		info_ptr; 
	png_uint_32 	width, height;
	png_bytep 		*row_pointers;
	int 			bitdepth, colortype, row, is_png, alpha_flag = 0;
	char 			header[PNG_CHECK_BYTES], *destptr;
	Image			*image;
#ifdef PNG_ALPHA_CHANNEL
	int				alpha_red, alpha_green, alpha_blue, ialpha;
	int				x, len;
	float			alpha;
	char			*p;
	XColor  		xcol;
#endif

	if (!(fp = fopen(fullname, "rb"))) return NULL;
	if (fread(header, 1, sizeof(header), fp) != sizeof(header)) return NULL;

	is_png = !png_sig_cmp(header, 0, sizeof(header));
	if (!is_png){
		if (verbose) fprintf(stderr, "pngLoad: this is not png file\n");
		return NULL;
	}

	png_ptr = png_create_read_struct(PNG_LIBPNG_VER_STRING,
				(png_voidp)NULL, NULL, NULL);
	if (!png_ptr) return NULL;
							   
	info_ptr = png_create_info_struct(png_ptr);
	if (!info_ptr) {
		png_destroy_read_struct(&png_ptr, (png_infopp)NULL, (png_infopp)NULL);
		return NULL;
	}

	if (setjmp(png_jmpbuf(png_ptr))) {
		png_destroy_read_struct(&png_ptr, &info_ptr, (png_infopp)NULL);
		fclose(fp);
		return NULL;
	}

	png_init_io(png_ptr, fp);
	png_set_sig_bytes(png_ptr, sizeof(header));

	png_read_info(png_ptr, info_ptr);
	png_get_IHDR(png_ptr, info_ptr, &width, &height,
			&bitdepth, &colortype, NULL, NULL, NULL);

	if (verbose){
		fprintf(stderr, "pngLoad: [%s] width %d height %d depth %d color %d\n", 
			fullname, width, height, bitdepth, colortype);
	}

	/* 
		currently, the alpha channel is not supported.. 
	*/
#ifndef PNG_ALPHA_CHANNEL
	if (colortype & PNG_COLOR_MASK_ALPHA){
		if (verbose) fprintf(stderr, "pngLoad: strip off alpha channel\n");
		png_set_strip_alpha(png_ptr);
	}
#endif

	/*
		strip the 16 bit pixels down to 8bit.
	*/
	if (bitdepth == 16){
		png_set_strip_16(png_ptr);
	}

	if (colortype == PNG_COLOR_TYPE_GRAY ||
			colortype == PNG_COLOR_TYPE_GRAY_ALPHA){
				png_set_gray_to_rgb(png_ptr); 
				png_read_update_info(png_ptr, info_ptr);
	}

	if (colortype == PNG_COLOR_TYPE_PALETTE && bitdepth <= 8){
		if (verbose) fprintf(stderr, "pngLoad: palette to rgb\n");
		png_set_palette_to_rgb(png_ptr);
		png_read_update_info(png_ptr, info_ptr);
	} 

	if (colortype == PNG_COLOR_TYPE_GRAY && bitdepth < 8){
		png_set_expand_gray_1_2_4_to_8(png_ptr);
	}

	if (png_get_valid(png_ptr, info_ptr, PNG_INFO_tRNS)){
		if (verbose) 
			fprintf(stderr, "pngLoad: add tRNS info to alpha channel\n");
		png_set_tRNS_to_alpha(png_ptr);
		alpha_flag = 1;
#ifndef PNG_ALPHA_CHANNEL
		png_set_strip_alpha(png_ptr);
#endif
	}

	image = newTrueImage(width, height);

	row_pointers = (png_bytep *)malloc(sizeof(png_bytep) * height);
	for (row = 0; row < height; row++) {
			row_pointers[row] = 
				(png_bytep)malloc(png_get_rowbytes(png_ptr, info_ptr));
	}
	png_read_image(png_ptr, row_pointers);

	destptr = image->data;

#ifndef PNG_ALPHA_CHANNEL
	for (row = 0; row < height; row++) {
		memcpy(destptr + width * row * 3, row_pointers[row], width * 3);
	}
#else
	xcol.pixel = back_color[caching]; 
	xcol.flags = DoRed|DoGreen|DoBlue;
	XQueryColor(display, colormap, &xcol);

	alpha_red = xcol.red >> 8;
	alpha_green = xcol.green >> 8;
	alpha_blue = xcol.blue >> 8;

	if (!(colortype & PNG_COLOR_MASK_ALPHA) && !alpha_flag){
		for (row = 0; row < height; row++) {
			memcpy(destptr + width * row * 3, row_pointers[row], width * 3);
		}
	} else {
		/*  
			alpha channel processing 
		*/
		for (row = 0; row < height; row++) {
			len = png_get_rowbytes(png_ptr, info_ptr);
			p = destptr + width * row * 3;

			for (x = 0; x < len; x+= 4){
				ialpha =  (u_int)(row_pointers[row][x+3]);
	
				if (!ialpha) {
					/* this pixel is transparent */
					*(p++) = alpha_red;
					*(p++) = alpha_green;
					*(p++) = alpha_blue;
				} else {
				if (ialpha == 255){
					/* this pixel is opacity */
					*(p++) = row_pointers[row][x];
					*(p++) = row_pointers[row][x+1];
					*(p++) = row_pointers[row][x+2];
				} else {
					alpha =  (u_int)(row_pointers[row][x+3]) / 255.0;
					*(p++) = row_pointers[row][x] * alpha 
								+ alpha_red * (1.0 - alpha);
					*(p++) = row_pointers[row][x+1] * alpha
								+ alpha_green * (1.0 - alpha);
					*(p++) = row_pointers[row][x+2] * alpha
								+ alpha_blue * (1.0 - alpha);
				}
				}
			}
		}
	}
#endif

	for (row = 0; row < height; row++) free (row_pointers[row]);
	free(row_pointers); 
	png_read_end(png_ptr, info_ptr);
	png_destroy_read_struct(&png_ptr, &info_ptr, (png_infopp)NULL);
	fclose(fp);

	return image;
}

#endif
