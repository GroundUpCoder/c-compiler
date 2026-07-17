/* path.c:
 *
 * functions that deal with the image path
 *
 * jim frost 10.03.89
 *
 * Copyright 1989, 1990, 1991 Jim Frost.
 * See included file "copyright.h" for complete copyright information.
 */

#include "copyright.h"
#include "xloadimage.h"
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <ctype.h>
#ifndef VMS
#include <pwd.h>
#endif
#include <errno.h>
#if 1 /* SYSV */
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <stdlib.h>
#endif

/* SUPPRESS 530 */
/* SUPPRESS 560 */

extern int errno;

/*static*/ unsigned int  NumPaths= 0;
static unsigned int  NumExts= 0;
/*static*/ char         *Paths[BUFSIZ];
static char         *Exts[BUFSIZ];
static char         *PathToken= "path=";
static char         *ExtToken= "extension=";

#define VOIDSECTION 0
#define PATHSECTION 1
#define EXTSECTION  2

static void readPathsAndExts(name)
     char *name;
{ FILE         *f;
  char          tokenbuf[BUFSIZ];
  char          buf[BUFSIZ];
  unsigned int  secnum;
  unsigned int  linenum;
  unsigned int  a, b, l;
  int           c;

  if (! (f= fopen(name, "r")))
    return;

  secnum= VOIDSECTION;
  linenum= 0;
  while (fscanf(f, "%s", tokenbuf) > 0) {
    linenum++;
    l= strlen(tokenbuf);
    for (a= 0, b= 0; a < l; a++, b++) {
      if (tokenbuf[a] == '\\')
	tokenbuf[b]= tokenbuf[++a];
      else if (b != a)
	tokenbuf[b]= tokenbuf[a];
      if (tokenbuf[a] == '#') {
	tokenbuf[b]= '\0';
	while (((c= fgetc(f)) != '\n') && (c != EOF))
	  ;
	break;
      }
    }

    if (!strncmp(tokenbuf, PathToken, strlen(PathToken))) {
      secnum= PATHSECTION;
      if (sscanf(tokenbuf + strlen(PathToken), "%s", buf) != 1)
	continue;
    }
    else if (!strncmp(tokenbuf, ExtToken, strlen(ExtToken))) {
      secnum= EXTSECTION;
      if (sscanf(tokenbuf + strlen(ExtToken), "%s", buf) != 1)
	continue;
    }
    else
      strcpy(buf, tokenbuf);
    if (buf[0] == '\0')
      continue;

    switch (secnum) {
    case VOIDSECTION:
      fprintf(stderr, "%s: %d: Syntax error\n", name, linenum); /* ala BASIC */
      fclose(f);
      return;
    case PATHSECTION:
      if (NumPaths < BUFSIZ - 1)
	Paths[NumPaths++]= expandPath(buf);
      else {
	fprintf(stderr, "%s: %d: Path table overflow\n", name, linenum);
	fclose(f);
	return;
      }
      break;
    case EXTSECTION:
      if (NumExts < BUFSIZ - 1)
	Exts[NumExts++]= dupString(buf);
      else {
	fprintf(stderr, "%s: %d: Extension table overflow\n", name, linenum);
	fclose(f);
      }
      break;
    }
  }
}

void loadPathsAndExts()
{ static int     havepaths= 0;
#ifndef VMS
  struct passwd *pw;
#endif
  char           buf[BUFSIZ];

  if (havepaths)
    return;
  havepaths= 1;

#ifdef VMS
  sprintf(buf, "/sys$scratch/.xloadimagerc");
#else /* !VMS */
  if (! (pw= (struct passwd *)getpwuid(getuid()))) {
    fprintf(stderr, "Can't find your password file entry?!?\n");
    return;
  }
  sprintf(buf, "%s/.xloadimagerc", pw->pw_dir);
#endif /* !VMS */
  if (! access(buf, R_OK)) {
    readPathsAndExts(buf);
    return; /* don't read system file if user has one */
  }
#ifdef SYSPATHFILE
  readPathsAndExts(SYSPATHFILE);
#endif
}

static int fileIsOk(fullname, sbuf)
     char *fullname;
     struct stat *sbuf;
{
  if ((sbuf->st_mode & S_IFMT) == S_IFDIR) /* is a directory */
    return(0);
  return(access(fullname, R_OK)); /* we can read it */
}

/* find an image with paths and extensions from defaults files.  returns
 * -1 if access denied or not found, 0 if ok.
 */

int findImage(name, fullname)
     char *name, *fullname;
{ unsigned int   p, e;
  struct stat    sbuf;
#ifdef MGP_NATIVE
  const char *assetdir;
#endif

  strcpy(fullname, name);
  if (!strcmp(name, "stdin")) /* stdin is special name */
    return(0);

  /* look for name and name with compress extension
   */
  if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
#ifdef MGP_NATIVE
  /* Seeded decks use their installed gucOS path.  A native oracle can point
   * that stable deck spelling at the same bundled asset without editing it. */
  assetdir= getenv("MGP_ASSET_DIR");
  if (assetdir && !strncmp(name, "/usr/share/mgp/", 15)) {
    snprintf(fullname, BUFSIZ, "%s/%s", assetdir, name + 15);
    if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
  }
#endif
#ifndef NO_COMPRESS
  strcat(fullname, ".Z");
  if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
#endif

  for (p= 0; p < NumPaths; p++) {
    sprintf(fullname, "%s/%s", Paths[p], name);
    if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
#ifndef NO_COMPRESS
    strcat(fullname, ".Z");
    if (! stat(fullname, &sbuf))
#endif
      return(fileIsOk(fullname, &sbuf));
    for (e= 0; e < NumExts; e++) {
      sprintf(fullname, "%s/%s%s", Paths[p], name, Exts[e]);
      if (! stat(fullname, &sbuf))
	return(fileIsOk(fullname, &sbuf));
#ifndef NO_COMPRESS
      strcat(fullname, ".Z");
      if (! stat(fullname, &sbuf))
	return(fileIsOk(fullname, &sbuf));
#endif
    }
  }

  for (e= 0; e < NumExts; e++) {
    sprintf(fullname, "%s%s", name, Exts[e]);
    if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
#ifndef NO_COMPRESS
    strcat(fullname, ".Z");
    if (! stat(fullname, &sbuf))
      return(fileIsOk(fullname, &sbuf));
#endif
  }
  errno= ENOENT; /* file not found */
  return(-1);
}

/* list images along our path
 */

void listImages()
{ unsigned int a;
  char         buf[BUFSIZ];

  if (!NumPaths) {
    fprintf(stderr, "No image path\n");
    return;
  }
  for (a= 0; a < NumPaths; a++) {
    fprintf(stderr, "%s:\n", Paths[a]);
    fflush(stderr);
    sprintf(buf, "ls %s", Paths[a]);
    if (system(buf) < 0) {
      perror("ls");
      return;
    }
  }
  return;
}

void showPath()
{ int a;

  if (!NumPaths && !NumExts) {
    fprintf(stderr, "No image paths or extensions\n");
    return;
  }
  if (NumPaths) {
    fprintf(stderr, "Image path:");
    for (a= 0; a < NumPaths; a++)
      fprintf(stderr, " %s", Paths[a]);
    fprintf(stderr, "\n");
  }
  if (NumExts) {
    fprintf(stderr, "Image extensions:");
    for (a= 0; a < NumExts; a++)
      fprintf(stderr, " %s", Exts[a]);
    fprintf(stderr, "\n");
  }
}

char *expandPath(p)
     char *p;
{ char buf1[BUFSIZ], buf2[BUFSIZ];
  int b1, b2, var;
  char *ptr;

  char *getenv();

  buf1[0] = '\0';
  buf2[0] = '\0';
  b1 = 0;
  b2 = 0;
  var = 0;

  while(*p) {
    if(isspace(*p)) break;
    if (*p == '$') var++;
    else if(*p == '~') {
      buf1[b1] = '\0';
      strcat(buf1, getenv("HOME"));
      b1 = strlen(buf1);
      var = 0;
    }
    else if(*p == '/' || *p == '}') {
      if(var) {
	buf1[b1] = '\0';
	buf2[b2] = '\0';
	strcat(buf1, getenv(buf2));
	b1 = strlen(buf1);
	buf2[0] = '\0';
	b2 = 0;
	var = 0;
      }
      if(*p == '/') {
	buf1[b1] = *p;
	b1++;
      }
    }
    else if(var) {
      if(*p != '{') {
	buf2[b2] = *p;
	b2++;
      }
    }
    else {
      buf1[b1] = *p;
      b1++;
    }
    p++;
  }

  buf1[b1] = '\0';
  
  if((b2 = strlen(buf1)) > 0) {
    ptr = (char *)lmalloc((unsigned) b2+1);
    strcpy(ptr, buf1);
    return(ptr);
  }
  else
    return(NULL);

}
