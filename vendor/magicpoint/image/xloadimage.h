/* xloadimage.h:
 *
 * jim frost 06.21.89
 *
 * Copyright 1989 Jim Frost.  See included file "copyright.h" for complete
 * copyright information.
 */

#include "copyright.h"
#include <stdio.h>
#include "../sdlx.h"   /* gucOS port */

#include "image.h"
#include "options.h"

#ifdef USE_IMLIB
#include <Imlib.h>
#endif

/* image name and option structure used when processing arguments
 */

typedef struct {
  char         *name;         /* name of image */
  int           atx, aty;     /* location to load image at */
  unsigned int  bright;       /* brightness multiplier */
  unsigned int  center;       /* true if image is to be centered */
  unsigned int  clipx, clipy; /* area of image to be used */
  unsigned int  clipw, cliph;
  unsigned int  colors;       /* max # of colors to use for this image */
  unsigned int  delay;        /* # of seconds delay before auto pic advance */
  unsigned int  dither;       /* true if image is to be dithered */
  float         gamma;        /* display gamma */
  char         *go_to;        /* label to goto */
  unsigned int  gray;         /* true if image is to be grayed */
  unsigned int  merge;        /* true if we should merge onto previous */
  unsigned int  normalize;    /* true if image is to be normalized */
  int           rotate;	      /* # degrees to rotate image */
  unsigned int  smooth;       /* true if image is to be smoothed */
  unsigned int  xzoom, yzoom; /* zoom percentages */
  char         *fg, *bg;      /* foreground/background colors if mono image */
} ImageOptions;

/* This struct holds the X-client side bits for a rendered image.
 */

typedef struct {
  Display  *disp;       /* destination display */
  int       scrn;       /* destination screen */
  int       depth;      /* depth of drawable we want/have */
  Drawable  drawable;   /* drawable to send image to */
  Pixel     foreground; /* foreground and background pixels for mono images */
  Pixel     background;
  Colormap  cmap;       /* colormap used for image */
  GC        gc;         /* cached gc for sending image */
  XImage   *ximage;     /* ximage structure */
} XImageInfo;

#ifndef MAXIMAGES
#define MAXIMAGES BUFSIZ /* max # of images we'll try to load at once */
#endif

/* function declarations
 */

void supportedImageTypes(); /* imagetypes.c */

char *tail(); /* misc.c */
void memoryExhausted();
void internalError();
void version();
void usage();
void goodImage();
Image *processImage();
int errorHandler();

char *expandPath(); /* path.c */
int findImage();
void listImages();
void loadPathsAndExts();
void showPath();

void imageOnRoot(); /* root.c */

void        sendXImage(); /* send.c */
XImageInfo *imageToXImage();
Pixmap      ximageToPixmap();
void        freeXImage();

Visual *getBestVisual(); /* visual.c */

int   visualClassFromName(); /* window.c */
char *nameOfVisualClass();
void cleanUpWindow();
char imageInWindow();
