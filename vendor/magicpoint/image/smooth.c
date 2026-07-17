/* smooth.c:
 *
 * this performs a smoothing convolution using a 3x3 area.
 *
 * jim frost 09.20.90
 *
 * Copyright 1990, 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"

static Image *doSmooth(image)
     Image *image;
{ Image *old, *new;
  int    x, y, x1, y1, linelen;
  int    xindex[3];
  byte  *yindex[3];
  byte  *destptr;
  Pixel  pixval;
  unsigned long avgred, avggreen, avgblue;

  /* build true color image from old image and allocate new image
   */

  old= expand(image);
  new= newTrueImage(image->width, image->height);
  if (image->title) {
      new->title= (char *)lmalloc(strlen(image->title) + 12);
      sprintf(new->title, "%s (smoothed)", image->title);
  }

  /* run through image and take a guess as to what the color should
   * actually be.
   */

  destptr= new->data;
  linelen= old->pixlen * old->width;
  for (y= 0; y < old->height; y++) {
    yindex[1]= old->data + (y * linelen);
    yindex[0]= yindex[1] - (y > 0 ? linelen : 0);
    yindex[2]= yindex[1] + (y < old->height - 1 ? linelen : 0);
    for (x= 0; x < old->width; x++) {
      avgred= avggreen= avgblue= 0;
      xindex[1]= x * old->pixlen;
      xindex[0]= xindex[1] - (x > 0 ? old->pixlen : 0);
      xindex[2]= xindex[1] + (x < old->width - 1 ? old->pixlen : 0);
      for (y1= 0; y1 < 3; y1++) {
	for (x1= 0; x1 < 3; x1++) {
	  pixval= memToVal(yindex[y1] + xindex[x1], old->pixlen);
	  avgred += TRUE_RED(pixval);
	  avggreen += TRUE_GREEN(pixval);
	  avgblue += TRUE_BLUE(pixval);
	}
      }

      /* average the pixel values
       */

      avgred= ((avgred + 8) / 9);
      avggreen= ((avggreen + 8) / 9);
      avgblue= ((avgblue + 8) / 9);
      pixval= (avgred << 16) | (avggreen << 8) | avgblue;
      valToMem(pixval, destptr, new->pixlen);
      destptr += new->pixlen;
    }
  }

  if (old != image)
    freeImage(old);
  return(new);
}

Image *smooth(image, iterations, verbose)
     Image *image;
     int    iterations;
     int    verbose;
{ int a;
  Image *old, *new;

  if (verbose) {
    fprintf(stderr, "  Smoothing...");
    fflush(stderr);
  }

  old= image;
  for (a= 0; a < iterations; a++) {
    new= doSmooth(old);
    if (image != old)
      freeImage(old);
    old= new;
  }

  if (verbose)
    fprintf(stderr, "done\n");

  return(old);
}
