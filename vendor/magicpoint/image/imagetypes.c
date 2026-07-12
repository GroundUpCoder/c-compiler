/* imagetypes.c:
 *
 * this contains things which reference the global ImageTypes array
 *
 * jim frost 09.27.89
 *
 * Copyright 1989, 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"
#include "imagetypes.h"
#include <errno.h>

/* some of these are order-dependent
 */

/* gucOS port: real prototypes — unprototyped fn-pointer calls with args
 * don't fly on wasm's typed call instructions. All loaders share these
 * shapes upstream anyway. */
static struct imagetypes {
  int    (*identifier)(char *, char *);
  Image *(*loader)(char *, char *, unsigned int);
  char  *name;            /* name of this image format */
} ImageTypes[] = {
/* gucOS port: only the loaders vendored for mgp — PNG (libpng), GIF,
 * PBM/PGM/PPM, XBM, XPM. The other xloadimage formats went with their
 * files. */
  { pbmIdent,       pbmLoad,       "Portable Bit Map (PBM, PGM, PPM)" },
#ifdef USE_GIF
  { gifIdent,       gifLoad,       "GIF Image" },
#endif
#ifdef USE_PNG
  { pngIdent,       pngLoad,       "PNG Image" },
#endif
  { xpixmapIdent,   xpixmapLoad,   "X Pixmap" },
  { xbitmapIdent,   xbitmapLoad,   "X Bitmap" },
  { NULL,           NULL,          NULL }
};
/* SUPPRESS 560 */

extern int errno;
extern int findImage(char *, char *);

/* load a named image
 */

Image *loadImage(name, verbose)
     char         *name;
     unsigned int  verbose;
{ char   fullname[BUFSIZ];
  Image *image;
  int    a;

  if (findImage(name, fullname) < 0) {
    if (errno == ENOENT)
      fprintf(stderr, "%s: image not found\n", name);
    else
      perror(fullname);
    return(NULL);
  }
  for (a= 0; ImageTypes[a].loader; a++)
    if ((image = ImageTypes[a].loader(fullname, name, verbose))) {
      zreset(NULL);
      return(image);
    }
  fprintf(stderr, "%s: unknown or unsupported image type\n", fullname);
  zreset(NULL);
  return(NULL);
}

/* identify what kind of image a named image is
 */

void identifyImage(name)
     char *name;
{ char fullname[BUFSIZ];
  int  a;

  if (findImage(name, fullname) < 0) {
    if (errno == ENOENT)
      fprintf(stderr, "%s: image not found\n", name);
    else
      perror(fullname);
    return;
  }
  for (a= 0; ImageTypes[a].identifier; a++) {
    if (ImageTypes[a].identifier(fullname, name)) {
      zreset(NULL);
      return;
    }
}
  zreset(NULL);
  fprintf(stderr, "%s: unknown or unsupported image type\n", fullname);
}

/* tell user what image types we support
 */

void supportedImageTypes()
{ int a;

  fprintf(stderr, "Image types supported:\n");
  for (a= 0; ImageTypes[a].name; a++)
    fprintf(stderr, "  %s\n", ImageTypes[a].name);
}

void goodImage(image, func)
     Image *image;
     char  *func;
{
  if (!image) {
    fprintf(stderr, "%s: nil image\n", func);
    cleanup(-1);
  }
  switch (image->type) {
  case IBITMAP:
  case IRGB:
  case ITRUE:
    break;
  default:
    fprintf(stderr, "%s: bad destination image\n", func);
    cleanup(-1);
  }
}
