/* misc.c:
 *
 * miscellaneous funcs
 *
 * jim frost 10.05.89
 *
 * Copyright 1989, 1990, 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "xloadimage.h"
#include "patchlevel"
#include <signal.h>
#include <stdlib.h>

extern int      _Xdebug;
extern Display *display;
extern int      screen;

static char *signalName(sig)
     int sig;
{ static char buf[32];

  switch (sig) {
  case SIGSEGV:
    return("SEGV");
  case SIGBUS:
    return("BUS");
  case SIGFPE:
    return("FPE");
  case SIGILL:
    return("ILL");
  default:
    sprintf(buf, "Signal %d", sig);
    return(buf);
  }
}

void memoryExhausted()
{
  fprintf(stderr,
	  "Memory has been exhausted; operation cannot continue (sorry).\n");
  cleanup(-1);
}

void internalError(sig)
     int sig;
{
  /* gucOS port: the X-server info dump is gone with the X server */
  fprintf(stderr, "An internal error (%d) has occurred.\n", sig);
  cleanup(-1);
}

void version()
{
  fprintf(stderr, "Xloadimage version %s patchlevel %s by Jim Frost.\n",
	 VERSION, PATCHLEVEL);
  fprintf(stderr, "Please send email to %s for\npraise or bug reports.\n",
	 AUTHOR_EMAIL);
}

void usage(name)
     char *name;
{
  version();
  fprintf(stderr, "\nUsage: %s [global options] {[image options] image_name ...}\n\n",
	 tail(name));
  fprintf(stderr, "\
Type `%s -help [option ...]' for information on a particular option, or\n\
`%s -help' to enter the interactive help facility.\n", tail(name), tail(name));
  cleanup(-1);
}

char *tail(path)
     char *path;
{ int   s;
  char *t;

  t= path;
  for (s= 0; *(path + s) != '\0'; s++)
    if (*(path + s) == '/')
      t= path + s + 1;
  return(t);
}

Image *processImage(disp, scrn, image, options, verbose)
     Display      *disp;
     int           scrn;
     Image        *image;
     ImageOptions *options;
     unsigned int  verbose;
{ Image        *tmpimage;
  XColor        xcolor;
  unsigned int  compressed= 0;
  void          gammacorrect(Image *, double, unsigned int);

  goodImage(image, "processImage");

  /* clip the image if requested
   */

  if ((options->clipx != 0) || (options->clipy != 0) ||
      (options->clipw != 0) || (options->cliph != 0)) {
    if (!options->clipw)
      options->clipw= image->width;
    if (!options->cliph)
      options->cliph= image->height;
    tmpimage= clip(image, options->clipx, options->clipy,
		   (options->clipw ? options->clipw : image->width),
		   (options->cliph ? options->cliph : image->height),
		   verbose);
    freeImage(image);
    image= tmpimage;
  }

  if (options->rotate) {
    tmpimage = rotate(image, options->rotate, verbose);
    freeImage(image);
    image = tmpimage;
  }

  if (options->xzoom || options->yzoom) { /* zoom image */
    if (!options->colors && RGBP(image) &&              /* if the image is to */
	((!options->xzoom && (options->yzoom > 100)) || /* be blown up, */
	 (!options->yzoom && (options->xzoom > 100)) || /* compress before */
	 (options->xzoom + options->yzoom > 200))) {    /* doing it */
      compress_colormap(image, verbose);
      compressed= 1;
    }
    tmpimage= zoom(image, options->xzoom, options->yzoom, verbose);
    freeImage(image);
    image= tmpimage;
  }

  if (options->gray) /* convert image to grayscale */
    gray(image, verbose);

  if (options->normalize) { /* normalize image */
    tmpimage= normalize(image, verbose);
    if (tmpimage != image) {
      freeImage(image);
      image= tmpimage;
    }
  }

  if (options->bright) /* alter image brightness */
    brighten(image, options->bright, verbose);

  if (options->gamma != 1.0) /* do display gamma compensation */
    gammacorrect(image, options->gamma, verbose);

  /* forcibly reduce colormap
   */

  if (options->colors && RGBP(image) && (options->colors < image->rgb.used)) {
    tmpimage= reduce(image, options->colors, verbose);
    if (tmpimage != image) {
      freeImage(image);
      image= tmpimage;
    }
    image->rgb.size= options->colors; /* lie */
    compressed= 1;
  }

  if (options->dither && (image->depth > 1)) { /* image is to be dithered */
    if (options->dither == 1)
      tmpimage= dither(image, verbose);
    else
      tmpimage= halftone(image, verbose);
    freeImage(image);
    image= tmpimage;
  }
  else if (!compressed)       /* make sure colormap is minimized */
    compress_colormap(image, verbose);

  if (options->smooth > 0) { /* image is to be smoothed */
    tmpimage= smooth(image, options->smooth, verbose);
    if (tmpimage != image) {
      freeImage(image);
      image= tmpimage;
    }
  }

  /* set foreground and background colors of mono image
   */

  xcolor.flags= DoRed | DoGreen | DoBlue;
  if ((image->depth == 1) && options->fg) {
    XParseColor(disp, DefaultColormap(disp, scrn), options->fg, &xcolor);
    *(image->rgb.red + 1)= xcolor.red;
    *(image->rgb.green + 1)= xcolor.green;
    *(image->rgb.blue + 1)= xcolor.blue;
  }
  if ((image->depth == 1) && options->bg) {
    XParseColor(disp, DefaultColormap(disp, scrn), options->bg, &xcolor);
    *image->rgb.red= xcolor.red;
    *image->rgb.green= xcolor.green;
    *image->rgb.blue= xcolor.blue;
  }
  return(image);
}

/* gucOS port: errorHandler (XErrorEvent) removed with the X server. */

/*
  strstr - public-domain implementation of standard C library function

  last edit:	02-Sep-1990	D A Gwyn

  This is an original implementation based on an idea by D M Sunday,
  essentially the "quick search" algorithm described in CACM V33 N8.
  Unlike Sunday's implementation, this one does not wander past the
  ends of the strings (which can cause malfunctions under certain
  circumstances), nor does it require the length of the searched
  text to be determined in advance.  There are numerous other subtle
  improvements too.  The code is intended to be fully portable, but in
  environments that do not conform to the C standard, you should check
  the sections below marked "configure as required".  There are also
  a few compilation options, as follows:
*/

#ifndef UCHAR_MAX
#define UCHAR_MAX 255
#endif

typedef unsigned char cuc;	/* char variety used in algorithm */

#define EOS '\0'		/* C string terminator */

char *					/* returns -> leftmost occurrence,
					   or null pointer if not present */
vstrstr( s1, s2 )
     char	*s1;		/* -> string to be searched */
     char	*s2;		/* -> search-pattern string */
{
  register cuc	*t;		/* -> text character being tested */
  register cuc	*p;		/* -> pattern char being tested */
  register cuc	*tx;		/* -> possible start of match */
  register unsigned int	m;      /* length of pattern */
  register cuc	*top;		/* -> high water mark in text */
  unsigned int  shift[UCHAR_MAX + 1];	/* pattern shift table */

  if ( s1 == NULL || s2 == NULL )
    return NULL;		/* certainly, no match is found! */

  /* Precompute shift intervals based on the pattern;
     the length of the pattern is determined as a side effect: */

  memset(&shift[1], 0, 255);

  /* Note: shift[0] is undefined at this point (fixed later). */

  for ( m = 1, p = (cuc *)s2; *p != EOS; ++m, ++p )
    shift[(cuc)*p] = m;

  {
    register unsigned char c;

    c = UCHAR_MAX;
    do
      shift[c] = m - shift[c];
    while ( --c > 0 );
    /* Note: shift[0] is still undefined at this point. */
  }

  shift[0] = --m; 		/* shift[EOS]; important details! */

  /* Try to find the pattern in the text string: */

  for ( top = tx = (cuc *)s1; ; tx += shift[*(top = t)] ) {
    for ( t = tx, p = (cuc *)s2; ; ++t, ++p ) {
      if ( *p == EOS )       /* entire pattern matched */
	return (char *)tx;
      if ( *p != *t )
	break;
    }
    if ( t < top ) /* idea due to ado@elsie.nci.nih.gov */
      t = top;	   /* already scanned this far for EOS */
    do	{
      if ( *t == EOS )
	return NULL;	/* no match */
    } while ( ++t - tx != m );	/* < */
  }
}

