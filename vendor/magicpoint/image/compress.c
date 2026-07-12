/* compress.c:
 *
 * compress a colormap by removing unused or duplicate RGB colors.  this
 * uses a 15-bit true color pixel as an index into a hash table of pixel
 * values (similar to the technique used in reduce.c).
 *
 * jim frost 10.05.89
 *
 * Copyright 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"

/* this converts a TLA-style pixel into a 15-bit true color pixel
 */

#define TLA_TO_15BIT(TABLE,PIXEL)           \
  ((((TABLE).red[PIXEL] & 0xf800) >> 1) |   \
   (((TABLE).green[PIXEL] & 0xf800) >> 6) | \
   (((TABLE).blue[PIXEL] & 0xf800) >> 11))

/* these macros extract color intensities from a 15-bit true color pixel
 */

#define RED_INTENSITY(P)   (((P) & 0x7c00) >> 10)
#define GREEN_INTENSITY(P) (((P) & 0x03e0) >> 5)
#define BLUE_INTENSITY(P)   ((P) & 0x001f)

#define NIL_PIXEL 0xffffffff

void compress_colormap(image, verbose)
     Image        *image;
     unsigned int  verbose;
{ Pixel         hash_table[32768];
  Pixel        *pixel_table;
  Pixel        *pixel_map;
  Pixel         index, oldpixval, newpixval;
  byte         *pixptr;
  unsigned int  x, y, badcount, dupcount;
  RGBMap        rgb;

  goodImage(image, "compress");
  if (!RGBP(image) || image->rgb.compressed) /* we're AT&T */
    return;

  if (verbose) {
    fprintf(stderr, "  Compressing colormap...");
    fflush(stderr);
  }

  /* initialize hash table and allocate new RGB intensity tables
   */

  for (x= 0; x < 32768; x++)
    hash_table[x]= NIL_PIXEL;
  newRGBMapData(&rgb, image->rgb.used);
  rgb.size= image->rgb.used;
  rgb.used= 0;
  pixel_table= (Pixel *)lmalloc(sizeof(Pixel) * image->rgb.used);
  pixel_map= (Pixel *)lmalloc(sizeof(Pixel) * image->rgb.used);
  for (x= 0; x < image->rgb.used; x++)
    pixel_map[x]= NIL_PIXEL;

  pixptr= image->data;
  dupcount= badcount= 0;
  for (y= 0; y < image->height; y++)
    for (x= 0; x < image->width; x++) {
      oldpixval= memToVal(pixptr, image->pixlen);
      if (oldpixval > image->rgb.used) {
	badcount++;
	oldpixval= 0;
      }

      /* if we don't already know what value the new pixel will have,
       * look for a similar pixel in hash table.
       */

      if (pixel_map[oldpixval] == NIL_PIXEL) {
	index= TLA_TO_15BIT(image->rgb, oldpixval);

	/* nothing similar
	 */

	if (hash_table[index] == NIL_PIXEL) {
	  newpixval= rgb.used++;
	  hash_table[index]= newpixval;
	}

	/* we've seen one like this before; try to find out if it's an
	 * exact match
	 */

	else {
	  newpixval= hash_table[index];
	  for (;;) {

	    /* if the color is the same as another color we've seen,
	     * use the pixel that the other color is using
	     */

	    if ((rgb.red[newpixval] == image->rgb.red[oldpixval]) &&
		(rgb.green[newpixval] == image->rgb.green[oldpixval]) &&
		(rgb.blue[newpixval] == image->rgb.blue[oldpixval])) {
	      pixel_map[oldpixval]= newpixval; /* same color */
	      dupcount++;
	      goto move_pixel;
	    }

	    /* if we're at the end of the chain, we're the first pixel
	     * of this color
	     */

	    if (pixel_table[newpixval] == NIL_PIXEL) /* end of the chain */
	      break;
	    newpixval= pixel_table[newpixval];
	  }
	  pixel_table[newpixval]= rgb.used;
	  newpixval= rgb.used++;
	}
	pixel_map[oldpixval]= newpixval;
	pixel_table[newpixval]= NIL_PIXEL;
	rgb.red[newpixval]= image->rgb.red[oldpixval];
	rgb.green[newpixval]= image->rgb.green[oldpixval];
	rgb.blue[newpixval]= image->rgb.blue[oldpixval];
      }

      /* change the pixel
       */

    move_pixel:
      valToMem(pixel_map[oldpixval], pixptr, image->pixlen);
      pixptr += image->pixlen;
    }
  lfree(pixel_table);
  lfree(pixel_map);

  if (badcount) {
    if (verbose)
      fprintf(stderr, "%d out-of-range pixels, ", badcount);
    else
      fprintf(stderr, "Warning: %d out-of-range pixels were seen\n",
	      badcount);
  }
  if (verbose) {
    if ((rgb.used == image->rgb.used) && !badcount)
      fprintf(stderr, "no improvment\n");
    else {
      int unused= image->rgb.used - rgb.used - dupcount;
      if (dupcount)
	fprintf(stderr, "%d duplicate%s and %d unused color%s removed...",
	       dupcount, (dupcount == 1 ? "" : "s"),
	       unused, (unused == 1 ? "" : "s"));
	       fprintf(stderr, "%d unique color%s\n",
		      rgb.used, (rgb.used == 1 ? "" : "s"));
    }
  }

  /* image is converted; now fix up its colormap
   */

  freeRGBMapData(&(image->rgb));
  image->rgb= rgb;

  image->rgb.compressed= 1;
}
