/* rotate.c
 *
 * rotate an image
 *
 * Contributed by Tom Tatlow (tatlow@dash.enet.dec.com)
 */

#include "copyright.h"
#include "image.h"

/* rotate_bitmap()
 * converts an old bitmap bit position into a new one
 */
void rotate_bitmap(num, pos, width, height, new_num, new_pos)
int      num;				/* Source byte number       */
int      pos;				/* Source bit position      */
int    width;				/* Width of source bitmap   */
int   height;				/* Height of source bitmap  */
int *new_num;				/* Destination byte number  */
int *new_pos;				/* Destination bit position */
{
  int   slen;				/* Length of source line      */
  int   dlen;				/* Length of destination line */
  int sx, sy;
  int dx, dy;

  slen = (width / 8) + (width % 8 ? 1 : 0);
  dlen = (height / 8) + (height % 8 ? 1 : 0);
  sy = num / slen;
  sx = ((num - (sy * slen)) * 8) + pos;
  dx = (height - sy) - 1;
  dy = sx;
  *new_num = (dx / 8) + (dy * dlen);
  *new_pos = dx % 8;
}

/* rotate()
 * rotates an image
 */
Image *rotate(simage, degrees, verbose)
Image *simage;				/* Image to rotate             */
int    degrees;				/* Number of degrees to rotate */
int    verbose;
{ 
  char buf[BUFSIZ];			/* New title                   */
  Image    *image1;			/* Source image                */
  Image    *image2=NULL;		/* Destination image           */
  byte         *sp;			/* Pointer to source data      */
  byte         *dp;			/* Pointer to destination data */
  int     slinelen;			/* Length of source line       */
  int     dlinelen;			/* Length of destination line  */
  int       bit[8];			/* Array of hex values         */
  int         x, y;
  int         i, b;
  int   newi, newb;
  byte      **yptr;

  bit[0] = 128;
  bit[1] =  64;
  bit[2] =  32;
  bit[3] =  16;
  bit[4] =   8;
  bit[5] =   4;
  bit[6] =   2;
  bit[7] =   1;

  goodImage(simage, "rotate");

  if (verbose)
    { fprintf(stderr, "  Rotating image by %d degrees...", degrees);
      fflush(stderr);
    }
  if (simage->title)
    sprintf(buf, "%s (rotated by %d degrees)", simage->title, degrees);

  image1 = simage;
  do {
    degrees -= 90;
    switch (image1->type) {
    case IBITMAP:
      image2= newBitImage(image1->height, image1->width);
      for (x= 0; x < image1->rgb.used; x++) {
	*(image2->rgb.red + x)= *(image1->rgb.red + x);
	*(image2->rgb.green + x)= *(image1->rgb.green + x);
	*(image2->rgb.blue + x)= *(image1->rgb.blue + x);
      }
      slinelen= (image1->width / 8) + (image1->width % 8 ? 1 : 0);
      sp = image1->data;
      dp = image2->data;
      for (i = 0; i < (slinelen * image1->height); i++)
	for (b = 0; b < 8; b++)
	  if (sp[i] & bit[b])
	    { rotate_bitmap(i, b, image1->width, image1->height, &newi, &newb);
	      dp[newi] |= bit[newb];
	    }
      break;
      
    case IRGB:
      image2= newRGBImage(image1->height, image1->width, image1->depth);
      for (x= 0; x < image1->rgb.used; x++) {
	*(image2->rgb.red + x)= *(image1->rgb.red + x);
	*(image2->rgb.green + x)= *(image1->rgb.green + x);
	*(image2->rgb.blue + x)= *(image1->rgb.blue + x);
      }
      image2->rgb.used= image1->rgb.used;
      /* FALLTHRU */

    case ITRUE:
      if (TRUEP(image1))
	image2= newTrueImage(image1->height, image1->width);

      /* build array of y axis ptrs into destination image
       */

      yptr= (byte **)lmalloc(image1->width * sizeof(char *));
      dlinelen= image1->height * image1->pixlen;
      for (y= 0; y < image1->width; y++)
	yptr[y]= image2->data + (y * dlinelen);

      /* rotate
       */

      sp= image1->data;
      for (y = 0; y < image1->height; y++)
	for (x = 0; x < image1->width; x++) {
	  valToMem(memToVal(sp, image1->pixlen),
		   yptr[x] + ((image1->height - y - 1) * image1->pixlen),
		   image1->pixlen);
	  sp += image1->pixlen;
	}
      lfree(yptr);
      break;
    default:
      fprintf(stderr, "rotate: Unsupported image type\n");
      cleanup(-1);
    }
    if (image1 != simage)
      freeImage(image1);
    image1 = image2;
  } while (degrees);
  image1->title= dupString(buf);
  if (verbose)
    fprintf(stderr, "done\n");
  return(image1);
}
