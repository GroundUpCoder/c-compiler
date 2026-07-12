/* options.h:
 *
 * optionNumber() definitions
 *
 * jim frost 10.03.89
 *
 * Copyright 1989 Jim Frost.  See included file "copyright.h" for complete
 * copyright information.
 */

/* enum with the options in it.  If you add one to this you also have to
 * add its information to Options[] in options.c before it becomes available.
 */

typedef enum option_id {

  /* global options
   */

  OPT_NOTOPT= 0, OPT_BADOPT, OPT_SHORTOPT, BORDER, DBUG, DEFAULT, DELAY,
  DISPLAY, FIT, FORK, FULLSCREEN, GEOMETRY, HELP, IDENTIFY, INSTALL,
  LIST, ONROOT, PATH, PIXMAP, PRIVATE, QUIET, SUPPORTED, VERBOSE,
  VER_NUM, VIEW, VISUAL, WINDOWID,

  /* local options
   */

  AT, BACKGROUND, BRIGHT, CENTER, CLIP, COLORS, DITHER, FOREGROUND,
  GAMMA, GOTO, GRAY, HALFTONE, IDELAY, INVERT, MERGE, NAME, NEWOPTIONS,
  NORMALIZE, ROTATE, SMOOTH, XZOOM, YZOOM, ZOOM
} OptionId;

typedef struct option_array {
  char     *name;        /* name of the option minus preceeding '-' */
  OptionId  option_id;   /* OptionId of this option */
  char     *args;        /* arguments this option uses or NULL if none */
  char     *description; /* description of this option */
} OptionArray;

OptionId optionNumber(); /* options.c */
