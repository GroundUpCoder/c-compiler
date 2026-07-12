/* zio.c:
 *
 * this properly opens and reads from an image file, compressed or otherwise.
 *
 * jim frost 10.03.89
 *
 * this was hacked on 09.12.90 to cache reads and to use stdin.
 *
 * Copyright 1989, 1990 Jim Frost.  See included file "copyright.h" for
 * complete copyright information.
 */

#include "copyright.h"
#include "image.h"

#ifdef VMS
#define NO_UNCOMPRESS /* VMS doesn't have uncompress */
#endif

#define MAX_ZFILES 32

static ZFILE ZFileTable[MAX_ZFILES];

/* read some info through the read cache
 */

static int doRead(zf, buf, len)
     ZFILE *zf;
     byte *buf;
     int len;
{ int bread, readlen;

  /* loop through the read
   */

  for (bread= 0; bread < len; bread += readlen, zf->bufptr += readlen) {

    /* read new or move to next data block if necessary
     */

    if (!zf->dataptr || (zf->bufptr == zf->dataptr->len)) {

      if (zf->dataptr && zf->dataptr->next)
	zf->dataptr= zf->dataptr->next;
      else {
	if (!zf->dataptr) {

	  /* if the reader told us to stop caching, just do the read.
	   */

	  if (zf->nocache)
	    return(fread(zf->dataptr->buf, 1, BUFSIZ, zf->stream));
	  zf->data= zf->dataptr= (struct cache *)lmalloc(sizeof(struct cache));
	}
	else {
	  zf->dataptr->next= (struct cache *)lmalloc(sizeof(struct cache));
	  zf->dataptr= zf->dataptr->next;
	}
	zf->dataptr->next= NULL;
	zf->dataptr->len= fread(zf->dataptr->buf, 1, BUFSIZ, zf->stream);
	if (zf->dataptr->len < 0) {
	  perror("fread");
	  cleanup(-1);
	}
      }
      zf->bufptr= 0;
    }

    /* calculate length we can get out of read buffer
     */

    readlen= (len - bread > zf->dataptr->len - zf->bufptr ?
	      zf->dataptr->len - zf->bufptr : len - bread);
    if (!readlen) /* we're at EOF */
      return(bread);
    memcpy(buf + bread, zf->dataptr->buf + zf->bufptr, readlen);
  }
  return(bread);
}

/* reset a read cache
 */

void zreset(filename)
     char *filename;
{ int a;
  struct cache *old;

  /* if NULL filename, reset the entire table
   */

  if (!filename) {
    for (a= 0; a < MAX_ZFILES; a++)
      if (ZFileTable[a].filename)
	zreset(ZFileTable[a].filename);
    return;
  }

  for (a= 0; a < MAX_ZFILES; a++)
    if (ZFileTable[a].filename && !strcmp(filename, ZFileTable[a].filename))
      break;

  if (a == MAX_ZFILES) /* no go joe */
    return;

  if (ZFileTable[a].dataptr != ZFileTable[a].data)
    fprintf(stderr, "zreset: warning: ZFILE for %s was not closed properly\n",
	   ZFileTable[a].filename);
  while (ZFileTable[a].data) {
    old= ZFileTable[a].data;
    ZFileTable[a].data= ZFileTable[a].data->next;
    lfree(old);
  }
  lfree((byte *)ZFileTable[a].filename);
  ZFileTable[a].filename= NULL;
  ZFileTable[a].dataptr= NULL;
  ZFileTable[a].bufptr= 0;
  ZFileTable[a].nocache= 0;

  switch(ZFileTable[a].type) {
  case ZSTANDARD:
    fclose(ZFileTable[a].stream);
    break;
#ifndef NO_UNCOMPRESS
  case ZPIPE:
    pclose(ZFileTable[a].stream);
    break;
#endif /* NO_UNCOMPRESS */
  case ZSTDIN:
    break;
  default:
    fprintf(stderr, "zreset: bad ZFILE structure\n");
    cleanup(-1);
  }
}

#ifdef __APPLE__
ZFILE *zzopen(name)
#else
ZFILE *zopen(name)
#endif
     char *name;
{ int    a;
  ZFILE *zf;
  char   buf[BUFSIZ];

  /* look for filename in open file table
   */

  for (a= 0; a < MAX_ZFILES; a++)
    if (ZFileTable[a].filename && !strcmp(name, ZFileTable[a].filename)) {

      /* if we try to reopen a file whose caching was disabled, warn the user
       * and try to recover.  we cannot recover if it was stdin.
       */

      if (ZFileTable[a].nocache) {
	if (ZFileTable[a].type == ZSTDIN) {
	  fprintf(stderr, "zopen: caching was disabled by previous caller; can't reopen stdin\n");
	  return(NULL);
	}
	fprintf(stderr, "zopen: warning: caching was disabled by previous caller\n");
	zreset(ZFileTable[a].filename);
	break;
      }
      if (ZFileTable[a].dataptr != ZFileTable[a].data)
	fprintf(stderr, "zopen: warning: file doubly opened\n");
      ZFileTable[a].dataptr= ZFileTable[a].data;
      ZFileTable[a].bufptr= 0;
      return(ZFileTable + a);
    }

  /* find open ZFileTable entry
   */

  for (a= 0; (a < MAX_ZFILES) && ZFileTable[a].filename; a++)
    /* EMPTY */
    ;

  if (a == MAX_ZFILES) {
    fprintf(stderr, "zopen: no more files available\n");
    cleanup(-1);
  }
  zf= ZFileTable + a;

  zf->filename= dupString(name);
  zf->dataptr= NULL;
  zf->bufptr= 0;
  zf->nocache= 0;

  /* file filename is `stdin' then use stdin
   */

  if (!strcmp(name, "stdin")) {
    zf->type= ZSTDIN;
    zf->stream= stdin;
    return(zf);
  }

#ifndef NO_UNCOMPRESS
  /* if filename ends in `.Z' then open pipe to uncompress.  if your
   * system doesn't have uncompress you can define NO_UNCOMPRESS and
   * it just won't check for this.
   */

  if ((strlen(name) > 2) && !strcmp(".Z", name + (strlen(name) - 2))) {
    zf->type= ZPIPE;
    sprintf(buf, "uncompress -c %s", name);
    if (! (zf->stream= popen(buf, "r"))) {
	lfree(zf->filename);
	zf->filename= NULL;
	return(NULL);
    }
    return(zf);
  }
#endif

  /* default to normal stream
   */

  zf->type= ZSTANDARD;
  if (!
#ifdef VMS
      (zf->stream= fopen(name, "r", "ctx=bin", "ctx=stm", "rfm=stmlf"))
#else
      (zf->stream= fopen(name, "r"))
#endif
      ) {
    lfree(zf->filename);
    zf->filename= NULL;
    return(NULL);
  }
  return(zf);
}

int zread(zf, buf, len)
     ZFILE        *zf;
     byte         *buf;
     unsigned int  len;
{
  return(doRead(zf, buf, len));
}

int zgetc(zf)
     ZFILE *zf;
{ unsigned char c;

  if (doRead(zf, &c, 1) > 0)
    return(c);
  else
    return(EOF);
}

char *zgets(buf, size, zf)
     byte         *buf;
     unsigned int  size;
     ZFILE        *zf;
{ int p= 0;

  while (doRead(zf, buf + p, 1) > 0) {
    if (p == size)
      return((char *)buf);
    if (*(buf + p) == '\n') {
      *(buf + p + 1)= '\0';
      return((char *)buf);
    }
    p++;
  }
  return(NULL);
}

/* this turns off caching when an image has been identified and we will not
 * need to re-open it
 */

void znocache(zf)
     ZFILE *zf;
{
  zf->nocache= 1;
}

/* reset cache pointers in a ZFILE.  nothing is actually reset until a
 * zreset() is called with the filename.
 */

void zclose(zf)
     ZFILE *zf;
{
  zf->dataptr= zf->data;
  zf->bufptr= 0;
}
