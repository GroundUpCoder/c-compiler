/*
 * Copyright (C) 1997 and 1998 WIDE Project.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the project nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE PROJECT AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE PROJECT OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */
/*
 * $Id: mgp.h,v 1.146 2008/01/18 17:43:20 nishida Exp $
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#if TIME_WITH_SYS_TIME
# include <sys/time.h>
# include <time.h>
#else
# if HAVE_SYS_TIME_H
#  include <sys/time.h>
# else
#  include <time.h>
# endif
#endif
#ifdef HAVE_UNISTD_H
# include <unistd.h>
#endif
#include <string.h>
#include <strings.h>   /* gucOS port: strcasecmp lives here */
#include <getopt.h>    /* gucOS port: getopt decl */
#include <sys/param.h>
#include <ctype.h>
#include <assert.h>
#include <sys/types.h>
#if HAVE_SYS_WAIT_H
# include <sys/wait.h>
#endif
#include <sys/stat.h>
#include <signal.h>
#include <errno.h>
#include <fcntl.h>
#include "sdlx.h"   /* gucOS port: the SDL backend's X vocabulary */
#ifdef USE_XFT2
#include <ft2build.h>
#include FT_FREETYPE_H
#include <fontconfig/fontconfig.h>
#include <X11/Xft/Xft.h>
#ifdef HAVE_ICONV
#include <iconv.h>
#endif
#endif
#include "image/xloadimage.h"

#ifndef __P
# define __P(x)	x
#endif

#if 0
#define USE_XDRAWSTRING_ONLY_SMALL
#endif

#ifdef VFLIB
#include "VF.h"
#define VFONT	"minsl"

#ifndef VFCAP
#define VFCAP	"/usr/local/lib/VFlib/vfontcap"
#endif

#endif /* end of VFLIB */

#ifdef FREETYPE
/* gucOS port: FreeType 2 headers are included by tfont.c only */

#ifndef FREETYPEFONTDIR
#define FREETYPEFONTDIR	"/usr/local/share/fonts/ttf"
#endif
#endif /*FREETYPE*/

#ifdef HAVE_TERMIOS_H
#define	TTY_KEYINPUT
#else
#undef	TTY_KEYINPUT
#endif

#ifdef USE_M17N
#include <m17n-gui.h>
#include <m17n-misc.h>
#endif

#define DEFAULT_FORE	"yellow"
#define DEFAULT_BACK	"black"
#define PAGELIST_FONT	"a14"
#define PAGELIST_KFONT	"k14"

#define DEFAULT_CHARSIZE	10	/* 10% of height */
#define DEFAULT_SUPSCALE	0.6
#define DEFAULT_SUPOFF		0.4
#define DEFAULT_SUBOFF		0.15
#define DEFAULT_HGAP		0
#define DEFAULT_VGAP		15
#define DEFAULT_BQUALITY	100
#define DEFAULT_OPAQUE		100	

#define XLFD_HYPHEN	14
#define FONT_FORMAT	"-*-%s-*-*-%s-*-*-*-*-*-%s"
#define DEFAULT_X_FONT	"times-medium-r"
#define CUTIN_DELAY	5000
#define SHRINK_DELAY	00500
#define EXEC_DELAY  20000

#define	DEFAULT_GSDEV	"pnmraw+"

#define RCFILE		".mgprc"

#define	EMBEDDIR	"EMBEDDIR/"
#ifndef UUDECODE
#define	UUDECODE	"/usr/bin/uudecode"
#endif
#ifndef GUNZIP
#define	GUNZIP		"/usr/contrib/bin/gunzip"
#endif

#define MAXPAGE		512
#define MAXLINE		256
#define MAXVALLEN	512
#define MAXDIREC	16
#define MAXARG		32
#define MAXTAB		32
#define MAXSTYLE	100
#define MAXFONTDEF	100

#define MAXBGPIXMAP	2

#define SP_NONE		0
#define SP_SHRINK	1
#define SP_LCUTIN	2
#define SP_RCUTIN	3

#define AL_LEFT		0
#define AL_CENTER	1
#define AL_RIGHT	2
#define AL_LEFTFILL0	3
#define AL_LEFTFILL1	4

#define DEFAULT_GRADSTART	"blue"
#define DEFAULT_GRADEND		"black"
#define DEFAULT_GRADDEPTH	8
#define DEFAULT_GRADCOLORS	128
#define	DEFAULT_MGPWDIR		"/tmp"

/* 	mgp command line flags 	*/
#define FL_OVER		0x0001
#define FL_BIMAGE	0x0002
#define FL_DEMO		0x0004
#define FL_VERBOSE	0x0008
#define FL_OUTLINE	0x0010
#define FL_NOBEEP	0x0020
#define FL_NOFORK	0x0080
#define FL_PRIVATE	0x0100
#define FL_NODECORATION	0x0200
#define FL_NOAUTORELOAD	0x0400
#define FL_NOVFLIB	0x0800
#define FL_NOFREETYPE	0x1000
#define	FL_NOSTDIN	0x2000
#define	FL_GLYPHEDGE	0x4000
#define	FL_FRDCACHE		0x8000
#define	FL_NOXFT		0x10000
#define	FL_NOM17N		0x20000

/* 	page attribute flags 	*/
#define PGFLAG_NODEF	0x01	/* nodefault */

#define EVENT_DEFAULT \
	(KeyPressMask|KeyReleaseMask|ButtonPressMask|StructureNotifyMask|\
		ExposureMask)
#define EVENT_RAKUGAKI \
	(EVENT_DEFAULT|ButtonReleaseMask|Button1MotionMask)

#include "ctlwords.h"

struct ctrl_double {
	double ct_value;
};

struct ctrl_int {
	u_int ct_value;
};

struct ctrl_int2 {
       u_int ct_value1;
        u_int ct_value2;
};

struct ctrl_int3 {
       u_int ct_value1;
        u_int ct_value2;
        u_int ct_value3;
	};

struct ctrl_long {
	u_long ct_value;
};

struct ctrl_char {
	char *ct_value;
};

struct ctrl_char2 {
	char *ct_value1;
	char *ct_value2;
};

struct ctrl_args {
	u_int ct_argc;
	char **ct_argv;
	int ct_flag;
};

struct ctrl_image {
	char *ct_fname;
	u_int ct_numcolor;
	u_int ct_ximagesize;
	u_int ct_yimagesize;
	u_int ct_zoomflag;
	u_int ct_raise;
	u_int ct_rotate; /* +/-180, +/-90, 0, 270 */
	u_int ct_zoomonclk; 
#define Z_XMASK		0x0f
#define Z_YMASK		0xf0
#define Z_YSHIFT	4
#define Z_ABSOLUTE	0x00	/* absolute value */
#define Z_NORMAL	0x01	/* normal zoom ratio */
#define Z_SCREEN	0x02	/* screen relative zoom ratio */
#define Z_SCREEN0	0x03	/* original screen size specified */
#define Z_OBEY		0x04	/* obey other axis */
};

/* for gradation image generation*/
struct g_color {
	int r, g, b;
	int y;
};

struct ctrl_grad {
	u_int ct_numcolor;
	int ct_direction;
	u_int ct_width;		/* resulting image width, percentage */
	u_int ct_height;	/* resulting image height, percentage */
#if 0
	u_int ct_hquality;	/* horizontal quality factor */
	u_int ct_vquality;	/* vertical quality factor */
#endif
	u_int ct_zoomflag;	/* zoom to full screen? */
	int ct_mode;		/* linear(0) / non-linear(1) */
	int ct_g_colors;
	struct g_color **colors;
};

struct ctrl_bar {
	u_long ct_color;
	u_int ct_width;
	u_int ct_start;
	u_int ct_length;
};

struct ctrl_icon {
	char *ct_value; 
	u_long ct_color; 
	u_int ct_size;   
};  

struct ctrl_area {
	u_int ct_xoff;
	u_int ct_width;
	u_int ct_yoff;
	u_int ct_height;
};

struct ctrl_pcache {
	u_int ct_cflag;
	u_int ct_cmode;
	u_int ct_ceffect;
	u_int ct_cvalue;
};

struct ctrl {
	u_char ct_op;
	u_char ct_flag;
	u_int ct_page;
	struct ctrl *ct_next;
	union {
		struct ctrl_double ctrl_double;
		struct ctrl_int ctrl_int;
                struct ctrl_int2 ctrl_int2;
                struct ctrl_int3 ctrl_int3;        
		struct ctrl_long ctrl_long;
		struct ctrl_char ctrl_char;
		struct ctrl_char2 ctrl_char2;
		struct ctrl_image ctrl_image;
		struct ctrl_grad ctrl_grad;
		struct ctrl_bar ctrl_bar;
		struct ctrl_args ctrl_args;
		struct ctrl_icon ctrl_icon;
		struct ctrl_area ctrl_area;
		struct ctrl_pcache ctrl_pcache;
	} ct_val;
};

#define ctf_value	ct_val.ctrl_double.ct_value
#define cti_value	ct_val.ctrl_int.ct_value
#define cti2_value1	ct_val.ctrl_int2.ct_value1
#define cti2_value2	ct_val.ctrl_int2.ct_value2
#define cti3_value1	ct_val.ctrl_int3.ct_value1
#define cti3_value2	ct_val.ctrl_int3.ct_value2
#define cti3_value3	ct_val.ctrl_int3.ct_value3
#define ctl_value	ct_val.ctrl_long.ct_value
#define ctc_value	ct_val.ctrl_char.ct_value
#define ctc2_value1	ct_val.ctrl_char2.ct_value1
#define ctc2_value2	ct_val.ctrl_char2.ct_value2
#define ctm_fname	ct_val.ctrl_image.ct_fname
#define ctm_numcolor	ct_val.ctrl_image.ct_numcolor
#define ctm_ximagesize	ct_val.ctrl_image.ct_ximagesize
#define ctm_yimagesize	ct_val.ctrl_image.ct_yimagesize
#define ctm_zoomflag	ct_val.ctrl_image.ct_zoomflag
#define ctm_raise	ct_val.ctrl_image.ct_raise
#define ctm_rotate	ct_val.ctrl_image.ct_rotate
#define ctm_zoomonclk	ct_val.ctrl_image.ct_zoomonclk
#define ctd_colors	ct_val.ctrl_grad.colors
#define ctd_g_colors	ct_val.ctrl_grad.ct_g_colors
#define ctd_numcolor	ct_val.ctrl_grad.ct_numcolor
#define ctd_dir		ct_val.ctrl_grad.ct_direction
#define ctd_basewidth	ct_val.ctrl_grad.ct_width
#define ctd_baseheight	ct_val.ctrl_grad.ct_baseheight
#define ctd_width	ct_val.ctrl_grad.ct_width
#define ctd_height	ct_val.ctrl_grad.ct_height
#define ctd_hquality	ct_val.ctrl_grad.ct_hquality
#define ctd_vquality	ct_val.ctrl_grad.ct_vquality
#define ctd_zoomflag	ct_val.ctrl_grad.ct_zoomflag
#define ctd_mode	ct_val.ctrl_grad.ct_mode
#define ctb_color	ct_val.ctrl_bar.ct_color
#define ctb_width	ct_val.ctrl_bar.ct_width
#define ctb_start	ct_val.ctrl_bar.ct_start
#define ctb_length	ct_val.ctrl_bar.ct_length
#define cta_argc	ct_val.ctrl_args.ct_argc
#define cta_argv	ct_val.ctrl_args.ct_argv
#define cta_flag	ct_val.ctrl_args.ct_flag
#define ctic_value	ct_val.ctrl_icon.ct_value
#define ctic_color	ct_val.ctrl_icon.ct_color
#define ctic_size	ct_val.ctrl_icon.ct_size
#define	ctar_xoff	ct_val.ctrl_area.ct_xoff
#define	ctar_width	ct_val.ctrl_area.ct_width
#define	ctar_yoff	ct_val.ctrl_area.ct_yoff
#define	ctar_height	ct_val.ctrl_area.ct_height
#define ctch_flag	ct_val.ctrl_pcache.ct_cflag
#define ctch_mode	ct_val.ctrl_pcache.ct_cmode
#define ctch_effect	ct_val.ctrl_pcache.ct_ceffect
#define ctch_value	ct_val.ctrl_pcache.ct_cvalue

struct ctl_words {
        u_char ctl_type;
	char ctl_vtype;
#define T_STR	'c'
#define T_STR2	'C'
#define T_INT	'i'
#define T_LONG	'l'
#define T_DOUBLE 'f'
#define T_SP	'x'
#define T_VOID	'-'
        char *ctl_string;
        int ctl_strlen;
};

extern const struct ctl_words ctl_words[];

struct page_attribute {
	u_int pg_flag;
	u_int pg_linenum;
	u_int pg_b_numcolor;	/* background gradation number of colors */
	u_int pg_b_dir;		/* background gradation deg */
	u_int pg_text;		/* this page is text only */
};
extern struct page_attribute page_attribute[MAXPAGE];

extern int	caching;
extern int	cached_page;
extern int	cache_hit;
extern int	cache_mode;
extern int	cache_effect;
extern int	cache_value;

struct render_state {
	/* state of the parser */
	u_int page;
	u_int line;
	struct ctrl *cp;
	enum { P_NONE, P_DEFAULT, P_PAGE, P_END } phase;
		/*
		 * NONE	   - nothing
		 * DEFAULT - doing default_control
		 * PAGE    - doing page_control
		 */
	char *curprefix;
	char *tabprefix;
	u_int align;
	u_int special;
	u_int leftfillpos;

	/*
	 * state of the renderer
	 * we don't have xpos here since that will be
	 * dynaimcally determined at CTL_LINEEND.
	 */
	Drawable target;
	u_int height;
	u_int width;
	int xprefix;
	int tabxprefix;
	int xoff;
	int yoff;
	u_int ypos;
	int have_mark;
	u_int mark_ypos;
	u_int repaint;
	int maxascent;
	int maxdescent;
	int maxflheight;
	int max_lineascent;   /* max size above baseline ignoring supscript */
	int max_linedescent;  /* max size below baseline ignoring subscript */
	u_int linewidth;
	u_int brankline;
	u_int opaque;
	u_int charoff;
	struct ctrl *xfont;
	struct render_object *obj, *objlast;
};

struct render_object {
	struct render_object *next;
	int x;	/* relative from left position of line */
	int y;	/* relative from center position of line (usually negative) */
	int ascent;	/* size above the baseline */
	int descent;	/* size below the baseline */
	int vertloc;	/* vertical placement control */
#define VL_BASE		0
#define VL_CENTER	1
#define VL_TOP		2
#define VL_BOTTOM	3
#define VL_ICENTER	4
	enum {
#ifdef VFLIB
		O_VFONT,
#endif /* VFLIB */
#ifdef FREETYPE
		O_TFONT,
#endif /* FREETYPE */
		O_XFONT,
		O_IMAGE,
#ifdef MNG
		O_ANIM,
#endif /* MNG */
#ifdef USE_XFT2
		O_XTFONT,
#endif 
#ifdef USE_M17N
		O_M17NTEXT,
#endif 
		O_ICON
	} type;
	u_long fore;
	union {
#ifdef VFLIB
		struct vfont *vfc;
#endif /* VFLIB */
#ifdef FREETYPE
		struct tfont *tfc;
#endif /* FREETYPE */
		struct {
			char *xfont;
			u_int csize;
			u_int code;
			char *registry;
		} xfont;
		struct {
			Image *image;
			float xzoom, yzoom;
#ifdef USE_IMLIB
			int zoomonclk;
			ImlibImage *imimage;
#endif
		} image;
		struct {
			u_int itype;
			u_int isize;
			u_int npoint;
			XPoint *xpoint;
		} icon;
#ifdef MNG
		struct {
			u_int width;
			u_int height;
			char *filename;
			void *key;
		} anim;
#endif /* MNG */
#ifdef USE_XFT2
		struct {
			char *data;
			char *fontname;
			char *registry;
			int len;
			int size;
			int charset16;
		} xftfont;
#endif
#ifdef USE_M17N
		struct {
			MText *mt;
			MFrame *drawframe;
			int from, to;
		} m17ntext;
#endif
	} data;
};

#ifdef VFLIB
struct vfont {
	struct vfont *next;
	struct vfont *prev;
	struct vfont *lrunext;
	struct vfont *lruprev;
	u_int size;
	u_int width;
	u_int bwidth;
	u_int height;
	u_int code;
	u_int charlen;
	u_int xmax;
	int ascent;
	int descent;
	u_int xoff;
	char *fontname;
	u_char *dbitmap;
	u_int ref;
};
#endif /* VFLIB */

#ifdef FREETYPE
struct tfont {
	struct tfont *next;
	struct tfont *prev;
	struct tfont *lrunext;
	struct tfont *lruprev;
	u_int size;		/* char_size (as specified by %size) */
	u_int width;		/* bitmap width */
	u_int bwidth;		/* bitmap width, byte boundary */
	u_int height;		/* bitmap height */
	u_int code;
	u_int charlen;		/* origin x axis advance width */
	u_int xmax;			/* right edge of bbox */
	int ascent;		/* (top of bitmap) - (origin y axis) */
	int descent;		/* (origin y axis) - (bottom of bitmap) */
	int xoff;		/* (left of bitmap) - (origin x axis) */
	char *fontname;
	u_char *dbitmap;
	u_int ref;
	int regid;		/* registry ID */
};
#endif /* FREETYPE */

struct alloc_color {
	int	num;
	long	*colors;
};

struct bgpixmap {
	struct ctrl *ctl;
	Pixmap	pixmap;
	Image *image;
	XImageInfo *ximageinfo;
};

/*
 * The following variables are defined in global.c, and therefore
 * they are available in both "mgp" and "mgp2ps" binary.
 */
#if 0
extern char *page_data[MAXPAGE][MAXLINE];
#endif
extern struct ctrl *page_control[MAXPAGE][MAXLINE];
extern struct ctrl *default_control[MAXLINE];
extern struct ctrl *tab_control[MAXTAB+MAXSTYLE];
extern struct ctrl *init_control[MAXLINE];
extern struct ctrl *fontdef_control[MAXFONTDEF];

extern u_int mgp_flag;
extern int verbose;
extern u_int maxpage;
extern u_int cur_page;
extern char *mgp_fname;
extern char *mgp_wname;

extern u_int parse_error;
extern u_int parse_debug;

extern Display *display;
extern Window window;
extern int screen;
extern int window_width;
extern int window_height;
extern Pixmap pixmap;
extern Pixmap cachewin;
extern Pixmap cachetmp;
extern struct bgpixmap bgpixmap[MAXBGPIXMAP];
extern Colormap colormap;
extern struct alloc_color image_clr;
extern struct alloc_color back_clr;
extern struct alloc_color font_clr;

extern u_int char_size[2];
extern u_int nonscaled_size[2];
extern float sup_scale;
extern float sup_off;
extern float sub_off;
extern u_int horiz_gap[2];
extern u_int vert_gap[2];
extern u_int depth;
extern Visual *visual;
extern u_long fore_color[2];
extern u_long back_color[2];
extern u_long ctrl_color[2];
extern u_int b_quality[2];
extern u_int quality_flag;

extern char mgp_charset[256];

#define VERT_GAP(s)		((s) * vert_gap[caching] / 100)
#define HORIZ_GAP(s)		((s) * horiz_gap[caching] / 100)
#define VERT_STEP(s)		((s) + VERT_GAP(s))
#define HORIZ_STEP(s, x)	((x) + HORIZ_GAP(s))

/*
 * The following variable are defined in x11.c.  Therefore, these are
 * accessible only in "mgp" binary, not in "mgp2ps".
 * We should separate header files.
 * (or, if mgp.c and print.c get merged the problem will vanish)
 */
/* covered by gcconf */
extern GC gcfore;
extern GC gcpen;
extern GC gcred;
extern GC gcgreen;
extern GC gcyellow;

/* not covered by gcconf */
extern GC gc_pl;
extern GC gc_plrev;
extern GC gc_pta;
extern GC gc_ptk;

extern GC gc_cache;

extern long xeventmask;

/*
 * The following variable are defined in mgp.c.  Therefore, these are
 * accessible only in "mgp" binary, not in "mgp2ps".
 * We should separate header files.
 * (or, if mgp.c and print.c get merged the problem will vanish)
 */
extern Window plwin[MAXPAGE];
extern Pixmap maskpix;
extern XFontStruct *plfs;
extern XFontStruct *plkfs;
extern XFontStruct *plsfs;
extern u_int pg_mode;
extern time_t t_start;
extern u_int t_fin;
extern u_int tbar_mode;
extern u_long pl_fh, pl_fw;
extern u_long depth_mask;
#ifdef VFLIB
extern char *vfcap_name;
#endif
#ifdef FREETYPE
extern char *freetypefontdir;
extern char *freetypefont0;	/* font name to be used as a last resort */
extern char *freetypemfont0;	/* font name to be used as a last resort */
extern int unicode_map[65536];
#endif
extern int latin_unicode_map[3][256];
#ifdef TTY_KEYINPUT
extern volatile int ttykey_enable;
#endif
extern char *back_clname;
extern char *gsdevice;
extern char *htmlimage;

extern char *mgpwdir;
extern char mgpwdirname[];

/* mgp.c */
extern pid_t checkchild __P((void *));
extern Window checkchildwin __P((void *));
extern void regchild __P((pid_t, void *, Window, int));
extern void purgechild __P((int));
extern void remapchild __P((void));
extern void cleanup __P((int));
#ifdef TTY_KEYINPUT
extern void try_enable_ttykey __P((void));
#endif
extern void reset_background_pixmap();

/*draw.c*/
extern void state_goto __P((struct render_state *, u_int, int));
extern void state_init __P((struct render_state *));
extern void state_newpage __P((struct render_state *));
extern void state_next __P((struct render_state *));
extern void draw_page __P((struct render_state *, struct ctrl *));
extern Bool draw_one __P((struct render_state *, XEvent *));
extern void timebar __P((struct render_state *));
extern void draw_reinit __P((struct render_state *));
extern int get_regid __P((char *));
extern void draw_line_itemsize __P((struct render_state *, int, int, int));
extern void draw_line_start __P((struct render_state *));
extern void draw_line_end __P ((struct render_state *));

#ifdef USE_M17N
extern int obj_new_mtext __P((struct render_state *, int, int,
			      MText *, int, int, MFrame *, int, int));
#endif

/*parse.c*/
extern void load_file __P((char *));
extern void cleanup_file __P(());
extern int ctlcmp __P((struct ctrl *, struct ctrl *));
extern FILE *fsearchopen __P((char *, char *, char **));
extern int chkfile __P((char *));
extern struct ctrl *ctllastitem __P((struct ctrl *));
extern void ctlappend __P((struct ctrl *, struct ctrl *));
extern void ctlinsert __P((struct ctrl **, struct ctrl *));
extern struct ctrl *ctlalloc1 __P((u_int));
extern void ctlfree __P((struct ctrl *));
extern struct ctrl *ctlcopy __P((struct ctrl *));
extern struct ctrl *ctlcopy1 __P((struct ctrl *));
extern void debug0 __P((struct ctrl *));
extern void debug1 __P((struct ctrl *));

/*plist.c*/
extern void pl_on __P((struct render_state *));
extern void pl_off __P((struct render_state *));
extern void pl_pdraw __P((struct render_state *, int, GC));
extern void pl_title __P((u_int));
extern char *page_title __P((int));
extern void pg_on __P((void));
extern void pg_clean __P((void));
extern void pg_draw __P((struct render_state *));
extern void pg_off __P((void));

/*font.c*/
extern struct vfont *vfc_get __P((u_int, u_int, u_int, int));
extern void vfc_setfont __P((char *));
extern XImage *vfc_image __P((struct vfont *, long, long, XImage *, u_int, u_int));

/*x11.c or x11dummy.c*/
extern int window_x;
extern int window_y;
extern void init_win1 __P((char *));
extern void init_win2 __P((void));
extern void init_win3 __P((void));
extern void finish_win __P((void));
extern int get_color __P((char *, u_long *));
extern struct g_color *name2gcolor __P((char *));
extern void regist_alloc_colors __P((struct alloc_color *, u_long *, int));
extern void free_alloc_colors __P((struct alloc_color *));
extern void toggle_fullscreen();

/* background.c */
extern double cdist __P((int, int, int, int, int, int));
extern double lcdist __P((int, int, int, int, int, int, double, double));
extern byte *draw_gradation __P((int, int, struct ctrl_grad *));
extern Image *make_XImage __P((byte *, unsigned int, unsigned int));

/* postscript.c */
extern int ps_boundingbox __P((char *, int *, int *, int *, int *));
extern void image_zoomratio __P((struct render_state *, float *, float *, int, int, int));

/* tfont.c */
extern int tfc_setsize __P((u_int));
extern struct tfont *tfc_get __P((u_int, u_int, int, char *, int));
extern void tfc_setfont __P((char *, int, char *));
extern XImage *tfc_image __P((struct tfont *, long, long, XImage *, int, int));

/* unimap.c */
extern void latin_unicode_map_init();

/* embed.c */
extern char *embed_fname __P((char *));
extern void embed_file __P((FILE *, struct ctrl *, int *));
extern void cleandir __P((void));

/* missing/ *.c */
#ifndef HAVE_STRDUP
extern char *strdup __P((const char *));
#endif
#ifndef HAVE_STRSEP
extern char *strsep __P((char **, const char *));
#endif
#ifndef HAVE_USLEEP
extern void usleep __P((u_int));
#endif

#ifdef FREETYPE
#define RASTERLIB
#endif
#ifdef VFLIB
#define RASTERLIB
#endif

#if 1
#define DITHERED_BGRAD
#define COLOR_BUGFIX
#endif

#ifdef USE_M17N
/*m17n.c*/
extern void M17N_init __P((void));
extern void M17N_fini __P((void));
extern void M17N_set_font __P((char *, char *));
extern void M17N_set_color __P((u_long));
extern void M17N_process_direc __P((char *, char *));
extern void M17N_draw_string __P((struct render_state *, struct ctrl *cp));
extern void M17N_draw_object __P((struct render_object *, Drawable, int, int));
#endif
