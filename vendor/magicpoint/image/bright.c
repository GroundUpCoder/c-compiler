/* bright.c
 *
 * miscellaneous colormap altering functions
 *
 * jim frost 10.10.89
 *
 * Copyright 1989, 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"
#include <math.h>   /* gucOS port: pow for make_gamma */

/* gucOS port: make_gamma extracted from rlelib.c (the Utah RLE library
 * is not vendored; this was its only symbol the kept loaders needed). */
static void
make_gamma(double gamma, int gammamap[256])
{
  register int i;

  for (i = 0; i < 256; i++)
    gammamap[i] = (int)(0.5 + 255 * pow(i / 255.0, 1.0/gamma));
}

/* alter an image's brightness by a given percentage
 */

void brighten(image, percent, verbose)
     Image        *image;
     unsigned int  percent;
     unsigned int  verbose;
{ int          a;
  unsigned int newrgb;
  float        fperc;
  unsigned int size;
  byte        *destptr;

  goodImage(image, "brighten");
  if (BITMAPP(image)) /* we're AT&T */
    return;

  if (verbose) {
    fprintf(stderr, "  Brightening colormap by %d%%...", percent);
    fflush(stderr);
  }

  fperc= (float)percent / 100.0;

  switch (image->type) {
  case IRGB:
    for (a= 0; a < image->rgb.used; a++) {
      newrgb= *(image->rgb.red + a) * fperc;
      if (newrgb > 65535)
	newrgb= 65535;
      *(image->rgb.red + a)= newrgb;
      newrgb= *(image->rgb.green + a) * fperc;
      if (newrgb > 65535)
	newrgb= 65535;
      *(image->rgb.green + a)= newrgb;
      newrgb= *(image->rgb.blue + a) * fperc;
      if (newrgb > 65535)
	newrgb= 65535;
      *(image->rgb.blue + a)= newrgb;
    }
    break;

  case ITRUE:
    size= image->width * image->height * 3;
    destptr= image->data;
    for (a= 0; a < size; a++) {
      newrgb= *destptr * fperc;
      if (newrgb > 255)
	newrgb= 255;
      *(destptr++)= newrgb;
    }
    break;
  }
  if (verbose)
    fprintf(stderr, "done\n");
}

void gammacorrect(Image *image, double disp_gam, unsigned int verbose)
{ int          a;
  int gammamap[256];
  unsigned int size;
  byte        *destptr;

  goodImage(image, "gammacorrect");
  if (BITMAPP(image)) /* we're AT&T */
    return;

  if (verbose) {
    fprintf(stderr, "  Adjusting colormap for display gamma of %4.2f...", disp_gam);
    fflush(stderr);
  }

  make_gamma(disp_gam,gammamap);

  switch (image->type) {
  case IRGB:
    for (a= 0; a < image->rgb.used; a++) {
      *(image->rgb.red + a)= gammamap[(*(image->rgb.red + a))>>8]<<8;
      *(image->rgb.green + a)= gammamap[(*(image->rgb.green + a))>>8]<<8;
      *(image->rgb.blue + a)= gammamap[(*(image->rgb.blue + a))>>8]<<8;
    }
    break;

  case ITRUE:
    size= image->width * image->height * 3;
    destptr= image->data;
    for (a= 0; a < size; a++) {
      *destptr= gammamap[*destptr];
      destptr++;
    }
    break;
  }

  if (verbose)
    fprintf(stderr, "done\n");
}

/* this initializes a lookup table for doing normalization
 */

static void setupNormalizationArray(min, max, array, verbose)
     unsigned int min, max;
     byte *array;
     unsigned int verbose;
{ int a;
  unsigned int new;
  float factor;

  if (verbose) {
    fprintf(stderr, "scaling %d:%d to 0:255...", min, max);
    fflush(stderr);
  }
  factor= 256.0 / (max - min);
  for (a= min; a <= max; a++) {
    new= (float)(a - min) * factor;
    array[a]= (new > 255 ? 255 : new);
  }
}

/* normalize an image.
 */

Image *normalize(image, verbose)
     Image        *image;
     unsigned int  verbose;
{ unsigned int  a, x, y;
  unsigned int  min, max;
  Pixel         pixval;
  Image        *newimage=NULL;
  byte         *srcptr, *destptr;
  byte          array[256];

  goodImage(image, "normalize");
  if (BITMAPP(image))
    return(image);

  if (verbose) {
    fprintf(stderr, "  Normalizing...");
    fflush(stderr);
  }
  switch (image->type) {
  case IRGB:
    min= 256;
    max = 0;
    for (a= 0; a < image->rgb.used; a++) {
      byte red, green, blue;

      red= image->rgb.red[a] >> 8;
      green= image->rgb.green[a] >> 8;
      blue= image->rgb.blue[a] >> 8;
      if (red < min)
	min= red;
      if (red > max)
	max= red;
      if (green < min)
	min= green;
      if (green > max)
	max= green;
      if (blue < min)
	min= blue;
      if (blue > max)
	max= blue;
    }
    setupNormalizationArray(min, max, array, verbose);

    newimage= newTrueImage(image->width, image->height);
    if (image->title) {
	newimage->title = (char *)lmalloc(strlen(image->title) + 14);
	sprintf(newimage->title, "%s (normalized)", image->title);
    }
    srcptr= image->data;
    destptr= newimage->data;
    for (y= 0; y < image->height; y++)
      for (x= 0; x < image->width; x++) {
	pixval= memToVal(srcptr, image->pixlen);
	*destptr= array[image->rgb.red[pixval] >> 8];
	(*destptr)++;
	*destptr= array[image->rgb.green[pixval] >> 8];
	(*destptr)++;
	*destptr= array[image->rgb.blue[pixval] >> 8];
	(*destptr)++;
	srcptr += image->pixlen;
      }
    break;

  case ITRUE:
    srcptr= image->data;
    min= 255;
    max= 0;
    for (y= 0; y < image->height; y++)
      for (x= 0; x < image->width; x++) {
	if (*srcptr < min)
	  min= *srcptr;
	if (*srcptr > max)
	  max= *srcptr;
	srcptr++;
	if (*srcptr < min)
	  min= *srcptr;
	if (*srcptr > max)
	  max= *srcptr;
	srcptr++;
	if (*srcptr < min)
	  min= *srcptr;
	if (*srcptr > max)
	  max= *srcptr;
	srcptr++;
      }
    setupNormalizationArray(min, max, array, verbose);

    srcptr= image->data;
    for (y= 0; y < image->height; y++)
      for (x= 0; x < image->width; x++) {
	*srcptr= array[*srcptr];
	srcptr++;
	*srcptr= array[*srcptr];
	srcptr++;
	*srcptr= array[*srcptr];
	srcptr++;
      }
    newimage= image;
  }

  if (verbose)
    fprintf(stderr, "done\n");
  return(newimage);
}

/* convert to grayscale
 */

void gray(image, verbose)
     Image *image;
     int verbose;
{ int a;
  unsigned int size;
  Intensity intensity, red, green, blue;
  byte *destptr;

  goodImage(image, "gray");
  if (BITMAPP(image))
    return;

  if (verbose) {
    fprintf(stderr, "  Converting image to grayscale...");
    fflush(stderr);
  }
  switch (image->type) {
  case IRGB:
    for (a= 0; a < image->rgb.used; a++) {
      intensity= colorIntensity(image->rgb.red[a],
				image->rgb.green[a],
				image->rgb.blue[a]);
      image->rgb.red[a]= intensity;
      image->rgb.green[a]= intensity;
      image->rgb.blue[a]= intensity;
    }
    break;

  case ITRUE:
    size= image->width * image->height;
    destptr= image->data;
    for (a= 0; a < size; a++) {
      red= *destptr << 8;
      green= *(destptr + 1) << 8;
      blue= *(destptr + 2) << 8;
      intensity= colorIntensity(red, green, blue) >> 8;
      *(destptr++)= intensity; /* red */
      *(destptr++)= intensity; /* green */
      *(destptr++)= intensity; /* blue */
    }
    break;
  }
  if (verbose)
    fprintf(stderr, "done\n");
}
