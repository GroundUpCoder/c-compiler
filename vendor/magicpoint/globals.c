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
 * $Id: globals.c,v 1.52 2007/11/24 17:47:28 nishida Exp $
 */

#include "mgp.h"

/*
 * Global variables common to "mgp" and "mgp2ps".
 * (hate to define these in two places, mgp.c and print.c, I've made
 * a separate file)
 */
u_char *page_data[MAXPAGE][MAXLINE];
struct ctrl *page_control[MAXPAGE][MAXLINE];
struct ctrl *default_control[MAXLINE];
struct ctrl *tab_control[MAXTAB+MAXSTYLE];
struct ctrl *init_control[MAXLINE];
struct ctrl *fontdef_control[MAXFONTDEF];
struct page_attribute page_attribute[MAXPAGE];

u_int mgp_flag;
int verbose;
u_int maxpage;
u_int cur_page = 0;
char *mgp_fname;
char *mgp_wname;    /* window title */

u_int parse_error = 0;
u_int parse_debug = 0;

Display *display;
Visual *visual;
Window window;
int screen;
int window_width;
int window_height;
int caching = 0;
int cached_page = 0;
int cache_hit = 0;
int cache_mode = 0;
int cache_effect = 0;
int cache_value = 60;
Pixmap pixmap;
Pixmap cachewin;
Pixmap cachetmp;
struct bgpixmap bgpixmap[MAXBGPIXMAP];
Colormap colormap;
int free_clr_num;
u_long *free_clr = NULL;

u_int char_size[2];
u_int nonscaled_size[2];
float sup_scale;
float sup_off;
float sub_off;
u_int horiz_gap[2] = {DEFAULT_HGAP, DEFAULT_HGAP};
u_int vert_gap[2] = {DEFAULT_VGAP, DEFAULT_VGAP};
u_int depth;
u_long fore_color[2];
u_long back_color[2];
u_long ctrl_color[2];
u_int b_quality[2] = {DEFAULT_BQUALITY, DEFAULT_BQUALITY};
u_int quality_flag = 0;

char mgp_charset[256];

struct alloc_color image_clr = {0, NULL};
struct alloc_color back_clr = {0, NULL};
struct alloc_color font_clr = {0, NULL};

const struct ctl_words ctl_words[] = {
/*CTL*/	{ CTL_NOOP,		T_VOID,	"noop", 4 },
/*CTL*/	{ CTL_DEFAULT,		T_INT,	"default", 7 },
/*CTL*/	{ CTL_TAB,		T_SP,	"tab", 3 },
/*CTL*/	{ CTL_SIZE,		T_DOUBLE, "size", 4 },
/*CTL*/	{ CTL_FORE,		T_LONG,	"fore", 4 },
/*CTL*/	{ CTL_BACK,		T_LONG,	"back", 4 },
/*CTL*/	{ CTL_LEFT,		T_VOID,	"left", 4 },
/*CTL*/	{ CTL_LEFTFILL,		T_VOID,	"leftfill", 4 },
/*CTL*/	{ CTL_CENTER,		T_VOID,	"center", 6 },
/*CTL*/	{ CTL_RIGHT,		T_VOID,	"right", 5 },
/*CTL*/	{ CTL_SHRINK,		T_VOID,	"shrink", 6 },
/*CTL*/	{ CTL_LCUTIN,		T_VOID,	"lcutin", 6 },
/*CTL*/	{ CTL_RCUTIN,		T_VOID,	"rcutin", 6 },
/*CTL*/	{ CTL_CONT,		T_VOID,	"cont", 4 },
/*CTL*/	{ CTL_NODEF,		T_VOID,	"nodefault", 9 },
/*CTL*/	{ CTL_XFONT,		T_STR,	"xfont", 5 },
/*CTL*/	{ CTL_XFONT2,		T_STR2,	"xfont2", 6 },
/*CTL*/	{ CTL_VFONT,		T_STR,	"vfont", 5 },
/*CTL*/	{ CTL_TFONT,		T_STR,	"tfont", 5 },
/*CTL*/	{ CTL_IMAGE,		T_SP,	"image", 5 },
/*CTL*/	{ CTL_BIMAGE,		T_SP,	"bimage", 6 },
/*CTL*/	{ CTL_PAGE,		T_VOID,	"page", 4 },	
/*CTL*/	{ CTL_HGAP,		T_INT,	"hgap", 4 },
/*CTL*/	{ CTL_VGAP,		T_INT,	"vgap", 4 },
/*CTL*/	{ CTL_GAP,		T_INT,	"gap", 3 },
/*CTL*/	{ CTL_PAUSE,		T_SP,	"pause", 5 },
/*CTL*/ { CTL_PSFONT,           T_STR,  "psfont",6 },
/*CTL*/	{ CTL_PREFIX,		T_STR,	"prefix", 6 },
/*CTL*/	{ CTL_PREFIXN,		T_STR,	"*prefixn*", 9 },
/*CTL*/	{ CTL_TABPREFIX,	T_STR,	"*tabprefix*", 11 },
/*CTL*/	{ CTL_TABPREFIXN,	T_STR,	"*tabprefixn*", 12 },
/*CTL*/	{ CTL_PREFIXPOS,	T_VOID,	"*prefixpos*", 11 },
/*CTL*/	{ CTL_AGAIN,		T_VOID,	"again", 5 },
/*CTL*/	{ CTL_CCOLOR,		T_LONG,	"ccolor", 6 },
/*CTL*/	{ CTL_BAR,		T_SP,	"bar", 3 },
/*CTL*/	{ CTL_INCLUDE,		T_STR,	"include", 7 },
/*CTL*/	{ CTL_BGRAD,		T_SP,	"bgrad", 5 },
/*CTL*/	{ CTL_TEXT,		T_STR,	"*text*", 6 },
/*CTL*/	{ CTL_LINESTART,	T_VOID,	"*linestart*", 11 },
/*CTL*/	{ CTL_LINEEND,		T_VOID,	"*lineend*", 9 },
/*CTL*/	{ CTL_MARK,		T_VOID,	"mark", 4 },
/*CTL*/	{ CTL_SYSTEM,		T_SP,	"system", 6 },
/*CTL*/	{ CTL_FILTER,		T_SP,	"filter", 6 },
/*CTL*/	{ CTL_ENDFILTER,	T_VOID,	"endfilter", 9 },
/*CTL*/	{ CTL_QUALITY,		T_INT,	"bquality", 8 },
/*CTL*/	{ CTL_ICON,		T_SP,	"icon", 4 },
/*CTL*/	{ CTL_XSYSTEM,		T_SP,	"xsystem", 7 },
/*CTL*/	{ CTL_TSYSTEM,		T_SP,	"tsystem", 7 },
/*CTL*/	{ CTL_TFDIR,		T_STR,	"tfdir", 5 },
/*CTL*/	{ CTL_DEFFONT,		T_STR,	"deffont", 7 },
/*CTL*/	{ CTL_FONT,		T_STR,	"font", 4 },
/*CTL*/	{ CTL_VFCAP,		T_STR,	"vfcap", 5 },
/*CTL*/	{ CTL_TFONT0,		T_STR,	"tfont0", 6 },
/*CTL*/	{ CTL_EMBED,		T_STR,	"embed", 5 },
/*CTL*/	{ CTL_ENDEMBED,		T_VOID,	"endembed", 8 },
/*CTL*/	{ CTL_CHARSET,		T_STR,	"charset", 7 },
/*CTL*/	{ CTL_TMFONT,		T_STR,	"tmfont", 6 },
/*CTL*/	{ CTL_TMFONT0,		T_STR,	"tmfont0", 7 },
/*CTL*/	{ CTL_PCACHE,		T_SP,	"pcache", 6 },
/*CTL*/	{ CTL_ANIM,		T_STR,	"anim", 4 },
/*CTL*/	{ CTL_VALIGN,		T_SP,	"valign", 6 },
/*CTL*/	{ CTL_AREA,		T_SP,	"area", 4 },
/*CTL*/	{ CTL_OPAQUE,		T_INT,	"opaque", 6 },
/*CTL*/	{ CTL_SUP,		T_VOID,	"sup", 3 },
/*CTL*/	{ CTL_SUB,		T_VOID,	"sub", 3 },
/*CTL*/	{ CTL_SETSUP,		T_INT,	"setsup", 6 },
/*CTL*/	{ CTL_M17N,		T_STR2,	"m17n", 4 },
	{ 0, 0, NULL, 0 },
};
