/* value.c:
 *
 * routines for converting byte values to long values.  these are pretty
 * portable although they are not necessarily the fastest things in the
 * world.
 *
 * jim frost 10.02.89
 *
 * Copyright 1989 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "image.h"

unsigned long doMemToVal(p, len)
     byte         *p;
     unsigned int  len;
{ unsigned int  a;
  unsigned long i;

  i= 0;
  for (a= 0; a < len; a++)
    i= (i << 8) + *(p++);
  return(i);
}

unsigned long doValToMem(val, p, len)
     unsigned long  val;
     byte          *p;
     unsigned int   len;
{ int a;

  for (a= len - 1; a >= 0; a--) {
    *(p + a)= val & 0xff;
    val >>= 8;
  }
  return(val);
}

unsigned long doMemToValLSB(p, len)
     byte         *p;
     unsigned int  len;
{ int val, a;

  val= 0;
  for (a= len - 1; a >= 0; a--)
    val= (val << 8) + *(p + a);
  return(val);
}

/* this is provided for orthagonality
 */

unsigned long doValToMemLSB(val, p, len)
     byte          *p;
     unsigned long  val;
     unsigned int   len;
{
  while (len--) {
    *(p++)= val & 0xff;
    val >>= 8;
  }
  return(val);
}

/* this flips all the bits in a byte array at byte intervals
 */

void flipBits(p, len)
     byte *p;
     unsigned int len;
{ static int init= 0;
  static byte flipped[256];

  if (!init) {
    int a, b;
    byte norm;

    for (a= 0; a < 256; a++) {
      flipped[a]= 0;
      norm= a;
      for (b= 0; b < 8; b++) {
	flipped[a]= (flipped[a] << 1) | (norm & 1);
	norm >>= 1;
      }
    }
  }

  while (len--)
    p[len]= flipped[p[len]];
}
