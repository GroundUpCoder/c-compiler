/* image.h:
 *
 * portable image type declarations
 *
 * jim frost 10.02.89
 *
 * Copyright 1989 Jim Frost.  See included file "copyright.h" for complete
 * copyright information.
 */

#include "copyright.h"
#include <stdio.h>

#if defined(SYSV) || defined(VMS) || 1
#include <string.h>
#ifndef index /* some SysV's do this for you */
#define index strchr
#endif
#ifndef rindex
#define rindex strrchr
#endif
#ifndef HAS_MEMCPY
#define HAS_MEMCPY
#endif
#else /* !SYSV && !VMS */
#include <strings.h>
#endif /* !SYSV && !VMS */

#ifdef VMS
#define R_OK 4
#define NO_UNCOMPRESS
#endif

#ifdef HAS_MEMCPY

/* equate bcopy w/ memcpy and bzero w/ memset where appropriate.
 */

#ifndef bcopy
#define bcopy(P1,P2,N) memcpy((char *)(P2),(char *)(P1),(N))
#endif
#ifndef bzero
#define bzero(P,N) memset((P),'\0',(N))
#endif
#endif /* HAS_MEMCPY */

typedef unsigned long  Pixel;     /* what X thinks a pixel is */
typedef unsigned short Intensity; /* what X thinks an RGB intensity is */
typedef unsigned char  byte;      /* byte type */

struct cache {
  int           len;
  char          buf[BUFSIZ];
  struct cache *next;
};

typedef struct {
  unsigned int  type;     /* ZIO file type */
  unsigned int  nocache;  /* true if caching has been disabled */
  FILE         *stream;   /* file input stream */
  char         *filename; /* filename */
  struct cache *data;     /* data cache */
  struct cache *dataptr;  /* ptr to current cache block */
  int           bufptr;   /* ptr within current cache block */
} ZFILE;

#define ZSTANDARD 0 /* standard file */
#define ZPIPE     1 /* file is a pipe (ie uncompress) */
#define ZSTDIN    2 /* file is stdin */

typedef struct rgbmap {
  unsigned int  size;       /* size of RGB map */
  unsigned int  used;       /* number of colors used in RGB map */
  unsigned int  compressed; /* image uses colormap fully */
  Intensity    *red;        /* color values in X style */
  Intensity    *green;
  Intensity    *blue;
} RGBMap;

/* image structure
 */

typedef struct {
  char         *title;  /* name of image */
  unsigned int  type;   /* type of image */
  RGBMap        rgb;    /* RGB map of image if IRGB type */
  unsigned int  width;  /* width of image in pixels */
  unsigned int  height; /* height of image in pixels */
  unsigned int  depth;  /* depth of image in bits if IRGB type */
  unsigned int  pixlen; /* length of pixel if IRGB type */
  byte         *data;   /* data rounded to full byte for each row */
  int		trans;	/* transparent index in rgb */
} Image;

#define IBITMAP 0 /* image is a bitmap */
#define IRGB    1 /* image is RGB */
#define ITRUE   2 /* image is true color */

#define BITMAPP(IMAGE) ((IMAGE)->type == IBITMAP)
#define RGBP(IMAGE)    ((IMAGE)->type == IRGB)
#define TRUEP(IMAGE)   ((IMAGE)->type == ITRUE)

#define TRUE_RED(PIXVAL)   (((PIXVAL) & 0xff0000) >> 16)
#define TRUE_GREEN(PIXVAL) (((PIXVAL) & 0xff00) >> 8)
#define TRUE_BLUE(PIXVAL)  ((PIXVAL) & 0xff)
#define RGB_TO_TRUE(R,G,B) \
  ((((R) & 0xff00) << 8) | ((G) & 0xff00) | ((B) >> 8))

/* special case 1-byte transfers so they're inline
 */

#define memToVal(PTR,LEN)    ((LEN) == 1 ? (unsigned long)(*(PTR)) : \
			      doMemToVal(PTR,LEN))
#define memToValLSB(PTR,LEN) ((LEN) == 1 ? (unsigned long)(*(PTR)) : \
			      doMemToValLSB(PTR,LEN))
#define valToMem(VAL,PTR,LEN)    ((LEN) == 1 ? \
				  (unsigned long)(*(PTR) = (byte)(VAL)) : \
				  doValToMem(VAL,PTR,LEN))
#define valToMemLSB(VAL,PTR,LEN) ((LEN) == 1 ? \
				  (unsigned long)(*(PTR) = (byte)(VAL)) : \
				  (int)doValToMemLSB(VAL,PTR,LEN))

/* SUPPRESS 558 */

/* function declarations
 */

Image *clip(); /* clip.c */

void brighten(); /* bright.c */
void equalize();
void gray();
Image *normalize();

void compress_colormap(); /* compress.c */

Image *dither(); /* dither.c */

void fill(); /* fill.c */

void fold(); /* fold.c */

Image *halftone(); /* halftone.c */

Image *loadImage(); /* imagetypes.c */
void   identifyImage();
void   goodImage();

Image *merge(); /* merge.c */

extern unsigned long DepthToColorsTable[]; /* new.c */
unsigned long colorsToDepth();
char  *dupString();
Image *newBitImage();
Image *newRGBImage();
Image *newTrueImage();
void   freeImage();
void   freeImageData();
void   newRGBMapData();
void   freeRGBMapData();
byte  *lcalloc();
byte  *lmalloc();
void   lfree();

#define depthToColors(n) DepthToColorsTable[((n) < 32 ? (n) : 32)]

Image *reduce(); /* reduce.c */
Image *expand();

Image *rotate(); /* rotate.c */

Image *smooth(); /* smooth.c */

/* doMemToVal and doMemToValLSB used to be void type but some compilers
 * (particularly the 4.1.1 SunOS compiler) couldn't handle the
 * (void)(thing= value) conversion used in the macros.
 */

unsigned long doMemToVal(); /* value.c */
unsigned long doValToMem();
unsigned long doMemToValLSB();
unsigned long doValToMemLSB();
void          flipBits();

#ifdef __APPLE__
/*  darwin has zopen() */
ZFILE *zzopen(); /* zio.c */
#define zopen zzopen
#else
ZFILE *zopen(); /* zio.c */
#endif
int    zread();
int    zgetc();
char  *zgets();
void   zclose();
void   znocache();
void   zreset();

Image *zoom(Image *, double, double, int); /* gucOS port: real prototype so
                                             * int/float call sites convert */

/* this returns the (approximate) intensity of an RGB triple
 */

#define colorIntensity(R,G,B) \
  (RedIntensity[(R) >> 8] + GreenIntensity[(G) >> 8] + BlueIntensity[(B) >> 8])

extern unsigned short RedIntensity[];
extern unsigned short GreenIntensity[];
extern unsigned short BlueIntensity[];

extern void cleanup(int);
