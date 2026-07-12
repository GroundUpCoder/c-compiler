/* A Bison parser, made by GNU Bison 2.3.  */

/* Skeleton implementation for Bison's Yacc-like parsers in C

   Copyright (C) 1984, 1989, 1990, 2000, 2001, 2002, 2003, 2004, 2005, 2006
   Free Software Foundation, Inc.

   This program is free software; you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation; either version 2, or (at your option)
   any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program; if not, write to the Free Software
   Foundation, Inc., 51 Franklin Street, Fifth Floor,
   Boston, MA 02110-1301, USA.  */

/* As a special exception, you may create a larger work that contains
   part or all of the Bison parser skeleton and distribute that work
   under terms of your choice, so long as that work isn't itself a
   parser generator using the skeleton or a modified version thereof
   as a parser skeleton.  Alternatively, if you modify or redistribute
   the parser skeleton itself, you may (at your option) remove this
   special exception, which will cause the skeleton and the resulting
   Bison output files to be licensed under the GNU General Public
   License without this special exception.

   This special exception was added by the Free Software Foundation in
   version 2.2 of Bison.  */

/* C LALR(1) parser skeleton written by Richard Stallman, by
   simplifying the original so-called "semantic" parser.  */

/* All symbols defined below should begin with yy or YY, to avoid
   infringing on user name space.  This should be done even for local
   variables, as they might otherwise be expanded by user macros.
   There are some unavoidable exceptions within include files to
   define necessary library symbols; they are noted "INFRINGES ON
   USER NAME SPACE" below.  */

/* Identify Bison output.  */
#define YYBISON 1

/* Bison version.  */
#define YYBISON_VERSION "2.3"

/* Skeleton name.  */
#define YYSKELETON_NAME "yacc.c"

/* Pure parsers.  */
#define YYPURE 0

/* Using locations.  */
#define YYLSP_NEEDED 0



/* Tokens.  */
#ifndef YYTOKENTYPE
# define YYTOKENTYPE
   /* Put the tokens into the symbol table, so that GDB and other debuggers
      know about them.  */
   enum yytokentype {
     COMMA = 258,
     NUM = 259,
     DOUBLE = 260,
     ID = 261,
     STR = 262,
     WINSIZ = 263,
     KW_NOOP = 264,
     KW_DEFAULT = 265,
     KW_TAB = 266,
     KW_SIZE = 267,
     KW_FORE = 268,
     KW_BACK = 269,
     KW_LEFT = 270,
     KW_CENTER = 271,
     KW_RIGHT = 272,
     KW_SHRINK = 273,
     KW_LCUTIN = 274,
     KW_RCUTIN = 275,
     KW_CONT = 276,
     KW_NODEF = 277,
     KW_XFONT = 278,
     KW_VFONT = 279,
     KW_IMAGE = 280,
     KW_BIMAGE = 281,
     KW_PAGE = 282,
     KW_HGAP = 283,
     KW_VGAP = 284,
     KW_GAP = 285,
     KW_PAUSE = 286,
     KW_PREFIX = 287,
     KW_AGAIN = 288,
     KW_CCOLOR = 289,
     KW_BAR = 290,
     KW_INCLUDE = 291,
     KW_BGRAD = 292,
     KW_TEXT = 293,
     KW_LINESTART = 294,
     KW_LINEEND = 295,
     KW_MARK = 296,
     KW_SYSTEM = 297,
     KW_FILTER = 298,
     KW_ENDFILTER = 299,
     KW_QUALITY = 300,
     KW_ICON = 301,
     KW_LEFTFILL = 302,
     KW_XSYSTEM = 303,
     KW_VFCAP = 304,
     KW_TFONT = 305,
     KW_TFDIR = 306,
     KW_TSYSTEM = 307,
     KW_DEFFONT = 308,
     KW_FONT = 309,
     KW_TFONT0 = 310,
     KW_EMBED = 311,
     KW_ENDEMBED = 312,
     KW_NEWIMAGE = 313,
     KW_PSFONT = 314,
     KW_CHARSET = 315,
     KW_TMFONT = 316,
     KW_PCACHE = 317,
     KW_TMFONT0 = 318,
     KW_ANIM = 319,
     KW_VALIGN = 320,
     KW_AREA = 321,
     KW_OPAQUE = 322,
     KW_SUP = 323,
     KW_SUB = 324,
     KW_SETSUP = 325,
     KW_M17N = 326
   };
#endif
/* Tokens.  */
#define COMMA 258
#define NUM 259
#define DOUBLE 260
#define ID 261
#define STR 262
#define WINSIZ 263
#define KW_NOOP 264
#define KW_DEFAULT 265
#define KW_TAB 266
#define KW_SIZE 267
#define KW_FORE 268
#define KW_BACK 269
#define KW_LEFT 270
#define KW_CENTER 271
#define KW_RIGHT 272
#define KW_SHRINK 273
#define KW_LCUTIN 274
#define KW_RCUTIN 275
#define KW_CONT 276
#define KW_NODEF 277
#define KW_XFONT 278
#define KW_VFONT 279
#define KW_IMAGE 280
#define KW_BIMAGE 281
#define KW_PAGE 282
#define KW_HGAP 283
#define KW_VGAP 284
#define KW_GAP 285
#define KW_PAUSE 286
#define KW_PREFIX 287
#define KW_AGAIN 288
#define KW_CCOLOR 289
#define KW_BAR 290
#define KW_INCLUDE 291
#define KW_BGRAD 292
#define KW_TEXT 293
#define KW_LINESTART 294
#define KW_LINEEND 295
#define KW_MARK 296
#define KW_SYSTEM 297
#define KW_FILTER 298
#define KW_ENDFILTER 299
#define KW_QUALITY 300
#define KW_ICON 301
#define KW_LEFTFILL 302
#define KW_XSYSTEM 303
#define KW_VFCAP 304
#define KW_TFONT 305
#define KW_TFDIR 306
#define KW_TSYSTEM 307
#define KW_DEFFONT 308
#define KW_FONT 309
#define KW_TFONT0 310
#define KW_EMBED 311
#define KW_ENDEMBED 312
#define KW_NEWIMAGE 313
#define KW_PSFONT 314
#define KW_CHARSET 315
#define KW_TMFONT 316
#define KW_PCACHE 317
#define KW_TMFONT0 318
#define KW_ANIM 319
#define KW_VALIGN 320
#define KW_AREA 321
#define KW_OPAQUE 322
#define KW_SUP 323
#define KW_SUB 324
#define KW_SETSUP 325
#define KW_M17N 326




/* Copy the first part of user declarations.  */


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
 * $Id: grammar.y,v 1.50 2008/01/18 17:43:20 nishida Exp $
 */
/*
 * partly derived from lbl libpcap source code, which has the following
 * copyright notice:
 */
/*
 * Copyright (c) 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996
 *	The Regents of the University of California.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that: (1) source code distributions
 * retain the above copyright notice and this paragraph in its entirety, (2)
 * distributions including binary code include the above copyright notice and
 * this paragraph in its entirety in the documentation or other materials
 * provided with the distribution, and (3) all advertising materials mentioning
 * features or use of this software display the following acknowledgement:
 * ``This product includes software developed by the University of California,
 * Lawrence Berkeley Laboratory and its contributors.'' Neither the name of
 * the University nor the names of its contributors may be used to endorse
 * or promote products derived from this software without specific prior
 * written permission.
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND WITHOUT ANY EXPRESS OR IMPLIED
 * WARRANTIES, INCLUDING, WITHOUT LIMITATION, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.
 *
 */

#include "mgp.h"
extern int yylex(void);   /* gucOS port: explicit decl (see README) */
#ifdef HAVE_STDARG_H
#include <stdarg.h>
#else
#include <varargs.h>
#endif

#if 0
#define QSET(q, p, d, a) (q).proto = (p),\
			 (q).dir = (d),\
			 (q).addr = (a)

static struct qual qerr = { Q_UNDEF, Q_UNDEF, Q_UNDEF, Q_UNDEF };
#endif

int n_errors = 0;
struct ctrl *root;
char *yyfilename;
int yylineno;

#ifdef HAVE_STDARG_H
/* GCC complains if we declare this function in traditional style */
void
yyerror(char *msg, ...)
#else
void
yyerror(msg)
	char *msg;
#endif
{
	va_list ap;
#ifdef HAVE_STDARG_H
	va_start(ap, msg);
#else
	va_start(ap);
#endif
	++n_errors;
	fprintf(stderr, "%s:%d: error: ", yyfilename, yylineno);
	vfprintf(stderr, msg, ap);
	fprintf(stderr, "\n");
	va_end(ap);
}

#ifdef HAVE_STDARG_H
/* GCC complains if we declare this function in traditional style */
static void
yywarn(char *msg, ...)
#else
static void
yywarn(msg)
	char *msg;
#endif
{
	va_list ap;
#ifdef HAVE_STDARG_H
	va_start(ap, msg);
#else
	va_start(ap);
#endif
	fprintf(stderr, "%s:%d: warning: ", yyfilename, yylineno);
	vfprintf(stderr, msg, ap);
	fprintf(stderr, "\n");
	va_end(ap);
}

static struct ctrl *
gen_void(op)
	int op;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate void node");
		return ct;
	}
	return ct;
}

static struct ctrl *
gen_double_int(op, v)
	int op;
	int v;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate double node");
		return ct;
	}
	ct->ctf_value = (double)v;
	return ct;
}

static struct ctrl *
gen_double(op, v)
	int op;
	double v;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate double node");
		return ct;
	}
	ct->ctf_value = v;
	return ct;
}

static struct ctrl *
gen_int(op, v)
	int op;
	int v;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate integer node");
		return ct;
	}
	ct->cti_value = v;
	return ct;
}

static struct ctrl *
gen_int2(op, v1, v2)
       int op;
       int v1;
       int v2;
{
       struct ctrl *ct;

       if (!(ct = ctlalloc1(op))) {
               yyerror("cannot allocate integer2 node");
               return ct;
       }
       ct->cti2_value1 = v1;
       ct->cti2_value2 = v2;
       return ct;
}

static struct ctrl *
gen_int3(op, v1, v2, v3)
       int op;
       int v1;
       int v2;
       int v3;
{
       struct ctrl *ct;

       if (!(ct = ctlalloc1(op))) {
               yyerror("cannot allocate integer3 node");
               return ct;
       }
       ct->cti3_value1 = v1;
       ct->cti3_value2 = v2;
       ct->cti3_value3 = v3;   
       return ct;
}

static struct ctrl *
gen_str(op, str)
	int op;
	char *str;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate str1 node");
		return ct;
	}
	ct->ctc_value = strdup(str);
	return ct;
}

static struct ctrl *
gen_str2(op, str1, str2)
	int op;
	char *str1;
	char *str2;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate str2 node");
		return ct;
	}
	ct->ctc2_value1 = strdup(str1);
	ct->ctc2_value2 = strdup(str2);
	return ct;
}

static struct ctrl *
gen_color(op, color)
	int op;
	char *color;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate color node");
		return ct;
	}
	if (get_color(color, &ct->ctl_value) < 0)
		yyerror("cannot allocate color \"%s\"", color);
	return ct;
}

static struct ctrl *
gen_bgrad(w, h, colors, dir, zoomflg, extra)
	int w;
	int h;
	int colors;
	int dir;
	int zoomflg;
	struct ctrl *extra;
{
	struct ctrl *ct;
	struct ctrl *p;
	int siz;

	if (!(ct = ctlalloc1(CTL_BGRAD))) {
		yyerror("cannot allocate node (op=BGRAD)");
		return ct;
	}
	ct->ctd_width = w;
	ct->ctd_height = h;
	ct->ctd_numcolor = colors;
	ct->ctd_dir = dir;
	ct->ctd_zoomflag = zoomflg;

	/* process color list. */
	siz = ct->ctd_g_colors = 0;
	for (p = extra; p; p = p->ct_next)
		siz++;
	if (siz <= 2) {
		ct->ct_val.ctrl_grad.colors =
			malloc(3 * sizeof(struct gcolor *));
	} else {
		ct->ct_val.ctrl_grad.colors =
			malloc((siz + 1) * sizeof(struct gcolor *));
	}
	if (!ct->ct_val.ctrl_grad.colors) {
		yyerror("cannot allocate color table");
		return ct;
	}

	ct->ctd_g_colors = 2;
	ct->ct_val.ctrl_grad.colors[0] = name2gcolor(DEFAULT_GRADSTART);
	ct->ct_val.ctrl_grad.colors[1] = name2gcolor(DEFAULT_GRADEND);
	switch (siz) {
	case 0:
		break;
	case 1:
		ct->ct_val.ctrl_grad.colors[0] = name2gcolor(extra->ctc_value);
		break;
	default:
		ct->ctd_g_colors = siz;
		siz = 0;
		for (p = extra; p; p = p->ct_next) {
			ct->ct_val.ctrl_grad.colors[siz] =
				name2gcolor(p->ctc_value);
			siz++;
		}
	}

	/* normalize */
	if (ct->ctd_dir < 0) {	/*circle*/
		ct->ctd_mode = 1;
		ct->ctd_dir = abs(ct->ctd_dir);
	} else			/*linear*/
		ct->ctd_mode = 0;
	while (ct->ctd_dir < 0)
		ct->ctd_dir += 360;
	ct->ctd_dir %= 360;
	if (ct->ctd_width <= 0)
		ct->ctd_width = 100;
	if (ct->ctd_height <= 0)
		ct->ctd_height = 100;

	if (extra)
		ctlfree(extra);

	return ct;
}

static struct ctrl *
gen_newimage(arg)
	struct ctrl *arg;
{
	struct ctrl *p;
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_IMAGE))) {
		yyerror("cannot allocate node (op=IMAGE)");
		return ct;
	}

	/* default setting */
	ct->ctm_ximagesize = 100;
	ct->ctm_yimagesize = 100;
	ct->ctm_zoomflag = Z_NORMAL | (Z_NORMAL << Z_YSHIFT);
	ct->ctm_raise = 0;
	ct->ctm_rotate = 0;
	ct->ctm_zoomonclk = 0;

	for (p = arg; p; p = p->ct_next) {
		if (p->ctc_value[0] != '-')
			break;

		if (strcmp(p->ctc_value, "-colors") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_numcolor = atoi(p->ctc_value);
		} else if (strcmp(p->ctc_value, "-xysize") == 0
			&& p->ct_next && p->ct_next->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			p = p->ct_next;
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_ABSOLUTE | (Z_ABSOLUTE << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-zoom") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_NORMAL | (Z_NORMAL << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-xyzoom") == 0
			&& p->ct_next && p->ct_next->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			p = p->ct_next;
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_NORMAL | (Z_NORMAL << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-scrzoom") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_SCREEN | (Z_SCREEN << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-xscrzoom") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			ct->ctm_yimagesize = 100;
			ct->ctm_zoomflag = Z_SCREEN | (Z_OBEY << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-yscrzoom") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = 100;
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_OBEY | (Z_SCREEN << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-xyscrzoom") == 0
			&& p->ct_next && p->ct_next->ct_next) {
			p = p->ct_next;
			ct->ctm_ximagesize = atoi(p->ctc_value);
			p = p->ct_next;
			ct->ctm_yimagesize = atoi(p->ctc_value);
			ct->ctm_zoomflag = Z_SCREEN | (Z_SCREEN << Z_YSHIFT);
		} else if (strcmp(p->ctc_value, "-raise") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_raise = atoi(p->ctc_value);
		} else if (strcmp(p->ctc_value, "-rotate") == 0 && p->ct_next) {
			p = p->ct_next;
			ct->ctm_rotate = atoi(p->ctc_value);
		} else if (strcmp(p->ctc_value, "-zoomonclk") == 0 && p->ct_next) {
			p = p->ct_next;
#ifdef USE_IMLIB
			ct->ctm_zoomonclk = atoi(p->ctc_value);
#else
			fprintf(stderr, "warning: cannot use -zoomonclk option in this configuration\n");
#endif
		} else {
			yyerror("invalid argument %s specified for newimage",
				p->ctc_value);
			return ct;
		}
	}

	if (!p) {
		yyerror("no filename specified to newimage");
		return ct;
	}

	if (p->ct_next) {
		yyerror("multiple filename specified to newimage");
		return ct;
	}

	ct->ctm_fname = embed_fname(p->ctc_value);
	if (mgpwdirname[0] != '\0'
	 && strncmp(mgpwdirname, ct->ctm_fname, strlen(mgpwdirname)) == 0)
		;	/* do not chkfile() */
	else
		chkfile(ct->ctm_fname);

	return ct;
}

static struct ctrl *
gen_image(op, fname, colors, xsiz, ysiz, zoomflg)
	int op;
	char *fname;
	int colors;
	int xsiz;
	int ysiz;
	int zoomflg;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate node (op=IMAGE)");
		return ct;
	}
	ct->ctm_fname = embed_fname(fname);
	ct->ctm_numcolor = colors;
	ct->ctm_ximagesize = xsiz;
	ct->ctm_yimagesize = ysiz;
	switch (zoomflg) {
	case 0:
		ct->ctm_zoomflag = 0;
		if (ct->ctm_ximagesize == 0) {
			ct->ctm_ximagesize = 100;
			ct->ctm_zoomflag |= Z_NORMAL;
		} else
			ct->ctm_zoomflag |= Z_SCREEN;
		if (ct->ctm_yimagesize == 0) {
			ct->ctm_yimagesize = 100;
			ct->ctm_zoomflag |= (Z_NORMAL << Z_YSHIFT);
		} else
			ct->ctm_zoomflag |= (Z_SCREEN << Z_YSHIFT);
		break;
	case 1:
		ct->ctm_zoomflag = Z_NORMAL | (Z_NORMAL << Z_YSHIFT);
		break;
	case 2:
		ct->ctm_zoomflag = Z_SCREEN0 | (Z_SCREEN0 << Z_YSHIFT);
		break;
	}
	if (mgpwdirname[0] != '\0' &&
	    strncmp(mgpwdirname, ct->ctm_fname, strlen(mgpwdirname)) == 0)
		;	/* do not chkfile() */
	else
		chkfile(ct->ctm_fname);
	return ct;
}

static struct ctrl *
gen_bar(color, thick, start, len)
	char *color;
	int thick;
	int start;
	int len;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_BAR))) {
		yyerror("cannot allocate node (op=BAR)");
		return ct;
	}
	if (get_color(color, &ct->ctb_color) < 0)
		yyerror("cannot allocate color %s", color);
	ct->ctb_width = thick;
	ct->ctb_start = start;
	ct->ctb_length = len;

	/* normalize */
	if (ct->ctb_width < 0)
		ct->ctb_width = 0;
	else if (1000 < ct->ctb_width)
		ct->ctb_width = 1000;
	if (ct->ctb_start < 0)
		ct->ctb_start = 0;
	else if (100 < ct->ctb_start)
		ct->ctb_start = 100;
	if (100 < ct->ctb_start + ct->ctb_length)
		ct->ctb_length = 100 - ct->ctb_start;

	return ct;
}

static struct ctrl *
gen_icon(n, color, siz)
	char *n;
	char *color;
	int siz;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_ICON))) {
		yyerror("cannot allocate node (op=ICON)");
		return ct;
	}
	ct->ctic_value = n;
	if (get_color(color, &ct->ctic_color) < 0)
		yyerror("cannot allocate color %s", color);
	ct->ctic_size = siz;
	return ct;
}

static struct ctrl *
gen_pcache(flag, mode, effect, value)
	int	flag;
	int	mode;
	int	effect;
	int	value;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_PCACHE))) {
		yyerror("cannot allocate node (op=PCACHE)");
		return ct;
	}
	ct->ctch_flag = flag;
	ct->ctch_mode = mode;
	ct->ctch_effect = effect;
	ct->ctch_value = value;

	return ct;
}

static struct ctrl *
gen_valign(align)
	char *align;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_VALIGN))) {
		yyerror("cannot allocate node (op=VALIGN)");
		return ct;
	}
	if (!strcmp(align, "center")) 
		ct->cti_value = VL_CENTER;
	else { 
		if (!strcmp(align, "top")) 
			ct->cti_value = VL_TOP;
		else {
			if (!strcmp(align, "bottom")) 
				ct->cti_value = VL_BOTTOM;
			else {
				yyerror("%valign center|top|bottom");
				ctlfree(ct);
				return NULL;
			}
		}
	}
	return ct;
}

static struct ctrl *
gen_area(width, height, xoff, yoff)
	int width;
	int height;
	int xoff;
	int yoff;
{
	struct ctrl *ct;

	if (!(ct = ctlalloc1(CTL_AREA))) {
		yyerror("cannot allocate node (op=AREA)");
		return ct;
	}
	if (width < 0 || width > 100)
		width = 100;
	if (height < 0 || height > 100)
		height = 100;
	if (xoff < 0)
		xoff = (100 - width) / 2;
	else if (width + xoff > 100)
		xoff = 100 - width;
	if (yoff < 0)
		yoff = (100 - height) / 2;
#ifdef notdef	/* mgp doesn't check overflow in y axis, anyway. */
	else if (height + yoff > 100)
		yoff = 100 - height;
#endif
	ct->ctar_width = width;
	ct->ctar_height = height;
	ct->ctar_xoff = xoff;
	ct->ctar_yoff = yoff;
	return ct;
}

#if 0

static struct ctrl *
gen_argsfromnid(op, nid)
	int op;
	struct ctrl *nid;
{
	struct ctrl *ct;
	struct ctrl *p;
	int siz;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate args node");
		return ct;
	}

	siz = 0;
	for (p = nid; p; p = p->ct_next)
		siz++;
	ct->cta_argc = siz;
	ct->cta_argv = malloc((siz + 1) * sizeof(char *));
	if (!ct->cta_argv) {
		yyerror("cannot allocate args table");
		return ct;
	}
	siz = 0;
	for (p = nid; p; p = p->ct_next) {
		ct->cta_argv[siz] = strdup(p->ctc_value);
		siz++;
	}
	ct->cta_argv[siz] = NULL;

	if (nid)
		ctlfree(nid);

	return ct;
}

#endif

static struct ctrl *
gen_argsfromstr(op, str, flag)
	int op;
	char *str;
	int flag;
{
	struct ctrl *ct;
	int siz;
	char **h;

	if (!(ct = ctlalloc1(op))) {
		yyerror("cannot allocate args node");
		return ct;
	}

	ct->cta_argc = 0;
	ct->cta_argv = malloc((siz = 16) * sizeof(char *));	/*initial siz*/
	ct->cta_flag = flag;
	if (!ct->cta_argv) {
		yyerror("cannot allocate args table");
		return ct;
	}
	for (h = (char **)ct->cta_argv;
	     (*h = strsep((char **)&str, " "));
	     /*none*/) {
		if (**h != '\0') {
			h++;
			ct->cta_argc++;
			if (siz < ct->cta_argc + 2) {
				siz *= 2;
				ct->cta_argv = realloc(ct->cta_argv,
					siz * sizeof(char *));
				if (!ct->cta_argv) {
					yyerror("cannot allocate args table");
					return ct;
				}
			}
		}
	}
	ct->cta_argv[ct->cta_argc] = NULL;

	return ct;
}

static void
check_xfont(seed, registry)
	char *seed;
	char *registry;
{
	int hyphen;
	char *p;

	hyphen = 0;
	for (p = seed; *p; p++) {
		if (*p == '-')
			hyphen++;
	}
	switch (hyphen) {
	case 0:
	case 1:
	case 2:
	case XLFD_HYPHEN:
		break;
	default:
		yyerror("invalid XFONT seed <%s>", seed);
		break;
	}

	hyphen = 0;
	for (p = registry; *p; p++) {
		if (*p == '-')
			hyphen++;
	}
	switch (hyphen) {
	case 0:
	case 1:
		break;
	default:
		yyerror("invalid XFONT registry <%s>", registry);
		break;
	}
}


#if 0	/*YYBISON*/
int yyparse __P((void));

int
pcap_parse()
{
	return (yyparse());
}
#endif



/* Enabling traces.  */
#ifndef YYDEBUG
# define YYDEBUG 0
#endif

/* Enabling verbose error messages.  */
#ifdef YYERROR_VERBOSE
# undef YYERROR_VERBOSE
# define YYERROR_VERBOSE 1
#else
# define YYERROR_VERBOSE 0
#endif

/* Enabling the token table.  */
#ifndef YYTOKEN_TABLE
# define YYTOKEN_TABLE 0
#endif

#if ! defined YYSTYPE && ! defined YYSTYPE_IS_DECLARED
typedef union YYSTYPE

{
	int i;
	double d;
	char *s;
	struct ctrl *ct;
}
/* Line 193 of yacc.c.  */

	YYSTYPE;
# define yystype YYSTYPE /* obsolescent; will be withdrawn */
# define YYSTYPE_IS_DECLARED 1
# define YYSTYPE_IS_TRIVIAL 1
#endif



/* Copy the second part of user declarations.  */


/* Line 216 of yacc.c.  */


#ifdef short
# undef short
#endif

#ifdef YYTYPE_UINT8
typedef YYTYPE_UINT8 yytype_uint8;
#else
typedef unsigned char yytype_uint8;
#endif

#ifdef YYTYPE_INT8
typedef YYTYPE_INT8 yytype_int8;
#elif (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
typedef signed char yytype_int8;
#else
typedef short int yytype_int8;
#endif

#ifdef YYTYPE_UINT16
typedef YYTYPE_UINT16 yytype_uint16;
#else
typedef unsigned short int yytype_uint16;
#endif

#ifdef YYTYPE_INT16
typedef YYTYPE_INT16 yytype_int16;
#else
typedef short int yytype_int16;
#endif

#ifndef YYSIZE_T
# ifdef __SIZE_TYPE__
#  define YYSIZE_T __SIZE_TYPE__
# elif defined size_t
#  define YYSIZE_T size_t
# elif ! defined YYSIZE_T && (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
#  include <stddef.h> /* INFRINGES ON USER NAME SPACE */
#  define YYSIZE_T size_t
# else
#  define YYSIZE_T unsigned int
# endif
#endif

#define YYSIZE_MAXIMUM ((YYSIZE_T) -1)

#ifndef YY_
# if defined YYENABLE_NLS && YYENABLE_NLS
#  if ENABLE_NLS
#   include <libintl.h> /* INFRINGES ON USER NAME SPACE */
#   define YY_(msgid) dgettext ("bison-runtime", msgid)
#  endif
# endif
# ifndef YY_
#  define YY_(msgid) msgid
# endif
#endif

/* Suppress unused-variable warnings by "using" E.  */
#if ! defined lint || defined __GNUC__
# define YYUSE(e) ((void) (e))
#else
# define YYUSE(e) /* empty */
#endif

/* Identity function, used to suppress warnings about constant conditions.  */
#ifndef lint
# define YYID(n) (n)
#else
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static int
YYID (int i)
#else
static int
YYID (i)
    int i;
#endif
{
  return i;
}
#endif

#if ! defined yyoverflow || YYERROR_VERBOSE

/* The parser invokes alloca or malloc; define the necessary symbols.  */

# ifdef YYSTACK_USE_ALLOCA
#  if YYSTACK_USE_ALLOCA
#   ifdef __GNUC__
#    define YYSTACK_ALLOC __builtin_alloca
#   elif defined __BUILTIN_VA_ARG_INCR
#    include <alloca.h> /* INFRINGES ON USER NAME SPACE */
#   elif defined _AIX
#    define YYSTACK_ALLOC __alloca
#   elif defined _MSC_VER
#    include <malloc.h> /* INFRINGES ON USER NAME SPACE */
#    define alloca _alloca
#   else
#    define YYSTACK_ALLOC alloca
#    if ! defined _ALLOCA_H && ! defined _STDLIB_H && (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
#     include <stdlib.h> /* INFRINGES ON USER NAME SPACE */
#     ifndef _STDLIB_H
#      define _STDLIB_H 1
#     endif
#    endif
#   endif
#  endif
# endif

# ifdef YYSTACK_ALLOC
   /* Pacify GCC's `empty if-body' warning.  */
#  define YYSTACK_FREE(Ptr) do { /* empty */; } while (YYID (0))
#  ifndef YYSTACK_ALLOC_MAXIMUM
    /* The OS might guarantee only one guard page at the bottom of the stack,
       and a page size can be as small as 4096 bytes.  So we cannot safely
       invoke alloca (N) if N exceeds 4096.  Use a slightly smaller number
       to allow for a few compiler-allocated temporary stack slots.  */
#   define YYSTACK_ALLOC_MAXIMUM 4032 /* reasonable circa 2006 */
#  endif
# else
#  define YYSTACK_ALLOC YYMALLOC
#  define YYSTACK_FREE YYFREE
#  ifndef YYSTACK_ALLOC_MAXIMUM
#   define YYSTACK_ALLOC_MAXIMUM YYSIZE_MAXIMUM
#  endif
#  if (defined __cplusplus && ! defined _STDLIB_H \
       && ! ((defined YYMALLOC || defined malloc) \
	     && (defined YYFREE || defined free)))
#   include <stdlib.h> /* INFRINGES ON USER NAME SPACE */
#   ifndef _STDLIB_H
#    define _STDLIB_H 1
#   endif
#  endif
#  ifndef YYMALLOC
#   define YYMALLOC malloc
#   if ! defined malloc && ! defined _STDLIB_H && (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
void *malloc (YYSIZE_T); /* INFRINGES ON USER NAME SPACE */
#   endif
#  endif
#  ifndef YYFREE
#   define YYFREE free
#   if ! defined free && ! defined _STDLIB_H && (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
void free (void *); /* INFRINGES ON USER NAME SPACE */
#   endif
#  endif
# endif
#endif /* ! defined yyoverflow || YYERROR_VERBOSE */


#if (! defined yyoverflow \
     && (! defined __cplusplus \
	 || (defined YYSTYPE_IS_TRIVIAL && YYSTYPE_IS_TRIVIAL)))

/* A type that is properly aligned for any stack member.  */
union yyalloc
{
  yytype_int16 yyss;
  YYSTYPE yyvs;
  };

/* The size of the maximum gap between one aligned stack and the next.  */
# define YYSTACK_GAP_MAXIMUM (sizeof (union yyalloc) - 1)

/* The size of an array large to enough to hold all stacks, each with
   N elements.  */
# define YYSTACK_BYTES(N) \
     ((N) * (sizeof (yytype_int16) + sizeof (YYSTYPE)) \
      + YYSTACK_GAP_MAXIMUM)

/* Copy COUNT objects from FROM to TO.  The source and destination do
   not overlap.  */
# ifndef YYCOPY
#  if defined __GNUC__ && 1 < __GNUC__
#   define YYCOPY(To, From, Count) \
      __builtin_memcpy (To, From, (Count) * sizeof (*(From)))
#  else
#   define YYCOPY(To, From, Count)		\
      do					\
	{					\
	  YYSIZE_T yyi;				\
	  for (yyi = 0; yyi < (Count); yyi++)	\
	    (To)[yyi] = (From)[yyi];		\
	}					\
      while (YYID (0))
#  endif
# endif

/* Relocate STACK from its old location to the new one.  The
   local variables YYSIZE and YYSTACKSIZE give the old and new number of
   elements in the stack, and YYPTR gives the new location of the
   stack.  Advance YYPTR to a properly aligned location for the next
   stack.  */
# define YYSTACK_RELOCATE(Stack)					\
    do									\
      {									\
	YYSIZE_T yynewbytes;						\
	YYCOPY (&yyptr->Stack, Stack, yysize);				\
	Stack = &yyptr->Stack;						\
	yynewbytes = yystacksize * sizeof (*Stack) + YYSTACK_GAP_MAXIMUM; \
	yyptr += yynewbytes / sizeof (*yyptr);				\
      }									\
    while (YYID (0))

#endif

/* YYFINAL -- State number of the termination state.  */
#define YYFINAL  128
/* YYLAST -- Last index in YYTABLE.  */
#define YYLAST   248

/* YYNTOKENS -- Number of terminals.  */
#define YYNTOKENS  72
/* YYNNTS -- Number of nonterminals.  */
#define YYNNTS  15
/* YYNRULES -- Number of rules.  */
#define YYNRULES  111
/* YYNRULES -- Number of states.  */
#define YYNSTATES  170

/* YYTRANSLATE(YYLEX) -- Bison symbol number corresponding to YYLEX.  */
#define YYUNDEFTOK  2
#define YYMAXUTOK   326

#define YYTRANSLATE(YYX)						\
  ((unsigned int) (YYX) <= YYMAXUTOK ? yytranslate[YYX] : YYUNDEFTOK)

/* YYTRANSLATE[YYLEX] -- Bison symbol number corresponding to YYLEX.  */
static const yytype_uint8 yytranslate[] =
{
       0,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     2,     2,     2,     2,     2,     1,     2,     3,     4,
       5,     6,     7,     8,     9,    10,    11,    12,    13,    14,
      15,    16,    17,    18,    19,    20,    21,    22,    23,    24,
      25,    26,    27,    28,    29,    30,    31,    32,    33,    34,
      35,    36,    37,    38,    39,    40,    41,    42,    43,    44,
      45,    46,    47,    48,    49,    50,    51,    52,    53,    54,
      55,    56,    57,    58,    59,    60,    61,    62,    63,    64,
      65,    66,    67,    68,    69,    70,    71
};

#if YYDEBUG
/* YYPRHS[YYN] -- Index of the first RHS symbol of rule number YYN in
   YYRHS.  */
static const yytype_uint16 yyprhs[] =
{
       0,     0,     3,     5,     7,     9,    11,    13,    15,    19,
      22,    25,    28,    30,    32,    36,    39,    43,    46,    50,
      53,    56,    58,    61,    64,    66,    69,    71,    74,    76,
      78,    80,    82,    84,    86,    88,    90,    92,    94,    96,
      98,   100,   102,   104,   106,   108,   113,   115,   117,   120,
     123,   126,   129,   132,   135,   138,   141,   144,   152,   159,
     165,   170,   174,   177,   179,   182,   186,   189,   193,   196,
     199,   202,   206,   209,   212,   215,   218,   221,   224,   227,
     230,   233,   237,   242,   249,   255,   260,   264,   267,   273,
     278,   282,   285,   287,   292,   297,   300,   303,   306,   309,
     312,   316,   322,   328,   331,   334,   338,   341,   344,   347,
     350,   353
};

/* YYRHS -- A `-1'-separated list of the rules' RHS.  */
static const yytype_int8 yyrhs[] =
{
      73,     0,    -1,    74,    -1,    75,    -1,    76,    -1,    79,
      -1,    77,    -1,    83,    -1,    83,     3,    74,    -1,    85,
      74,    -1,    84,    74,    -1,    86,    74,    -1,     7,    -1,
       6,    -1,    42,     7,     4,    -1,    42,     7,    -1,    48,
       7,     4,    -1,    48,     7,    -1,    52,     7,     4,    -1,
      52,     7,    -1,    43,     7,    -1,    44,    -1,    56,     7,
      -1,    57,     7,    -1,    78,    -1,    78,    80,    -1,    82,
      -1,    82,    81,    -1,     7,    -1,     6,    -1,     4,    -1,
       9,    -1,    15,    -1,    47,    -1,    17,    -1,    16,    -1,
      18,    -1,    19,    -1,    20,    -1,    21,    -1,    22,    -1,
      31,    -1,    33,    -1,    41,    -1,    27,    -1,    70,     4,
       4,     4,    -1,    68,    -1,    69,    -1,    12,     4,    -1,
      12,     5,    -1,    28,     4,    -1,    29,     4,    -1,    30,
       4,    -1,    45,     4,    -1,    13,    78,    -1,    14,    78,
      -1,    34,    78,    -1,    37,     4,     4,     4,     4,     4,
      80,    -1,    37,     4,     4,     4,     4,     4,    -1,    37,
       4,     4,     4,     4,    -1,    37,     4,     4,     4,    -1,
      37,     4,     4,    -1,    37,     4,    -1,    37,    -1,    23,
      78,    -1,    23,    78,    78,    -1,    26,    78,    -1,    26,
      78,     8,    -1,    24,    78,    -1,    59,    78,    -1,    50,
      78,    -1,    50,    78,    78,    -1,    61,    78,    -1,    55,
      78,    -1,    63,    78,    -1,    36,    78,    -1,    32,     6,
      -1,    32,     7,    -1,    32,     4,    -1,    32,     5,    -1,
      58,    81,    -1,    25,    78,     8,    -1,    25,    78,     4,
       8,    -1,    25,    78,     4,     4,     4,     4,    -1,    25,
      78,     4,     4,     4,    -1,    25,    78,     4,     4,    -1,
      25,    78,     4,    -1,    25,    78,    -1,    35,    78,     4,
       4,     4,    -1,    35,    78,     4,     4,    -1,    35,    78,
       4,    -1,    35,    78,    -1,    35,    -1,    46,     7,    78,
       4,    -1,    46,     6,    78,     4,    -1,    49,     7,    -1,
      51,     7,    -1,    54,     7,    -1,    38,     7,    -1,    60,
       7,    -1,    66,     4,     4,    -1,    66,     4,     4,     4,
       4,    -1,    62,     4,     4,     4,     4,    -1,    62,     4,
      -1,    64,    78,    -1,    71,    78,    78,    -1,    65,    78,
      -1,    67,     4,    -1,    11,     4,    -1,    11,     6,    -1,
      10,     4,    -1,    53,     7,    -1
};

/* YYRLINE[YYN] -- source line where rule number YYN was defined.  */
static const yytype_uint16 yyrline[] =
{
       0,   801,   801,   802,   803,   804,   805,   807,   808,   810,
     812,   814,   816,   817,   820,   821,   822,   823,   824,   825,
     826,   827,   828,   829,   831,   832,   834,   835,   837,   838,
     839,   844,   845,   846,   847,   848,   849,   850,   851,   852,
     853,   854,   855,   856,   857,   858,   859,   860,   861,   862,
     863,   864,   865,   866,   872,   873,   874,   875,   877,   881,
     885,   889,   893,   896,   899,   911,   915,   916,   921,   930,
     933,   942,   952,   961,   970,   979,   980,   986,   987,   988,
     989,   991,   996,  1001,  1003,  1005,  1007,  1009,  1010,  1012,
    1014,  1015,  1016,  1017,  1019,  1021,  1030,  1039,  1040,  1041,
    1042,  1043,  1044,  1046,  1048,  1058,  1067,  1070,  1072,  1073,
    1075,  1078
};
#endif

#if YYDEBUG || YYERROR_VERBOSE || YYTOKEN_TABLE
/* YYTNAME[SYMBOL-NUM] -- String name of the symbol SYMBOL-NUM.
   First, the terminals, then, starting at YYNTOKENS, nonterminals.  */
static const char *const yytname[] =
{
  "$end", "error", "$undefined", "COMMA", "NUM", "DOUBLE", "ID", "STR",
  "WINSIZ", "KW_NOOP", "KW_DEFAULT", "KW_TAB", "KW_SIZE", "KW_FORE",
  "KW_BACK", "KW_LEFT", "KW_CENTER", "KW_RIGHT", "KW_SHRINK", "KW_LCUTIN",
  "KW_RCUTIN", "KW_CONT", "KW_NODEF", "KW_XFONT", "KW_VFONT", "KW_IMAGE",
  "KW_BIMAGE", "KW_PAGE", "KW_HGAP", "KW_VGAP", "KW_GAP", "KW_PAUSE",
  "KW_PREFIX", "KW_AGAIN", "KW_CCOLOR", "KW_BAR", "KW_INCLUDE", "KW_BGRAD",
  "KW_TEXT", "KW_LINESTART", "KW_LINEEND", "KW_MARK", "KW_SYSTEM",
  "KW_FILTER", "KW_ENDFILTER", "KW_QUALITY", "KW_ICON", "KW_LEFTFILL",
  "KW_XSYSTEM", "KW_VFCAP", "KW_TFONT", "KW_TFDIR", "KW_TSYSTEM",
  "KW_DEFFONT", "KW_FONT", "KW_TFONT0", "KW_EMBED", "KW_ENDEMBED",
  "KW_NEWIMAGE", "KW_PSFONT", "KW_CHARSET", "KW_TMFONT", "KW_PCACHE",
  "KW_TMFONT0", "KW_ANIM", "KW_VALIGN", "KW_AREA", "KW_OPAQUE", "KW_SUP",
  "KW_SUB", "KW_SETSUP", "KW_M17N", "$accept", "toplevel", "line",
  "defaultline", "tabline", "deffontline", "STRorID", "shellline", "nid",
  "args", "arg", "cmd", "tabcmd", "defaultcmd", "deffontcmd", 0
};
#endif

# ifdef YYPRINT
/* YYTOKNUM[YYLEX-NUM] -- Internal token number corresponding to
   token YYLEX-NUM.  */
static const yytype_uint16 yytoknum[] =
{
       0,   256,   257,   258,   259,   260,   261,   262,   263,   264,
     265,   266,   267,   268,   269,   270,   271,   272,   273,   274,
     275,   276,   277,   278,   279,   280,   281,   282,   283,   284,
     285,   286,   287,   288,   289,   290,   291,   292,   293,   294,
     295,   296,   297,   298,   299,   300,   301,   302,   303,   304,
     305,   306,   307,   308,   309,   310,   311,   312,   313,   314,
     315,   316,   317,   318,   319,   320,   321,   322,   323,   324,
     325,   326
};
# endif

/* YYR1[YYN] -- Symbol number of symbol that rule YYN derives.  */
static const yytype_uint8 yyr1[] =
{
       0,    72,    73,    73,    73,    73,    73,    74,    74,    75,
      76,    77,    78,    78,    79,    79,    79,    79,    79,    79,
      79,    79,    79,    79,    80,    80,    81,    81,    82,    82,
      82,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    83,    83,
      83,    83,    83,    83,    83,    83,    83,    83,    84,    84,
      85,    86
};

/* YYR2[YYN] -- Number of symbols composing right hand side of rule YYN.  */
static const yytype_uint8 yyr2[] =
{
       0,     2,     1,     1,     1,     1,     1,     1,     3,     2,
       2,     2,     1,     1,     3,     2,     3,     2,     3,     2,
       2,     1,     2,     2,     1,     2,     1,     2,     1,     1,
       1,     1,     1,     1,     1,     1,     1,     1,     1,     1,
       1,     1,     1,     1,     1,     4,     1,     1,     2,     2,
       2,     2,     2,     2,     2,     2,     2,     7,     6,     5,
       4,     3,     2,     1,     2,     3,     2,     3,     2,     2,
       2,     3,     2,     2,     2,     2,     2,     2,     2,     2,
       2,     3,     4,     6,     5,     4,     3,     2,     5,     4,
       3,     2,     1,     4,     4,     2,     2,     2,     2,     2,
       3,     5,     5,     2,     2,     3,     2,     2,     2,     2,
       2,     2
};

/* YYDEFACT[STATE-NAME] -- Default rule to reduce with in state
   STATE-NUM when YYTABLE doesn't specify something else to do.  Zero
   means the default is an error.  */
static const yytype_uint8 yydefact[] =
{
       0,    31,     0,     0,     0,     0,     0,    32,    35,    34,
      36,    37,    38,    39,    40,     0,     0,     0,     0,    44,
       0,     0,     0,    41,     0,    42,     0,    92,     0,    63,
       0,    43,     0,     0,    21,     0,     0,    33,     0,     0,
       0,     0,     0,     0,     0,     0,     0,     0,     0,     0,
       0,     0,     0,     0,     0,     0,     0,     0,    46,    47,
       0,     0,     0,     2,     3,     4,     6,     5,     7,     0,
       0,     0,   110,   108,   109,    48,    49,    13,    12,    54,
      55,    64,    68,    87,    66,    50,    51,    52,    78,    79,
      76,    77,    56,    91,    75,    62,    98,    15,    20,    53,
       0,     0,    17,    95,    70,    96,    19,   111,    97,    73,
      22,    23,    30,    29,    28,    80,    26,    69,    99,    72,
     103,    74,   104,   106,     0,   107,     0,     0,     1,     0,
      10,     9,    11,    65,    86,    81,    67,    90,    61,    14,
       0,     0,    16,    71,    18,    27,     0,   100,     0,   105,
       8,    85,    82,    89,    60,    94,    93,     0,     0,    45,
      84,    88,    59,   102,   101,    83,    58,    24,    57,    25
};

/* YYDEFGOTO[NTERM-NUM].  */
static const yytype_int16 yydefgoto[] =
{
      -1,    62,    63,    64,    65,    66,   167,    67,   168,   115,
     116,    68,    69,    70,    71
};

/* YYPACT[STATE-NUM] -- Index in YYTABLE of the portion describing
   STATE-NUM.  */
#define YYPACT_NINF -104
static const yytype_int16 yypact[] =
{
     114,  -104,     3,     2,    11,    22,    22,  -104,  -104,  -104,
    -104,  -104,  -104,  -104,  -104,    22,    22,    22,    22,  -104,
      28,    29,    30,  -104,    20,  -104,    22,    22,    22,    32,
      31,  -104,    34,    35,  -104,    33,    24,  -104,    36,    38,
      22,    40,    44,    45,    46,    22,    47,    48,    13,    22,
      50,    22,    54,    22,    22,    22,    55,    56,  -104,  -104,
      57,    22,    39,  -104,  -104,  -104,  -104,  -104,    60,   177,
     177,   177,  -104,  -104,  -104,  -104,  -104,  -104,  -104,  -104,
    -104,    22,  -104,     1,    58,  -104,  -104,  -104,  -104,  -104,
    -104,  -104,  -104,    61,  -104,    63,  -104,    64,  -104,  -104,
      22,    22,    65,  -104,    22,  -104,    66,  -104,  -104,  -104,
    -104,  -104,  -104,  -104,  -104,  -104,    13,  -104,  -104,  -104,
      67,  -104,  -104,  -104,    68,  -104,    69,    22,  -104,   177,
    -104,  -104,  -104,  -104,    10,  -104,  -104,    70,    71,  -104,
      73,    74,  -104,  -104,  -104,  -104,    75,    76,    77,  -104,
    -104,    78,  -104,    79,    80,  -104,  -104,    81,    82,  -104,
      83,  -104,    84,  -104,  -104,  -104,    22,    22,  -104,  -104
};

/* YYPGOTO[NTERM-NUM].  */
static const yytype_int8 yypgoto[] =
{
    -104,  -104,   -67,  -104,  -104,  -104,    -5,  -104,  -103,   -27,
    -104,  -104,  -104,  -104,  -104
};

/* YYTABLE[YYPACT[STATE-NUM]].  What to do in state STATE-NUM.  If
   positive, shift that token.  If negative, reduce the rule which
   number is the opposite.  If zero, do what YYDEFACT says.
   If YYTABLE_NINF, syntax error.  */
#define YYTABLE_NINF -1
static const yytype_uint8 yytable[] =
{
      79,    80,   130,   131,   132,   134,    73,    72,    74,   135,
      81,    82,    83,    84,   151,    75,    76,   112,   152,   113,
     114,    92,    93,    94,    88,    89,    90,    91,    77,    78,
     100,   101,    85,    86,    87,   104,    95,    99,    96,   128,
     109,    97,    98,   102,   117,   103,   119,   105,   121,   122,
     123,   106,   107,   108,   110,   111,   127,   118,   120,   124,
     125,   126,   150,   129,   169,   137,   136,   138,   139,   142,
     144,   146,   147,   148,   153,   154,   133,   155,   156,   157,
     158,   159,   160,   161,   162,   163,   164,   165,   166,   145,
       0,     0,     0,     0,     0,   140,   141,     0,     0,   143,
       0,     0,     0,     0,     0,     0,     0,     0,     0,     0,
       0,     0,     0,     0,     0,     0,     0,     0,     0,     0,
       0,     0,   149,     1,     2,     3,     4,     5,     6,     7,
       8,     9,    10,    11,    12,    13,    14,    15,    16,    17,
      18,    19,    20,    21,    22,    23,    24,    25,    26,    27,
      28,    29,    30,     0,     0,    31,    32,    33,    34,    35,
      36,    37,    38,    39,    40,    41,    42,    43,    44,    45,
      46,    47,    48,    49,    50,    51,    52,    53,    54,    55,
      56,    57,    58,    59,    60,    61,     1,     0,     0,     4,
       5,     6,     7,     8,     9,    10,    11,    12,    13,    14,
      15,    16,    17,    18,    19,    20,    21,    22,    23,    24,
      25,    26,    27,    28,    29,    30,     0,     0,    31,     0,
       0,     0,    35,    36,    37,     0,    39,    40,    41,     0,
       0,    44,    45,     0,     0,    48,    49,    50,    51,    52,
      53,    54,    55,    56,    57,    58,    59,    60,    61
};

static const yytype_int16 yycheck[] =
{
       5,     6,    69,    70,    71,     4,     4,     4,     6,     8,
      15,    16,    17,    18,     4,     4,     5,     4,     8,     6,
       7,    26,    27,    28,     4,     5,     6,     7,     6,     7,
       6,     7,     4,     4,     4,    40,     4,     4,     7,     0,
      45,     7,     7,     7,    49,     7,    51,     7,    53,    54,
      55,     7,     7,     7,     7,     7,    61,     7,     4,     4,
       4,     4,   129,     3,   167,     4,     8,     4,     4,     4,
       4,     4,     4,     4,     4,     4,    81,     4,     4,     4,
       4,     4,     4,     4,     4,     4,     4,     4,     4,   116,
      -1,    -1,    -1,    -1,    -1,   100,   101,    -1,    -1,   104,
      -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
      -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
      -1,    -1,   127,     9,    10,    11,    12,    13,    14,    15,
      16,    17,    18,    19,    20,    21,    22,    23,    24,    25,
      26,    27,    28,    29,    30,    31,    32,    33,    34,    35,
      36,    37,    38,    -1,    -1,    41,    42,    43,    44,    45,
      46,    47,    48,    49,    50,    51,    52,    53,    54,    55,
      56,    57,    58,    59,    60,    61,    62,    63,    64,    65,
      66,    67,    68,    69,    70,    71,     9,    -1,    -1,    12,
      13,    14,    15,    16,    17,    18,    19,    20,    21,    22,
      23,    24,    25,    26,    27,    28,    29,    30,    31,    32,
      33,    34,    35,    36,    37,    38,    -1,    -1,    41,    -1,
      -1,    -1,    45,    46,    47,    -1,    49,    50,    51,    -1,
      -1,    54,    55,    -1,    -1,    58,    59,    60,    61,    62,
      63,    64,    65,    66,    67,    68,    69,    70,    71
};

/* YYSTOS[STATE-NUM] -- The (internal number of the) accessing
   symbol of state STATE-NUM.  */
static const yytype_uint8 yystos[] =
{
       0,     9,    10,    11,    12,    13,    14,    15,    16,    17,
      18,    19,    20,    21,    22,    23,    24,    25,    26,    27,
      28,    29,    30,    31,    32,    33,    34,    35,    36,    37,
      38,    41,    42,    43,    44,    45,    46,    47,    48,    49,
      50,    51,    52,    53,    54,    55,    56,    57,    58,    59,
      60,    61,    62,    63,    64,    65,    66,    67,    68,    69,
      70,    71,    73,    74,    75,    76,    77,    79,    83,    84,
      85,    86,     4,     4,     6,     4,     5,     6,     7,    78,
      78,    78,    78,    78,    78,     4,     4,     4,     4,     5,
       6,     7,    78,    78,    78,     4,     7,     7,     7,     4,
       6,     7,     7,     7,    78,     7,     7,     7,     7,    78,
       7,     7,     4,     6,     7,    81,    82,    78,     7,    78,
       4,    78,    78,    78,     4,     4,     4,    78,     0,     3,
      74,    74,    74,    78,     4,     8,     8,     4,     4,     4,
      78,    78,     4,    78,     4,    81,     4,     4,     4,    78,
      74,     4,     8,     4,     4,     4,     4,     4,     4,     4,
       4,     4,     4,     4,     4,     4,     4,    78,    80,    80
};

#define yyerrok		(yyerrstatus = 0)
#define yyclearin	(yychar = YYEMPTY)
#define YYEMPTY		(-2)
#define YYEOF		0

#define YYACCEPT	goto yyacceptlab
#define YYABORT		goto yyabortlab
#define YYERROR		goto yyerrorlab


/* Like YYERROR except do call yyerror.  This remains here temporarily
   to ease the transition to the new meaning of YYERROR, for GCC.
   Once GCC version 2 has supplanted version 1, this can go.  */

#define YYFAIL		goto yyerrlab

#define YYRECOVERING()  (!!yyerrstatus)

#define YYBACKUP(Token, Value)					\
do								\
  if (yychar == YYEMPTY && yylen == 1)				\
    {								\
      yychar = (Token);						\
      yylval = (Value);						\
      yytoken = YYTRANSLATE (yychar);				\
      YYPOPSTACK (1);						\
      goto yybackup;						\
    }								\
  else								\
    {								\
      yyerror (YY_("syntax error: cannot back up")); \
      YYERROR;							\
    }								\
while (YYID (0))


#define YYTERROR	1
#define YYERRCODE	256


/* YYLLOC_DEFAULT -- Set CURRENT to span from RHS[1] to RHS[N].
   If N is 0, then set CURRENT to the empty location which ends
   the previous symbol: RHS[0] (always defined).  */

#define YYRHSLOC(Rhs, K) ((Rhs)[K])
#ifndef YYLLOC_DEFAULT
# define YYLLOC_DEFAULT(Current, Rhs, N)				\
    do									\
      if (YYID (N))                                                    \
	{								\
	  (Current).first_line   = YYRHSLOC (Rhs, 1).first_line;	\
	  (Current).first_column = YYRHSLOC (Rhs, 1).first_column;	\
	  (Current).last_line    = YYRHSLOC (Rhs, N).last_line;		\
	  (Current).last_column  = YYRHSLOC (Rhs, N).last_column;	\
	}								\
      else								\
	{								\
	  (Current).first_line   = (Current).last_line   =		\
	    YYRHSLOC (Rhs, 0).last_line;				\
	  (Current).first_column = (Current).last_column =		\
	    YYRHSLOC (Rhs, 0).last_column;				\
	}								\
    while (YYID (0))
#endif


/* YY_LOCATION_PRINT -- Print the location on the stream.
   This macro was not mandated originally: define only if we know
   we won't break user code: when these are the locations we know.  */

#ifndef YY_LOCATION_PRINT
# if defined YYLTYPE_IS_TRIVIAL && YYLTYPE_IS_TRIVIAL
#  define YY_LOCATION_PRINT(File, Loc)			\
     fprintf (File, "%d.%d-%d.%d",			\
	      (Loc).first_line, (Loc).first_column,	\
	      (Loc).last_line,  (Loc).last_column)
# else
#  define YY_LOCATION_PRINT(File, Loc) ((void) 0)
# endif
#endif


/* YYLEX -- calling `yylex' with the right arguments.  */

#ifdef YYLEX_PARAM
# define YYLEX yylex (YYLEX_PARAM)
#else
# define YYLEX yylex ()
#endif

/* Enable debugging if requested.  */
#if YYDEBUG

# ifndef YYFPRINTF
#  include <stdio.h> /* INFRINGES ON USER NAME SPACE */
#  define YYFPRINTF fprintf
# endif

# define YYDPRINTF(Args)			\
do {						\
  if (yydebug)					\
    YYFPRINTF Args;				\
} while (YYID (0))

# define YY_SYMBOL_PRINT(Title, Type, Value, Location)			  \
do {									  \
  if (yydebug)								  \
    {									  \
      YYFPRINTF (stderr, "%s ", Title);					  \
      yy_symbol_print (stderr,						  \
		  Type, Value); \
      YYFPRINTF (stderr, "\n");						  \
    }									  \
} while (YYID (0))


/*--------------------------------.
| Print this symbol on YYOUTPUT.  |
`--------------------------------*/

/*ARGSUSED*/
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static void
yy_symbol_value_print (FILE *yyoutput, int yytype, YYSTYPE const * const yyvaluep)
#else
static void
yy_symbol_value_print (yyoutput, yytype, yyvaluep)
    FILE *yyoutput;
    int yytype;
    YYSTYPE const * const yyvaluep;
#endif
{
  if (!yyvaluep)
    return;
# ifdef YYPRINT
  if (yytype < YYNTOKENS)
    YYPRINT (yyoutput, yytoknum[yytype], *yyvaluep);
# else
  YYUSE (yyoutput);
# endif
  switch (yytype)
    {
      default:
	break;
    }
}


/*--------------------------------.
| Print this symbol on YYOUTPUT.  |
`--------------------------------*/

#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static void
yy_symbol_print (FILE *yyoutput, int yytype, YYSTYPE const * const yyvaluep)
#else
static void
yy_symbol_print (yyoutput, yytype, yyvaluep)
    FILE *yyoutput;
    int yytype;
    YYSTYPE const * const yyvaluep;
#endif
{
  if (yytype < YYNTOKENS)
    YYFPRINTF (yyoutput, "token %s (", yytname[yytype]);
  else
    YYFPRINTF (yyoutput, "nterm %s (", yytname[yytype]);

  yy_symbol_value_print (yyoutput, yytype, yyvaluep);
  YYFPRINTF (yyoutput, ")");
}

/*------------------------------------------------------------------.
| yy_stack_print -- Print the state stack from its BOTTOM up to its |
| TOP (included).                                                   |
`------------------------------------------------------------------*/

#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static void
yy_stack_print (yytype_int16 *bottom, yytype_int16 *top)
#else
static void
yy_stack_print (bottom, top)
    yytype_int16 *bottom;
    yytype_int16 *top;
#endif
{
  YYFPRINTF (stderr, "Stack now");
  for (; bottom <= top; ++bottom)
    YYFPRINTF (stderr, " %d", *bottom);
  YYFPRINTF (stderr, "\n");
}

# define YY_STACK_PRINT(Bottom, Top)				\
do {								\
  if (yydebug)							\
    yy_stack_print ((Bottom), (Top));				\
} while (YYID (0))


/*------------------------------------------------.
| Report that the YYRULE is going to be reduced.  |
`------------------------------------------------*/

#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static void
yy_reduce_print (YYSTYPE *yyvsp, int yyrule)
#else
static void
yy_reduce_print (yyvsp, yyrule)
    YYSTYPE *yyvsp;
    int yyrule;
#endif
{
  int yynrhs = yyr2[yyrule];
  int yyi;
  unsigned long int yylno = yyrline[yyrule];
  YYFPRINTF (stderr, "Reducing stack by rule %d (line %lu):\n",
	     yyrule - 1, yylno);
  /* The symbols being reduced.  */
  for (yyi = 0; yyi < yynrhs; yyi++)
    {
      fprintf (stderr, "   $%d = ", yyi + 1);
      yy_symbol_print (stderr, yyrhs[yyprhs[yyrule] + yyi],
		       &(yyvsp[(yyi + 1) - (yynrhs)])
		       		       );
      fprintf (stderr, "\n");
    }
}

# define YY_REDUCE_PRINT(Rule)		\
do {					\
  if (yydebug)				\
    yy_reduce_print (yyvsp, Rule); \
} while (YYID (0))

/* Nonzero means print parse trace.  It is left uninitialized so that
   multiple parsers can coexist.  */
int yydebug;
#else /* !YYDEBUG */
# define YYDPRINTF(Args)
# define YY_SYMBOL_PRINT(Title, Type, Value, Location)
# define YY_STACK_PRINT(Bottom, Top)
# define YY_REDUCE_PRINT(Rule)
#endif /* !YYDEBUG */


/* YYINITDEPTH -- initial size of the parser's stacks.  */
#ifndef	YYINITDEPTH
# define YYINITDEPTH 200
#endif

/* YYMAXDEPTH -- maximum size the stacks can grow to (effective only
   if the built-in stack extension method is used).

   Do not make this value too large; the results are undefined if
   YYSTACK_ALLOC_MAXIMUM < YYSTACK_BYTES (YYMAXDEPTH)
   evaluated with infinite-precision integer arithmetic.  */

#ifndef YYMAXDEPTH
# define YYMAXDEPTH 10000
#endif



#if YYERROR_VERBOSE

# ifndef yystrlen
#  if defined __GLIBC__ && defined _STRING_H
#   define yystrlen strlen
#  else
/* Return the length of YYSTR.  */
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static YYSIZE_T
yystrlen (const char *yystr)
#else
static YYSIZE_T
yystrlen (yystr)
    const char *yystr;
#endif
{
  YYSIZE_T yylen;
  for (yylen = 0; yystr[yylen]; yylen++)
    continue;
  return yylen;
}
#  endif
# endif

# ifndef yystpcpy
#  if defined __GLIBC__ && defined _STRING_H && defined _GNU_SOURCE
#   define yystpcpy stpcpy
#  else
/* Copy YYSRC to YYDEST, returning the address of the terminating '\0' in
   YYDEST.  */
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static char *
yystpcpy (char *yydest, const char *yysrc)
#else
static char *
yystpcpy (yydest, yysrc)
    char *yydest;
    const char *yysrc;
#endif
{
  char *yyd = yydest;
  const char *yys = yysrc;

  while ((*yyd++ = *yys++) != '\0')
    continue;

  return yyd - 1;
}
#  endif
# endif

# ifndef yytnamerr
/* Copy to YYRES the contents of YYSTR after stripping away unnecessary
   quotes and backslashes, so that it's suitable for yyerror.  The
   heuristic is that double-quoting is unnecessary unless the string
   contains an apostrophe, a comma, or backslash (other than
   backslash-backslash).  YYSTR is taken from yytname.  If YYRES is
   null, do not copy; instead, return the length of what the result
   would have been.  */
static YYSIZE_T
yytnamerr (char *yyres, const char *yystr)
{
  if (*yystr == '"')
    {
      YYSIZE_T yyn = 0;
      char const *yyp = yystr;

      for (;;)
	switch (*++yyp)
	  {
	  case '\'':
	  case ',':
	    goto do_not_strip_quotes;

	  case '\\':
	    if (*++yyp != '\\')
	      goto do_not_strip_quotes;
	    /* Fall through.  */
	  default:
	    if (yyres)
	      yyres[yyn] = *yyp;
	    yyn++;
	    break;

	  case '"':
	    if (yyres)
	      yyres[yyn] = '\0';
	    return yyn;
	  }
    do_not_strip_quotes: ;
    }

  if (! yyres)
    return yystrlen (yystr);

  return yystpcpy (yyres, yystr) - yyres;
}
# endif

/* Copy into YYRESULT an error message about the unexpected token
   YYCHAR while in state YYSTATE.  Return the number of bytes copied,
   including the terminating null byte.  If YYRESULT is null, do not
   copy anything; just return the number of bytes that would be
   copied.  As a special case, return 0 if an ordinary "syntax error"
   message will do.  Return YYSIZE_MAXIMUM if overflow occurs during
   size calculation.  */
static YYSIZE_T
yysyntax_error (char *yyresult, int yystate, int yychar)
{
  int yyn = yypact[yystate];

  if (! (YYPACT_NINF < yyn && yyn <= YYLAST))
    return 0;
  else
    {
      int yytype = YYTRANSLATE (yychar);
      YYSIZE_T yysize0 = yytnamerr (0, yytname[yytype]);
      YYSIZE_T yysize = yysize0;
      YYSIZE_T yysize1;
      int yysize_overflow = 0;
      enum { YYERROR_VERBOSE_ARGS_MAXIMUM = 5 };
      char const *yyarg[YYERROR_VERBOSE_ARGS_MAXIMUM];
      int yyx;

# if 0
      /* This is so xgettext sees the translatable formats that are
	 constructed on the fly.  */
      YY_("syntax error, unexpected %s");
      YY_("syntax error, unexpected %s, expecting %s");
      YY_("syntax error, unexpected %s, expecting %s or %s");
      YY_("syntax error, unexpected %s, expecting %s or %s or %s");
      YY_("syntax error, unexpected %s, expecting %s or %s or %s or %s");
# endif
      char *yyfmt;
      char const *yyf;
      static char const yyunexpected[] = "syntax error, unexpected %s";
      static char const yyexpecting[] = ", expecting %s";
      static char const yyor[] = " or %s";
      char yyformat[sizeof yyunexpected
		    + sizeof yyexpecting - 1
		    + ((YYERROR_VERBOSE_ARGS_MAXIMUM - 2)
		       * (sizeof yyor - 1))];
      char const *yyprefix = yyexpecting;

      /* Start YYX at -YYN if negative to avoid negative indexes in
	 YYCHECK.  */
      int yyxbegin = yyn < 0 ? -yyn : 0;

      /* Stay within bounds of both yycheck and yytname.  */
      int yychecklim = YYLAST - yyn + 1;
      int yyxend = yychecklim < YYNTOKENS ? yychecklim : YYNTOKENS;
      int yycount = 1;

      yyarg[0] = yytname[yytype];
      yyfmt = yystpcpy (yyformat, yyunexpected);

      for (yyx = yyxbegin; yyx < yyxend; ++yyx)
	if (yycheck[yyx + yyn] == yyx && yyx != YYTERROR)
	  {
	    if (yycount == YYERROR_VERBOSE_ARGS_MAXIMUM)
	      {
		yycount = 1;
		yysize = yysize0;
		yyformat[sizeof yyunexpected - 1] = '\0';
		break;
	      }
	    yyarg[yycount++] = yytname[yyx];
	    yysize1 = yysize + yytnamerr (0, yytname[yyx]);
	    yysize_overflow |= (yysize1 < yysize);
	    yysize = yysize1;
	    yyfmt = yystpcpy (yyfmt, yyprefix);
	    yyprefix = yyor;
	  }

      yyf = YY_(yyformat);
      yysize1 = yysize + yystrlen (yyf);
      yysize_overflow |= (yysize1 < yysize);
      yysize = yysize1;

      if (yysize_overflow)
	return YYSIZE_MAXIMUM;

      if (yyresult)
	{
	  /* Avoid sprintf, as that infringes on the user's name space.
	     Don't have undefined behavior even if the translation
	     produced a string with the wrong number of "%s"s.  */
	  char *yyp = yyresult;
	  int yyi = 0;
	  while ((*yyp = *yyf) != '\0')
	    {
	      if (*yyp == '%' && yyf[1] == 's' && yyi < yycount)
		{
		  yyp += yytnamerr (yyp, yyarg[yyi++]);
		  yyf += 2;
		}
	      else
		{
		  yyp++;
		  yyf++;
		}
	    }
	}
      return yysize;
    }
}
#endif /* YYERROR_VERBOSE */


/*-----------------------------------------------.
| Release the memory associated to this symbol.  |
`-----------------------------------------------*/

/*ARGSUSED*/
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
static void
yydestruct (const char *yymsg, int yytype, YYSTYPE *yyvaluep)
#else
static void
yydestruct (yymsg, yytype, yyvaluep)
    const char *yymsg;
    int yytype;
    YYSTYPE *yyvaluep;
#endif
{
  YYUSE (yyvaluep);

  if (!yymsg)
    yymsg = "Deleting";
  YY_SYMBOL_PRINT (yymsg, yytype, yyvaluep, yylocationp);

  switch (yytype)
    {

      default:
	break;
    }
}


/* Prevent warnings from -Wmissing-prototypes.  */

#ifdef YYPARSE_PARAM
#if defined __STDC__ || defined __cplusplus
int yyparse (void *YYPARSE_PARAM);
#else
int yyparse ();
#endif
#else /* ! YYPARSE_PARAM */
#if defined __STDC__ || defined __cplusplus
int yyparse (void);
#else
int yyparse ();
#endif
#endif /* ! YYPARSE_PARAM */



/* The look-ahead symbol.  */
int yychar;

/* The semantic value of the look-ahead symbol.  */
YYSTYPE yylval;

/* Number of syntax errors so far.  */
int yynerrs;



/*----------.
| yyparse.  |
`----------*/

#ifdef YYPARSE_PARAM
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
int
yyparse (void *YYPARSE_PARAM)
#else
int
yyparse (YYPARSE_PARAM)
    void *YYPARSE_PARAM;
#endif
#else /* ! YYPARSE_PARAM */
#if (defined __STDC__ || defined __C99__FUNC__ \
     || defined __cplusplus || defined _MSC_VER)
int
yyparse (void)
#else
int
yyparse ()

#endif
#endif
{
  
  int yystate;
  int yyn;
  int yyresult;
  /* Number of tokens to shift before error messages enabled.  */
  int yyerrstatus;
  /* Look-ahead token as an internal (translated) token number.  */
  int yytoken = 0;
#if YYERROR_VERBOSE
  /* Buffer for error messages, and its allocated size.  */
  char yymsgbuf[128];
  char *yymsg = yymsgbuf;
  YYSIZE_T yymsg_alloc = sizeof yymsgbuf;
#endif

  /* Three stacks and their tools:
     `yyss': related to states,
     `yyvs': related to semantic values,
     `yyls': related to locations.

     Refer to the stacks thru separate pointers, to allow yyoverflow
     to reallocate them elsewhere.  */

  /* The state stack.  */
  yytype_int16 yyssa[YYINITDEPTH];
  yytype_int16 *yyss = yyssa;
  yytype_int16 *yyssp;

  /* The semantic value stack.  */
  YYSTYPE yyvsa[YYINITDEPTH];
  YYSTYPE *yyvs = yyvsa;
  YYSTYPE *yyvsp;



#define YYPOPSTACK(N)   (yyvsp -= (N), yyssp -= (N))

  YYSIZE_T yystacksize = YYINITDEPTH;

  /* The variables used to return semantic value and location from the
     action routines.  */
  YYSTYPE yyval;


  /* The number of symbols on the RHS of the reduced rule.
     Keep to zero when no symbol should be popped.  */
  int yylen = 0;

  YYDPRINTF ((stderr, "Starting parse\n"));

  yystate = 0;
  yyerrstatus = 0;
  yynerrs = 0;
  yychar = YYEMPTY;		/* Cause a token to be read.  */

  /* Initialize stack pointers.
     Waste one element of value and location stack
     so that they stay on the same level as the state stack.
     The wasted elements are never initialized.  */

  yyssp = yyss;
  yyvsp = yyvs;

  goto yysetstate;

/*------------------------------------------------------------.
| yynewstate -- Push a new state, which is found in yystate.  |
`------------------------------------------------------------*/
 yynewstate:
  /* In all cases, when you get here, the value and location stacks
     have just been pushed.  So pushing a state here evens the stacks.  */
  yyssp++;

 yysetstate:
  *yyssp = yystate;

  if (yyss + yystacksize - 1 <= yyssp)
    {
      /* Get the current used size of the three stacks, in elements.  */
      YYSIZE_T yysize = yyssp - yyss + 1;

#ifdef yyoverflow
      {
	/* Give user a chance to reallocate the stack.  Use copies of
	   these so that the &'s don't force the real ones into
	   memory.  */
	YYSTYPE *yyvs1 = yyvs;
	yytype_int16 *yyss1 = yyss;


	/* Each stack pointer address is followed by the size of the
	   data in use in that stack, in bytes.  This used to be a
	   conditional around just the two extra args, but that might
	   be undefined if yyoverflow is a macro.  */
	yyoverflow (YY_("memory exhausted"),
		    &yyss1, yysize * sizeof (*yyssp),
		    &yyvs1, yysize * sizeof (*yyvsp),

		    &yystacksize);

	yyss = yyss1;
	yyvs = yyvs1;
      }
#else /* no yyoverflow */
# ifndef YYSTACK_RELOCATE
      goto yyexhaustedlab;
# else
      /* Extend the stack our own way.  */
      if (YYMAXDEPTH <= yystacksize)
	goto yyexhaustedlab;
      yystacksize *= 2;
      if (YYMAXDEPTH < yystacksize)
	yystacksize = YYMAXDEPTH;

      {
	yytype_int16 *yyss1 = yyss;
	union yyalloc *yyptr =
	  (union yyalloc *) YYSTACK_ALLOC (YYSTACK_BYTES (yystacksize));
	if (! yyptr)
	  goto yyexhaustedlab;
	YYSTACK_RELOCATE (yyss);
	YYSTACK_RELOCATE (yyvs);

#  undef YYSTACK_RELOCATE
	if (yyss1 != yyssa)
	  YYSTACK_FREE (yyss1);
      }
# endif
#endif /* no yyoverflow */

      yyssp = yyss + yysize - 1;
      yyvsp = yyvs + yysize - 1;


      YYDPRINTF ((stderr, "Stack size increased to %lu\n",
		  (unsigned long int) yystacksize));

      if (yyss + yystacksize - 1 <= yyssp)
	YYABORT;
    }

  YYDPRINTF ((stderr, "Entering state %d\n", yystate));

  goto yybackup;

/*-----------.
| yybackup.  |
`-----------*/
yybackup:

  /* Do appropriate processing given the current state.  Read a
     look-ahead token if we need one and don't already have one.  */

  /* First try to decide what to do without reference to look-ahead token.  */
  yyn = yypact[yystate];
  if (yyn == YYPACT_NINF)
    goto yydefault;

  /* Not known => get a look-ahead token if don't already have one.  */

  /* YYCHAR is either YYEMPTY or YYEOF or a valid look-ahead symbol.  */
  if (yychar == YYEMPTY)
    {
      YYDPRINTF ((stderr, "Reading a token: "));
      yychar = YYLEX;
    }

  if (yychar <= YYEOF)
    {
      yychar = yytoken = YYEOF;
      YYDPRINTF ((stderr, "Now at end of input.\n"));
    }
  else
    {
      yytoken = YYTRANSLATE (yychar);
      YY_SYMBOL_PRINT ("Next token is", yytoken, &yylval, &yylloc);
    }

  /* If the proper action on seeing token YYTOKEN is to reduce or to
     detect an error, take that action.  */
  yyn += yytoken;
  if (yyn < 0 || YYLAST < yyn || yycheck[yyn] != yytoken)
    goto yydefault;
  yyn = yytable[yyn];
  if (yyn <= 0)
    {
      if (yyn == 0 || yyn == YYTABLE_NINF)
	goto yyerrlab;
      yyn = -yyn;
      goto yyreduce;
    }

  if (yyn == YYFINAL)
    YYACCEPT;

  /* Count tokens shifted since error; after three, turn off error
     status.  */
  if (yyerrstatus)
    yyerrstatus--;

  /* Shift the look-ahead token.  */
  YY_SYMBOL_PRINT ("Shifting", yytoken, &yylval, &yylloc);

  /* Discard the shifted token unless it is eof.  */
  if (yychar != YYEOF)
    yychar = YYEMPTY;

  yystate = yyn;
  *++yyvsp = yylval;

  goto yynewstate;


/*-----------------------------------------------------------.
| yydefault -- do the default action for the current state.  |
`-----------------------------------------------------------*/
yydefault:
  yyn = yydefact[yystate];
  if (yyn == 0)
    goto yyerrlab;
  goto yyreduce;


/*-----------------------------.
| yyreduce -- Do a reduction.  |
`-----------------------------*/
yyreduce:
  /* yyn is the number of a rule to reduce with.  */
  yylen = yyr2[yyn];

  /* If YYLEN is nonzero, implement the default value of the action:
     `$$ = $1'.

     Otherwise, the following line sets YYVAL to garbage.
     This behavior is undocumented and Bison
     users should not rely upon it.  Assigning to YYVAL
     unconditionally makes the parser a bit smaller, and it avoids a
     GCC warning that YYVAL may be used uninitialized.  */
  yyval = yyvsp[1-yylen];


  YY_REDUCE_PRINT (yyn);
  switch (yyn)
    {
        case 2:

    { root = (yyval.ct); }
    break;

  case 3:

    { root = (yyval.ct); }
    break;

  case 4:

    { root = (yyval.ct); }
    break;

  case 5:

    { root = (yyval.ct); }
    break;

  case 6:

    { root = (yyval.ct); }
    break;

  case 7:

    { (yyval.ct) = (yyvsp[(1) - (1)].ct); }
    break;

  case 8:

    { (yyval.ct) = (yyvsp[(1) - (3)].ct); (yyval.ct)->ct_next = (yyvsp[(3) - (3)].ct); }
    break;

  case 9:

    { (yyval.ct) = (yyvsp[(1) - (2)].ct); (yyval.ct)->ct_next = (yyvsp[(2) - (2)].ct); }
    break;

  case 10:

    { (yyval.ct) = (yyvsp[(1) - (2)].ct); (yyval.ct)->ct_next = (yyvsp[(2) - (2)].ct); }
    break;

  case 11:

    { (yyval.ct) = (yyvsp[(1) - (2)].ct); (yyval.ct)->ct_next = (yyvsp[(2) - (2)].ct); }
    break;

  case 13:

    { yywarn("\"%s\" should be quoted", (yyvsp[(1) - (1)].s)); }
    break;

  case 14:

    { (yyval.ct) = gen_argsfromstr(CTL_SYSTEM, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].i)); }
    break;

  case 15:

    { (yyval.ct) = gen_argsfromstr(CTL_SYSTEM, (yyvsp[(2) - (2)].s), 0); }
    break;

  case 16:

    { (yyval.ct) = gen_argsfromstr(CTL_XSYSTEM, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].i)); }
    break;

  case 17:

    { (yyval.ct) = gen_argsfromstr(CTL_XSYSTEM, (yyvsp[(2) - (2)].s), 0); }
    break;

  case 18:

    { (yyval.ct) = gen_argsfromstr(CTL_TSYSTEM, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].i)); }
    break;

  case 19:

    { (yyval.ct) = gen_argsfromstr(CTL_TSYSTEM, (yyvsp[(2) - (2)].s), 0); }
    break;

  case 20:

    { (yyval.ct) = gen_argsfromstr(CTL_FILTER, (yyvsp[(2) - (2)].s), 0); }
    break;

  case 21:

    { (yyval.ct) = gen_void(CTL_ENDFILTER); }
    break;

  case 22:

    { (yyval.ct) = gen_str(CTL_EMBED, (yyvsp[(2) - (2)].s)); }
    break;

  case 23:

    { (yyval.ct) = gen_void(CTL_ENDEMBED); }
    break;

  case 24:

    { (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(1) - (1)].s)); }
    break;

  case 25:

    { (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(1) - (2)].s)); (yyval.ct)->ct_next = (yyvsp[(2) - (2)].ct); }
    break;

  case 26:

    { (yyval.ct) = (yyvsp[(1) - (1)].ct); }
    break;

  case 27:

    { (yyval.ct) = (yyvsp[(1) - (2)].ct); (yyval.ct)->ct_next = (yyvsp[(2) - (2)].ct); }
    break;

  case 28:

    { (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(1) - (1)].s)); }
    break;

  case 29:

    { (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(1) - (1)].s)); }
    break;

  case 30:

    { char buf[30];
			  snprintf(buf, sizeof(buf), "%d", (yyvsp[(1) - (1)].i));
			  (yyval.ct) = gen_str(CTL_NOOP, buf);
			}
    break;

  case 31:

    { (yyval.ct) = gen_void(CTL_NOOP); }
    break;

  case 32:

    { (yyval.ct) = gen_void(CTL_LEFT); }
    break;

  case 33:

    { (yyval.ct) = gen_void(CTL_LEFTFILL); }
    break;

  case 34:

    { (yyval.ct) = gen_void(CTL_RIGHT); }
    break;

  case 35:

    { (yyval.ct) = gen_void(CTL_CENTER); }
    break;

  case 36:

    { (yyval.ct) = gen_void(CTL_SHRINK); }
    break;

  case 37:

    { (yyval.ct) = gen_void(CTL_LCUTIN); }
    break;

  case 38:

    { (yyval.ct) = gen_void(CTL_RCUTIN); }
    break;

  case 39:

    { (yyval.ct) = gen_void(CTL_CONT); }
    break;

  case 40:

    { (yyval.ct) = gen_void(CTL_NODEF); }
    break;

  case 41:

    { (yyval.ct) = gen_int(CTL_PAUSE, 0); }
    break;

  case 42:

    { (yyval.ct) = gen_void(CTL_AGAIN); }
    break;

  case 43:

    { (yyval.ct) = gen_void(CTL_MARK); }
    break;

  case 44:

    { (yyval.ct) = gen_void(CTL_PAGE); }
    break;

  case 45:

    { (yyval.ct) = gen_int3(CTL_SETSUP, (yyvsp[(2) - (4)].i), (yyvsp[(3) - (4)].i), (yyvsp[(4) - (4)].i)); }
    break;

  case 46:

    { (yyval.ct) = gen_void(CTL_SUP); }
    break;

  case 47:

    { (yyval.ct) = gen_void(CTL_SUB); }
    break;

  case 48:

    { (yyval.ct) = gen_double_int(CTL_SIZE, (yyvsp[(2) - (2)].i)); }
    break;

  case 49:

    { (yyval.ct) = gen_double(CTL_SIZE, (yyvsp[(2) - (2)].d)); }
    break;

  case 50:

    { (yyval.ct) = gen_int(CTL_HGAP, (yyvsp[(2) - (2)].i)); }
    break;

  case 51:

    { (yyval.ct) = gen_int(CTL_VGAP, (yyvsp[(2) - (2)].i)); }
    break;

  case 52:

    { (yyval.ct) = gen_int(CTL_GAP, (yyvsp[(2) - (2)].i)); }
    break;

  case 53:

    { if (!quality_flag)
				(yyval.ct) = gen_int(CTL_QUALITY, (yyvsp[(2) - (2)].i));
			  else
				(yyval.ct) = ctlalloc1(CTL_NOOP);
			}
    break;

  case 54:

    { (yyval.ct) = gen_color(CTL_FORE, (yyvsp[(2) - (2)].s)); }
    break;

  case 55:

    { (yyval.ct) = gen_color(CTL_BACK, (yyvsp[(2) - (2)].s)); }
    break;

  case 56:

    { (yyval.ct) = gen_color(CTL_CCOLOR, (yyvsp[(2) - (2)].s)); }
    break;

  case 57:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (7)].i), (yyvsp[(3) - (7)].i), (yyvsp[(4) - (7)].i), (yyvsp[(5) - (7)].i), (yyvsp[(6) - (7)].i), (yyvsp[(7) - (7)].ct)); }
    break;

  case 58:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (6)].i), (yyvsp[(3) - (6)].i), (yyvsp[(4) - (6)].i), (yyvsp[(5) - (6)].i), (yyvsp[(6) - (6)].i),
				(struct ctrl *)NULL);
			}
    break;

  case 59:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (5)].i), (yyvsp[(3) - (5)].i), (yyvsp[(4) - (5)].i), (yyvsp[(5) - (5)].i), 1,
				(struct ctrl *)NULL);
			}
    break;

  case 60:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (4)].i), (yyvsp[(3) - (4)].i), (yyvsp[(4) - (4)].i), 0, 1,
				(struct ctrl *)NULL);
			}
    break;

  case 61:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (3)].i), (yyvsp[(3) - (3)].i), DEFAULT_GRADCOLORS, 0, 1,
					(struct ctrl *)NULL);
			}
    break;

  case 62:

    { (yyval.ct) = gen_bgrad((yyvsp[(2) - (2)].i), 100, DEFAULT_GRADCOLORS, 0, 1,
					(struct ctrl *)NULL);
			}
    break;

  case 63:

    { (yyval.ct) = gen_bgrad(100, 100, DEFAULT_GRADCOLORS, 0, 1,
					(struct ctrl *)NULL);
			}
    break;

  case 64:

    { char *p;
			  if (strncmp((yyvsp[(2) - (2)].s), "medium", 6) == 0
			   || strncmp((yyvsp[(2) - (2)].s), "bold", 4) == 0) {
				/* for backward compatibility */
				p = malloc(strlen((yyvsp[(2) - (2)].s)) + 1 + 6);
				sprintf(p, "times-%s", (yyvsp[(2) - (2)].s));
			  } else
				p = (yyvsp[(2) - (2)].s);
			  check_xfont(p, "iso8859-1"); /* lexical check */
			  (yyval.ct) = gen_str2(CTL_XFONT2, p, "iso8859-1");
			}
    break;

  case 65:

    { check_xfont((yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));	/* lexical check */
			  (yyval.ct) = gen_str2(CTL_XFONT2, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));
			}
    break;

  case 66:

    { (yyval.ct) = gen_image(CTL_BIMAGE, (yyvsp[(2) - (2)].s), 0, 0, 0, 0); }
    break;

  case 67:

    { int x, y;
			  x = atoi((yyvsp[(3) - (3)].s)); y = atoi(strchr((yyvsp[(3) - (3)].s), 'x') + 1);
			  (yyval.ct) = gen_image(CTL_BIMAGE, (yyvsp[(2) - (3)].s), 0, x, y, 2);
			}
    break;

  case 68:

    {
#ifdef VFLIB
				  (yyval.ct) = gen_str(CTL_VFONT, (yyvsp[(2) - (2)].s));
#else
				  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
				  yywarn("directive \"vfont\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 69:

    {
					(yyval.ct) = gen_str2(CTL_PSFONT, (yyvsp[(2) - (2)].s), "iso8859-1");
				}
    break;

  case 70:

    {
#ifdef FREETYPE
				  (yyval.ct) = gen_str2(CTL_TFONT, (yyvsp[(2) - (2)].s), "iso8859-1");
#else
				  (yyval.ct) = gen_str2(CTL_NOOP, (yyvsp[(2) - (2)].s), "iso8859-1");
				  yywarn("directive \"tfont\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 71:

    {
#ifdef FREETYPE
				  (yyval.ct) = gen_str2(CTL_TFONT, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));
#else
				  (yyval.ct) = gen_str2(CTL_NOOP, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));
				  yywarn("directive \"tfont\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 72:

    {
#ifdef FREETYPE
				  (yyval.ct) = gen_str(CTL_TMFONT, (yyvsp[(2) - (2)].s));
#else
				  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
				  yywarn("directive \"tmfont\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 73:

    {
#ifdef FREETYPE
				  (yyval.ct) = gen_str(CTL_TFONT0, (yyvsp[(2) - (2)].s));
#else
				  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
				  yywarn("directive \"tfont0\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 74:

    {
#ifdef FREETYPE_CHARSET16
				  (yyval.ct) = gen_str(CTL_TMFONT0, (yyvsp[(2) - (2)].s));
#else
				  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
				  yywarn("directive \"tmfont0\" not supported "
					"in this configuration");
#endif
				}
    break;

  case 75:

    { (yyval.ct) = gen_str(CTL_INCLUDE, (yyvsp[(2) - (2)].s)); }
    break;

  case 76:

    { char *p;
			  (yyval.ct) = gen_str(CTL_PREFIX, (yyvsp[(2) - (2)].s));
			  for (p = (yyval.ct)->ctc_value; *p; p++) {
				if (*p == '_') *p = ' ';
			  }
			}
    break;

  case 77:

    { (yyval.ct) = gen_str(CTL_PREFIX, (yyvsp[(2) - (2)].s)); }
    break;

  case 78:

    { (yyval.ct) = gen_double_int(CTL_PREFIXN, (yyvsp[(2) - (2)].i)); }
    break;

  case 79:

    { (yyval.ct) = gen_double(CTL_PREFIXN, (yyvsp[(2) - (2)].d)); }
    break;

  case 80:

    { (yyval.ct) = gen_newimage((yyvsp[(2) - (2)].ct)); }
    break;

  case 81:

    { int x, y;
			  x = atoi((yyvsp[(3) - (3)].s)); y = atoi(strchr((yyvsp[(3) - (3)].s), 'x') + 1);
			  (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (3)].s), 0, x, y, 2);
			}
    break;

  case 82:

    { int x, y;
			  x = atoi((yyvsp[(4) - (4)].s)); y = atoi(strchr((yyvsp[(4) - (4)].s), 'x') + 1);
			  (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (4)].s), (yyvsp[(3) - (4)].i), x, y, 2);
			}
    break;

  case 83:

    { (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (6)].s), (yyvsp[(3) - (6)].i), (yyvsp[(4) - (6)].i), (yyvsp[(5) - (6)].i), (yyvsp[(6) - (6)].i) ? 1 : 0); }
    break;

  case 84:

    { (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (5)].s), (yyvsp[(3) - (5)].i), (yyvsp[(4) - (5)].i), (yyvsp[(5) - (5)].i), 0); }
    break;

  case 85:

    { (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (4)].s), (yyvsp[(3) - (4)].i), (yyvsp[(4) - (4)].i), 0, 0); }
    break;

  case 86:

    { (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].i), 0, 0, 0); }
    break;

  case 87:

    { (yyval.ct) = gen_image(CTL_IMAGE, (yyvsp[(2) - (2)].s), 0, 0, 0, 0); }
    break;

  case 88:

    { (yyval.ct) = gen_bar((yyvsp[(2) - (5)].s), (yyvsp[(3) - (5)].i), (yyvsp[(4) - (5)].i), (yyvsp[(5) - (5)].i)); }
    break;

  case 89:

    { (yyval.ct) = gen_bar((yyvsp[(2) - (4)].s), (yyvsp[(3) - (4)].i), (yyvsp[(4) - (4)].i), 100); }
    break;

  case 90:

    { (yyval.ct) = gen_bar((yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].i), 0, 100); }
    break;

  case 91:

    { (yyval.ct) = gen_bar((yyvsp[(2) - (2)].s), 10, 0, 100); }
    break;

  case 92:

    { (yyval.ct) = gen_bar("black", 10, 0, 100); }
    break;

  case 93:

    { (yyval.ct) = gen_icon((yyvsp[(2) - (4)].s), (yyvsp[(3) - (4)].s), (yyvsp[(4) - (4)].i)); }
    break;

  case 94:

    { (yyval.ct) = gen_icon((yyvsp[(2) - (4)].s), (yyvsp[(3) - (4)].s), (yyvsp[(4) - (4)].i)); }
    break;

  case 95:

    {
#ifdef VFLIB
			  (yyval.ct) = gen_str(CTL_VFCAP, (yyvsp[(2) - (2)].s));
#else
			  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
			  yywarn("directive \"vfcap\" not supported "
				"in this configuration");
#endif
			}
    break;

  case 96:

    {
#ifdef FREETYPE
			  (yyval.ct) = gen_str(CTL_TFDIR, (yyvsp[(2) - (2)].s));
#else
			  (yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
			  yywarn("directive \"tfdir\" not supported "
				"in this configuration");
#endif
			}
    break;

  case 97:

    { (yyval.ct) = gen_str(CTL_FONT, (yyvsp[(2) - (2)].s)); }
    break;

  case 98:

    { (yyval.ct) = gen_str(CTL_TEXT, (yyvsp[(2) - (2)].s)); }
    break;

  case 99:

    { (yyval.ct) = gen_str(CTL_CHARSET, (yyvsp[(2) - (2)].s)); }
    break;

  case 100:

    { (yyval.ct) = gen_area((yyvsp[(2) - (3)].i), (yyvsp[(3) - (3)].i), -1, -1); }
    break;

  case 101:

    { (yyval.ct) = gen_area((yyvsp[(2) - (5)].i), (yyvsp[(3) - (5)].i), (yyvsp[(4) - (5)].i), (yyvsp[(5) - (5)].i)); }
    break;

  case 102:

    { (yyval.ct) = gen_pcache((yyvsp[(2) - (5)].i), (yyvsp[(3) - (5)].i), (yyvsp[(4) - (5)].i), (yyvsp[(5) - (5)].i)); }
    break;

  case 103:

    { (yyval.ct) = gen_pcache((yyvsp[(2) - (2)].i), 0, 0, 0); }
    break;

  case 104:

    {
#ifdef MNG
			(yyval.ct) = gen_str(CTL_ANIM, (yyvsp[(2) - (2)].s));
			chkfile((yyvsp[(2) - (2)].s));
#else
			(yyval.ct) = gen_str(CTL_NOOP, (yyvsp[(2) - (2)].s));
			yywarn("directive \"anim\" not supported "
					"in this configuration");
#endif
	}
    break;

  case 105:

    {
#ifdef USE_M17N
			(yyval.ct) = gen_str2(CTL_M17N, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));
#else
			(yyval.ct) = gen_str2(CTL_NOOP, (yyvsp[(2) - (3)].s), (yyvsp[(3) - (3)].s));
			yywarn("directive \"m17n\" not supported "
					"in this configuration");
#endif
	}
    break;

  case 106:

    {
			(yyval.ct) = gen_valign((yyvsp[(2) - (2)].s));
	}
    break;

  case 107:

    { (yyval.ct) = gen_int(CTL_OPAQUE, (yyvsp[(2) - (2)].i)); }
    break;

  case 108:

    { (yyval.ct) = gen_int(CTL_TAB, (yyvsp[(2) - (2)].i)); }
    break;

  case 109:

    { (yyval.ct) = gen_str(CTL_TAB, (yyvsp[(2) - (2)].s)); }
    break;

  case 110:

    { (yyval.ct) = gen_int(CTL_DEFAULT, (yyvsp[(2) - (2)].i)); }
    break;

  case 111:

    { (yyval.ct) = gen_str(CTL_DEFFONT, (yyvsp[(2) - (2)].s)); }
    break;


/* Line 1267 of yacc.c.  */

      default: break;
    }
  YY_SYMBOL_PRINT ("-> $$ =", yyr1[yyn], &yyval, &yyloc);

  YYPOPSTACK (yylen);
  yylen = 0;
  YY_STACK_PRINT (yyss, yyssp);

  *++yyvsp = yyval;


  /* Now `shift' the result of the reduction.  Determine what state
     that goes to, based on the state we popped back to and the rule
     number reduced by.  */

  yyn = yyr1[yyn];

  yystate = yypgoto[yyn - YYNTOKENS] + *yyssp;
  if (0 <= yystate && yystate <= YYLAST && yycheck[yystate] == *yyssp)
    yystate = yytable[yystate];
  else
    yystate = yydefgoto[yyn - YYNTOKENS];

  goto yynewstate;


/*------------------------------------.
| yyerrlab -- here on detecting error |
`------------------------------------*/
yyerrlab:
  /* If not already recovering from an error, report this error.  */
  if (!yyerrstatus)
    {
      ++yynerrs;
#if ! YYERROR_VERBOSE
      yyerror (YY_("syntax error"));
#else
      {
	YYSIZE_T yysize = yysyntax_error (0, yystate, yychar);
	if (yymsg_alloc < yysize && yymsg_alloc < YYSTACK_ALLOC_MAXIMUM)
	  {
	    YYSIZE_T yyalloc = 2 * yysize;
	    if (! (yysize <= yyalloc && yyalloc <= YYSTACK_ALLOC_MAXIMUM))
	      yyalloc = YYSTACK_ALLOC_MAXIMUM;
	    if (yymsg != yymsgbuf)
	      YYSTACK_FREE (yymsg);
	    yymsg = (char *) YYSTACK_ALLOC (yyalloc);
	    if (yymsg)
	      yymsg_alloc = yyalloc;
	    else
	      {
		yymsg = yymsgbuf;
		yymsg_alloc = sizeof yymsgbuf;
	      }
	  }

	if (0 < yysize && yysize <= yymsg_alloc)
	  {
	    (void) yysyntax_error (yymsg, yystate, yychar);
	    yyerror (yymsg);
	  }
	else
	  {
	    yyerror (YY_("syntax error"));
	    if (yysize != 0)
	      goto yyexhaustedlab;
	  }
      }
#endif
    }



  if (yyerrstatus == 3)
    {
      /* If just tried and failed to reuse look-ahead token after an
	 error, discard it.  */

      if (yychar <= YYEOF)
	{
	  /* Return failure if at end of input.  */
	  if (yychar == YYEOF)
	    YYABORT;
	}
      else
	{
	  yydestruct ("Error: discarding",
		      yytoken, &yylval);
	  yychar = YYEMPTY;
	}
    }

  /* Else will try to reuse look-ahead token after shifting the error
     token.  */
  goto yyerrlab1;


/*---------------------------------------------------.
| yyerrorlab -- error raised explicitly by YYERROR.  |
`---------------------------------------------------*/
yyerrorlab:

  /* Pacify compilers like GCC when the user code never invokes
     YYERROR and the label yyerrorlab therefore never appears in user
     code.  */
  if (/*CONSTCOND*/ 0)
     goto yyerrorlab;

  /* Do not reclaim the symbols of the rule which action triggered
     this YYERROR.  */
  YYPOPSTACK (yylen);
  yylen = 0;
  YY_STACK_PRINT (yyss, yyssp);
  yystate = *yyssp;
  goto yyerrlab1;


/*-------------------------------------------------------------.
| yyerrlab1 -- common code for both syntax error and YYERROR.  |
`-------------------------------------------------------------*/
yyerrlab1:
  yyerrstatus = 3;	/* Each real token shifted decrements this.  */

  for (;;)
    {
      yyn = yypact[yystate];
      if (yyn != YYPACT_NINF)
	{
	  yyn += YYTERROR;
	  if (0 <= yyn && yyn <= YYLAST && yycheck[yyn] == YYTERROR)
	    {
	      yyn = yytable[yyn];
	      if (0 < yyn)
		break;
	    }
	}

      /* Pop the current state because it cannot handle the error token.  */
      if (yyssp == yyss)
	YYABORT;


      yydestruct ("Error: popping",
		  yystos[yystate], yyvsp);
      YYPOPSTACK (1);
      yystate = *yyssp;
      YY_STACK_PRINT (yyss, yyssp);
    }

  if (yyn == YYFINAL)
    YYACCEPT;

  *++yyvsp = yylval;


  /* Shift the error token.  */
  YY_SYMBOL_PRINT ("Shifting", yystos[yyn], yyvsp, yylsp);

  yystate = yyn;
  goto yynewstate;


/*-------------------------------------.
| yyacceptlab -- YYACCEPT comes here.  |
`-------------------------------------*/
yyacceptlab:
  yyresult = 0;
  goto yyreturn;

/*-----------------------------------.
| yyabortlab -- YYABORT comes here.  |
`-----------------------------------*/
yyabortlab:
  yyresult = 1;
  goto yyreturn;

#ifndef yyoverflow
/*-------------------------------------------------.
| yyexhaustedlab -- memory exhaustion comes here.  |
`-------------------------------------------------*/
yyexhaustedlab:
  yyerror (YY_("memory exhausted"));
  yyresult = 2;
  /* Fall through.  */
#endif

yyreturn:
  if (yychar != YYEOF && yychar != YYEMPTY)
     yydestruct ("Cleanup: discarding lookahead",
		 yytoken, &yylval);
  /* Do not reclaim the symbols of the rule which action triggered
     this YYABORT or YYACCEPT.  */
  YYPOPSTACK (yylen);
  YY_STACK_PRINT (yyss, yyssp);
  while (yyssp != yyss)
    {
      yydestruct ("Cleanup: popping",
		  yystos[*yyssp], yyvsp);
      YYPOPSTACK (1);
    }
#ifndef yyoverflow
  if (yyss != yyssa)
    YYSTACK_FREE (yyss);
#endif
#if YYERROR_VERBOSE
  if (yymsg != yymsgbuf)
    YYSTACK_FREE (yymsg);
#endif
  /* Make sure YYID is used.  */
  return YYID (yyresult);
}





