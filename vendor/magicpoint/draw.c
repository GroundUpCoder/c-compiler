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
 * $Id: draw.c,v 1.245 2008/01/24 15:43:17 nishida Exp $
 */

#include "mgp.h"
#ifdef USE_IMLIB
#include <Imlib.h>
#endif

/* state associated with the window - how should we treat this? */
static struct ctrl *bg_ctl, *bg_ctl_last, *bg_ctl_cache;
static int bgindex = 0;
struct render_state cache_state;

static u_short kinsokutable[] = {
	0x2121, 0x2122, 0x2123, 0x2124, 0x2125, 0x2126, 0x2127, 0x2128,
	0x2129, 0x212a, 0x212b, 0x212c, 0x212d, 0x212e, 0x212f, 0x2130,
	0x2133, 0x2134, 0x2135, 0x2136, 0x213c, 0x2147, 0x2149, 0x214b,
	0x214d, 0x214f, 0x2151, 0x2153, 0x2155, 0x2157, 0x2159, 0x216b,
	0x2242, 0x2244, 0
};

static struct pcache {
	u_int flag;
	u_int page;
	u_int mgpflag;
	u_int mode;
	u_int effect;
	u_int value;
} pcache;

#define	COMPLEX_BGIMAGE \
    (bg_ctl		\
     && ((bg_ctl->ct_op == CTL_BIMAGE)	\
       || bg_ctl->ct_op == CTL_BGRAD))

#define	COMPLEX_BGIMAGE2 (0)

#define	POSY(size)	(-(int)((size)/2))

static void process_direc __P((struct render_state *, int *));

static int set_position __P((struct render_state *));
static void draw_line_output __P((struct render_state *, char *));
static void cutin __P((struct render_state *, int, int, int));
#if 0
static void shrink __P((char *, u_int));
#endif

static void draw_string __P((struct render_state *, char *));
static char *draw_fragment __P((struct render_state *, u_char *, u_int, char *, int));
static int iskinsokuchar __P((u_int));
static struct render_object *obj_alloc __P((struct render_state *state));
static void obj_free __P((struct render_state *, struct render_object *));
static int obj_new_xfont __P((struct render_state *, int, int, int,
	u_int, char *));
static int obj_new_image __P((struct render_state *, int, int, Image *, int, int));
#ifdef USE_IMLIB
ImlibImage *search_imdata __P((char *));
static int obj_new_image2 __P((struct render_state *, int, int, Image *, int, int, ImlibImage *, int));
#endif
static int obj_new_icon __P((struct render_state *, int, int, u_int, u_int, u_long, u_int, XPoint *));
static Pixel obj_image_color __P((Image *, Image *, Pixel, int *));
static Image *obj_image_trans __P((Image *, u_int, u_int));
static void obj_draw_image __P((Drawable, u_int, u_int, struct render_object *, int));
static void obj_draw __P((struct render_state *, Drawable, u_int, u_int));
#ifdef VFLIB
static int obj_new_vfont __P((struct render_state *, int, int, struct vfont *,
	int));
static u_int draw_onechar_vf __P((struct render_state *, u_int, int, int, u_int, u_int));
#endif
#ifdef FREETYPE
static u_int draw_onechar_tf __P((struct render_state *, u_int, int, int,
	u_int, char *, int, int));
#endif
static XFontStruct *x_setfont __P((char *, u_int, char *, int *));
static u_int draw_onechar_x __P((struct render_state *, u_int, int, int, int,
	char *, int));

static void back_gradation __P((struct render_state *, struct ctrl_grad *));
#if 1  /* by h.kakugawa@computer.org */
static void image_load __P((struct render_state *, char *, int, int, int, int, int, int, int, int, int));
static void image_load_ps __P((struct render_state *, char *, int, int, int, int, int, int, int, int, int));
#else
static void image_load __P((struct render_state *, char *, int, int, int, int, int, int));
static void image_load_ps __P((struct render_state *, char *, int, int, int, int, int, int));
#endif
static void process_icon __P((struct render_state *, struct ctrl *));
static void draw_bar __P((struct render_state *, struct ctrl *));
static void process_system __P((struct render_state *, struct ctrl *));
static void process_xsystem __P((struct render_state *, struct ctrl *));
static void process_tsystem __P((struct render_state *, struct ctrl *));
static void image_setcolor __P((struct render_state *));
static void x_registerseed __P((struct render_state *, char *, char *));
static char *x_findseed __P((struct render_state *, char *));

static void XClearPixmap __P((Display *, Drawable));
static void cache_page __P((struct render_state *, int));
static void cache_effect1 __P((void));
static void cache_effect2 __P((void));
static void set_from_cache __P((struct render_state *));
static void pcache_process __P((int));
static void predraw __P((struct render_state *));
static void set_background_pixmap __P((struct ctrl *));
static void get_background_pixmap __P((struct ctrl *, struct render_state *));
static void regist_background_pixmap __P((XImageInfo *, Image *));
#ifdef MNG
static void process_anim __P((struct render_state *, struct ctrl *));
static void obj_draw_anim __P((struct render_state *, 
	u_int, u_int, struct render_object *));
#endif
static int valign = VL_BOTTOM;

#define CHECK_CACHE	do {if (caching) {caching = -1; return; }} while (0)

#ifdef USE_XFT2
static void set_xrender_color  __P((long, int));
static XftDraw * xft_getdraw __P((Drawable)); 
static char *xft_draw_fragment __P((struct render_state *, 
						u_char *, u_int, char *, int));
static int obj_new_xftfont __P((struct render_state *, int, int, char *, 
						int, char *, char *, int, int, XftFont *));
static XftFont * xft_setfont __P((char *, int, char *));
XftFont *xft_font;
XftDraw *xft_draw[2];
Drawable xft_xdraw[2];
XftColor xft_forecolor;
XRenderColor xft_render_color;
#endif

#ifdef USE_IMLIB
static void regist_zimage_position __P((struct render_object *, int, int, int, int, int));
static void clear_zimage __P((int));
static void clear_region __P((int, int, int, int));
#define ZIMAGENUM 100
static ImlibImage *zimage[ZIMAGENUM];
static int zonzoom[ZIMAGENUM];
static int zpage[ZIMAGENUM];
static int zx[ZIMAGENUM];
static int zx[ZIMAGENUM];
static int zy[ZIMAGENUM];
static int zwidth[ZIMAGENUM];
static int zheight[ZIMAGENUM];
#endif
extern int zoomin;

static int
ispsfilename(p0)
	char *p0;
{
	char *p;

	p = p0;
	while (*p)
		p++;
	if (4 < p - p0 && strcasecmp(p - 4, ".eps") == 0)
		return 1;
	if (3 < p - p0 && strcasecmp(p - 3, ".ps") == 0)
		return 1;
	if (6 < p - p0 && strcasecmp(p - 6, ".idraw") == 0)
		return 1;
	return 0;
}

/*
 * state management.
 */
void
state_goto(state, page, repaint)
	struct render_state *state;
	u_int page;
	int repaint;
{
	if (!repaint) {
		purgechild(state->page);
#ifdef USE_IMLIB
		clear_zimage(state->page);
#endif
	}

	state->page = page;
	state->line = 0;
	state->cp = NULL;
	state->phase = P_NONE;
	free_alloc_colors(&image_clr);
	free_alloc_colors(&font_clr);

#ifdef COLOR_BUGFIX
	colormap = XCopyColormapAndFree(display, colormap);
#endif
	predraw(state);
}

void
state_next(state)
	struct render_state *state;
{

	switch (state->phase) {
	case P_NONE:
		fprintf(stderr, "internal error\n");
		break;
	case P_DEFAULT:
		if (state->cp)
			state->cp = state->cp->ct_next;
		if (!state->cp) {
			state->cp = page_control[state->page][state->line];
			state->phase = P_PAGE;
		}
		break;
	case P_PAGE:
		if (state->cp)
			state->cp = state->cp->ct_next;
		if (!state->cp) {
			state->line++;
			state->cp = NULL;
			state->phase = P_NONE;
			state_init(state);
		}
		break;

	case P_END:
		/*nothing*/
		break;
	}

	/* next page */
	if (page_attribute[state->page].pg_linenum < state->line) {
		if (state->page < maxpage) {
			purgechild(state->page);
#ifdef USE_IMLIB
			clear_zimage(state->page);
#endif
			if (mgp_flag & FL_FRDCACHE &&
				cached_page == state->page + 1) {
					/* Hit cache */
					set_from_cache(state);
					pcache_process(state->page);
					cache_hit = 1;
			} else {
				state->phase = P_NONE;
				state->page++;
				state->line = 0;
				state_newpage(state);
				state_init(state);
			}
		} else
			state->phase = P_END;
	}
}

void
state_init(state)
	struct render_state *state;
{
	assert(state);

	if (state->phase == P_NONE || !state->cp) {
#if 0
		if (!(page_attribute[state->page].pg_flag & PGFLAG_NODEF)) {
			state->cp = default_control[state->line];
			state->phase = P_DEFAULT;
		} else
#endif
		{
			state->cp = page_control[state->page][state->line];
			state->phase = P_PAGE;
		}
	}
}

void
state_newpage(state)
	struct render_state *state;
{
	state->ypos = 0;
	state->have_mark = 0;
	state->charoff = 0;
	char_size[caching] = nonscaled_size[caching];   
	free_alloc_colors(&image_clr);
	free_alloc_colors(&font_clr);

#ifdef COLOR_BUGFIX
	colormap = XCopyColormapAndFree(display, colormap);
#endif
	predraw(state);
}

/*
 * page management.
 */
void
draw_page(state, lastcp)
	struct render_state *state;
	struct ctrl *lastcp;
{
	u_int end_line;
	int pause;

	assert(state);

	/* initialize the state, if required. */
	if (state->phase != P_END && (state->phase == P_NONE || !state->cp)) {
		state_newpage(state);
		state_init(state);
	}

	end_line = page_attribute[state->page].pg_linenum;

	while (1) {
		switch (state->phase) {
		case P_NONE:
			fprintf(stderr, "internal error\n");
			cleanup(-1);
		case P_DEFAULT:
		case P_PAGE:
			pause = 0;
			if (state->cp)
				process_direc(state, &pause);
			if (caching == -1) {
				/* caching failed */
				caching = 0;
				return;
			}
			if (lastcp && state->cp == lastcp)
				goto done;
			if (pause) {
				if (state->cp
				 && state->cp->ct_op == CTL_PAUSE
				 && state->cp->cti_value) {
					goto done;
				}
			}
			break;
		case P_END:
			goto done;
		}
#if 0
		XFlush(display);
#endif
		state_next(state);
	}
done:
	XFlush(display);
}

Bool
draw_one(state, e)
	struct render_state *state;
	XEvent *e;
{
	u_int end_line;
	int pause;
	long emask;

	assert(state);

	/* initialize the state, if required. */
	if (state->phase != P_END && (state->phase == P_NONE || !state->cp)) {
		state_newpage(state);
		state_init(state);
	}

	end_line = page_attribute[state->page].pg_linenum;

	switch (state->phase) {
	case P_DEFAULT:
	case P_PAGE:
		pause = 0;
		if (state->cp)
			process_direc(state, &pause);
		break;
	case P_END:
		break;
	case P_NONE:
	default:
		fprintf(stderr, "internal error\n");
		cleanup(-1);
	}
	/* gucOS port (todos/0119): never block — the frame loop owns
	 * waiting. Upstream select()ed on the X fd here with a 2s timeout;
	 * we return 2 ("would block") and frame_loop yields the frame. */
	if (state->phase != P_END && !pause)
		emask = xeventmask;
	else
		emask = ~NoEventMask;
	if (XCheckMaskEvent(display, emask, e) == True) {
		if (state->phase == P_END)
			XFlush(display);
		else if (!pause)
			state_next(state);
		return True;
	}
	if (state->phase != P_END && !pause) {
		state_next(state);
		return False;
	}
	/* page settled (pause or end): present, forward-cache, yield */
	XFlush(display);
	if (mgp_flag & FL_FRDCACHE)
		cache_page(&cache_state, state->page + 1);
	return 2;
}

static void
process_direc(state, seenpause)
	struct render_state *state;
	int *seenpause;
{
	struct ctrl *cp;

	if (seenpause)
		*seenpause = 0;
	cp = state->cp;

	if (2 <= parse_debug) {
		fprintf(stderr, "p%d/l%d: ", state->page, state->line);
		debug0(cp);
	}

	switch(cp->ct_op) {
	case CTL_SUP:
		if (sup_scale > 1.0 || sup_scale < 0.1) {
			sup_scale = DEFAULT_SUPSCALE;
		}
		if (sup_off > 1.0 || sup_scale < 0.1) {
			sup_off = DEFAULT_SUPOFF;
		}
		state->charoff = -sup_off * nonscaled_size[caching];	   
		char_size[caching] = (int)(nonscaled_size[caching] * sup_scale);
		break;
	case CTL_SUB:
		if (sup_scale > 1.0 || sup_scale < 0.1) {
			sup_scale = DEFAULT_SUPSCALE;
		}
		if (sub_off > 1.0 || sub_off < 0.1){
			sub_off = DEFAULT_SUBOFF;
		}
		state->charoff = sub_off * nonscaled_size[caching];
		char_size[caching] = (int)(nonscaled_size[caching] * sup_scale);
		break;
	case CTL_SETSUP:
		if (cp->cti3_value1 > 100 || cp->cti3_value1 < 10){
			sup_off = DEFAULT_SUPOFF;
		} else {
			sup_off = cp->cti3_value1 / 100.;
		}
		if (cp->cti3_value2 > 100 || cp->cti3_value2 < 10){
			sub_off = DEFAULT_SUBOFF;
		} else {
			sub_off = cp->cti3_value2 / 100.;
		}
		if (cp->cti3_value3 > 100 || cp->cti3_value3 < 10){
		     sup_scale = DEFAULT_SUPSCALE;
		} else {
		     sup_scale = cp->cti3_value3 / 100.;
		}
		break;
	case CTL_SIZE:
		nonscaled_size[caching] = state->height * cp->ctf_value / 100;
		char_size[caching] = nonscaled_size[caching];
#ifdef FREETYPE
		tfc_setsize(char_size[caching]);
#endif
		break;

	case CTL_VGAP:
		vert_gap[caching] = cp->cti_value;
		break;

	case CTL_HGAP:
		horiz_gap[caching] = cp->cti_value;
		break;

	case CTL_GAP:
		vert_gap[caching] = horiz_gap[caching] = cp->cti_value;
		break;

	case CTL_QUALITY:
		if (!quality_flag)
			b_quality[caching] = cp->cti_value;
		break;

	case CTL_PAUSE:
		CHECK_CACHE;
		if (seenpause)
			*seenpause = 1;
		break;

	case CTL_AGAIN:
		CHECK_CACHE;
		if (state->have_mark)
			state->ypos = state->mark_ypos;
		state->have_mark = 0;
		break;

	case CTL_FORE:
		fore_color[caching] = cp->ctl_value;
#ifdef USE_M17N
		if (! (mgp_flag & FL_NOM17N))
		  {
		    M17N_set_color (cp->ctl_value);
		    break;
		  }
#endif
		XSetForeground(display, gcfore, fore_color[caching]);
		break;

	case CTL_BACK:
		if (state->line){
			fprintf(stderr, "warning: %%back directive should be put in the first line of the page. ignored.\n");
			break;
		}
		back_color[caching] = cp->ctl_value;
		bg_ctl = cp;	/*update later*/
		break;

	case CTL_CCOLOR:
		ctrl_color[caching] = cp->ctl_value;
		break;

	case CTL_CENTER:
		state->align = AL_CENTER;
		break;

	case CTL_LEFT:
		state->align = AL_LEFT;
		break;

	case CTL_LEFTFILL:
		state->align = AL_LEFTFILL0;
		break;

	case CTL_RIGHT:
		state->align = AL_RIGHT;
		break;

	case CTL_CONT:
		state->charoff = 0;
		char_size[caching] = nonscaled_size[caching];
		break;

#ifdef VFLIB
	case CTL_VFONT:
		vfc_setfont(cp->ctc_value);
		break;
#endif /*VFLIB*/

#ifdef FREETYPE
	case CTL_TFONT:
		tfc_setfont(cp->ctc2_value1, 0, cp->ctc2_value2);
		break;

	case CTL_TMFONT:
		tfc_setfont(cp->ctc_value, 1, NULL);
		break;

#endif /*FREETYPE*/

	case CTL_XFONT2:
#ifdef USE_M17N
		if (! (mgp_flag & FL_NOM17N))
		  {
		    M17N_set_font (cp->ctc2_value1, cp->ctc2_value2);
		    break;
		  }
#endif
		x_registerseed(state, cp->ctc2_value1, cp->ctc2_value2);
		break;

	case CTL_BAR:
		draw_bar(state, cp);
		break;

	case CTL_IMAGE:
	    {
		if (state->align == AL_LEFTFILL0) {
			state->align = AL_LEFTFILL1;
			state->leftfillpos = state->linewidth;
		}

		/* quickhack for postscript */
		if (ispsfilename(cp->ctm_fname)) {
#if 1  /* by h.kakugawa@computer.org */
			image_load_ps(state, cp->ctm_fname, cp->ctm_numcolor,
				cp->ctm_ximagesize, cp->ctm_yimagesize, 0,
				cp->ctm_zoomflag, 0, cp->ctm_raise, cp->ctm_rotate, cp->ctm_zoomonclk);
#else
			image_load_ps(state, cp->ctm_fname, cp->ctm_numcolor,
				cp->ctm_ximagesize, cp->ctm_yimagesize, 0,
				cp->ctm_zoomflag, 0);
#endif
		} else {
#if 1  /* by h.kakugawa@computer.org */
			image_load(state, cp->ctm_fname, cp->ctm_numcolor,
				cp->ctm_ximagesize, cp->ctm_yimagesize, 0,
				cp->ctm_zoomflag, 0, cp->ctm_raise, cp->ctm_rotate, cp->ctm_zoomonclk);
#else
			image_load(state, cp->ctm_fname, cp->ctm_numcolor,
				cp->ctm_ximagesize, cp->ctm_yimagesize, 0,
				cp->ctm_zoomflag, 0);
#endif
		}
		state->brankline = 0;
	    }
		break;

	case CTL_BIMAGE:
		if (mgp_flag & FL_BIMAGE)
			break;
		bg_ctl = cp;	/*update later*/
		break;

	case CTL_BGRAD:
		if (mgp_flag & FL_BIMAGE)
			break;
		bg_ctl = cp;	/*update later*/
		break;

	case CTL_LCUTIN:
		CHECK_CACHE;
		state->special = SP_LCUTIN;
		break;

	case CTL_RCUTIN:
		CHECK_CACHE;
		state->special = SP_RCUTIN;
		break;

	case CTL_SHRINK:
		CHECK_CACHE;
		state->special = SP_SHRINK;
		break;

	case CTL_PREFIX:
		state->curprefix = cp->ctc_value;
		break;

	case CTL_PREFIXN:
		state->xprefix = state->width * cp->ctf_value / 100;
		break;

	case CTL_TABPREFIX:
		state->tabprefix = cp->ctc_value;
		break;

	case CTL_TABPREFIXN:
		state->tabxprefix = state->width * cp->ctf_value / 100;
		break;

	case CTL_PREFIXPOS:
	    {
		char *p;

		p = (state->tabprefix) ? state->tabprefix : state->curprefix;
		if (!p)
			break;
#ifdef USE_M17N
		if (! (mgp_flag & FL_NOM17N))
		  {
		    cp->ct_op = CTL_TEXT;
		    cp->ctc_value = p;
		    M17N_draw_string (state, cp);
		    break;
		  }
#endif
		draw_line_output(state, p);
		break;
	    }

	case CTL_TEXT:
		if (!cp->ctc_value)
			break;
		if (state->align == AL_LEFTFILL0) {
			state->align = AL_LEFTFILL1;
			state->leftfillpos = state->linewidth;
		}
#ifdef USE_M17N
		if (! (mgp_flag & FL_NOM17N))
		  {
		    M17N_draw_string (state, cp);
		    break;
		  }
#endif
		draw_line_output(state, cp->ctc_value);
		break;

	case CTL_LINESTART:
		state->charoff = 0;
		char_size[caching] = nonscaled_size[caching];
		if (state->line == 0) {
			/*
			 * set background of target 
			 */
			if (bg_ctl) {
				if (!caching){
					/* target is window, so we need care bg_ctl_last */
					if (bg_ctl_last && !ctlcmp(bg_ctl, bg_ctl_last)){
						/* same as last time, we do nothing  */
						;
					} else {
						/* we have to change background */
						get_background_pixmap(bg_ctl, state);

						/* set window background */
						set_background_pixmap(bg_ctl);

						bg_ctl_last = bg_ctl;
					}
					XClearWindow(display, state->target);
				} else {
					get_background_pixmap(bg_ctl, state);
					bg_ctl_cache = bg_ctl;

					XClearPixmap(display, state->target);
				}
			} else {
				if (!caching)
					XClearWindow(display, state->target);
				else
					XClearPixmap(display, state->target);
			}

			if (t_fin)
				timebar(state);
		}
		draw_line_start(state);
		break;

	case CTL_LINEEND:
		/* blank lines */
		if (state->brankline) {	/*XXX*/
			state->max_lineascent = char_size[caching];
			state->maxascent = char_size[caching];
			state->maxdescent = VERT_GAP(char_size[caching]);
		}
		draw_line_end(state);
		/* reset single-line oriented state */
		state->tabprefix = NULL;
		state->tabxprefix = 0;
		state->special = 0;
		if (state->align == AL_LEFTFILL1) {
			state->align = AL_LEFTFILL0;
			state->leftfillpos = 0;
		}
		break;

	case CTL_MARK:
		state->have_mark = 1;
		state->mark_ypos = state->ypos;
		break;

	case CTL_SYSTEM:
		CHECK_CACHE;
		process_system(state, cp);
		break;

	case CTL_XSYSTEM:
		CHECK_CACHE;
		process_xsystem(state, cp);
		break;

	case CTL_TSYSTEM:
		CHECK_CACHE;
		process_tsystem(state, cp);
		break;

	case CTL_ICON:
		process_icon(state, cp);
		break;

#ifdef VFLIB
	case CTL_VFCAP:
		vfcap_name = cp->ctc_value;
		break;
#endif

#ifdef FREETYPE
	case CTL_TFDIR:
		freetypefontdir = cp->ctc_value;
		break;

	case CTL_TFONT0:
		freetypefont0 = cp->ctc_value;
		break;

	case CTL_TMFONT0:
		freetypemfont0 = cp->ctc_value;
		break;
#endif

	case CTL_NOOP:
	case CTL_NODEF:
		break;

	case CTL_XFONT:
		/* obsolete directives */
		fprintf(stderr, "internal error: obsolete directive "
			"\"%s\"\n", ctl_words[cp->ct_op].ctl_string);
		exit(1);
		/*NOTREACHED*/
	
	case CTL_PCACHE:
		if (!caching) { 
			if (cp->ctch_flag)
				mgp_flag |= FL_FRDCACHE;
			else 
				mgp_flag ^= FL_FRDCACHE;
			cache_mode   = cp->ctch_mode;	
			cache_effect = cp->ctch_effect;	
			cache_value  = cp->ctch_value;
		} else {
			pcache.flag = 1;
			pcache.page = state->page;
			pcache.mgpflag = cp->ctch_flag;
			pcache.mode = cp->ctch_mode;
			pcache.effect = cp->ctch_effect;
			pcache.value = cp->ctch_value;
		}
		break;

	case CTL_CHARSET:
		if (get_regid(cp->ctc_value) < 0){
			fprintf(stderr, "invalid charset \"%s\". ignored\n", 
				cp->ctc_value);
			break;
		}
		strcpy(mgp_charset, cp->ctc_value);
		break;

#ifdef MNG
	case CTL_ANIM:
		if (state->align == AL_LEFTFILL0) {
			state->align = AL_LEFTFILL1;
			state->leftfillpos = state->linewidth;
		}
		process_anim(state, cp);
		break;
#endif

	case CTL_VALIGN:
		valign = cp->cti_value;
		break;

	case CTL_AREA:
		state->width = window_width * cp->ctar_width / 100;
		state->height = window_height * cp->ctar_height / 100;
		state->xoff = window_width * cp->ctar_xoff / 100;
		state->yoff = window_height * cp->ctar_yoff / 100;
		state->ypos = 0;
		break;

	case CTL_OPAQUE:
#ifdef USE_XFT2
		if (cp->cti_value > 100){
			fprintf(stderr, "%%opaque: value should be 0-100\n");
			cp->cti_value = 100;
		}
		state->opaque = cp->cti_value;
		if (mgp_flag & FL_NOXFT && verbose){
			fprintf(stderr, "ignored %%opaque.\n");
		}
#else
		printf("this mgp cannot use %%opaque, needs to be built with xft2\n");
#endif
		break;
	case CTL_M17N:
#ifdef USE_M17N
		M17N_process_direc(cp->ctc2_value1, cp->ctc2_value2);
#else
		fprintf(stderr, "this mgp cannot use %%m17n, needs to be built with m17n-lib\n");
#endif
		break;
	case CTL_PSFONT:
		break;
	default:
		fprintf(stderr,
			"undefined directive %d at page %d line %d:\n\t",
			cp->ct_op, state->page, state->line);
		debug0(cp);
		break;
	}
}

/*
 * line management.
 */
static int
set_position(state)
	struct render_state *state;
{
	int x;

	x = 0;
	switch (state->align) {
	case AL_CENTER:
		x = (state->width - state->linewidth)/ 2;
		break;

	case AL_LEFT:
	case AL_LEFTFILL0:
	case AL_LEFTFILL1:
		x = 0;
		break;

	case AL_RIGHT:
		x = state->width - state->linewidth;
		break;
	}

	return x;
}

void
draw_line_start(state)
	struct render_state *state;
{
	struct render_object *obj;

	state->max_lineascent = 0;
	state->max_linedescent = 0;
	state->maxascent = 0;
	state->maxdescent = 0;
	state->linewidth = 0;
	state->brankline = 1;
	while ((obj = state->obj))
		obj_free(state, obj);
}

void
draw_line_itemsize(state, ascent, descent, flheight)
	struct render_state *state;
	int ascent;
	int descent;
	int flheight;
{
	ascent -= state->charoff;
	descent += state->charoff;
	if (ascent > state->maxascent)
		state->maxascent = ascent;
	if (descent > state->maxdescent)
		state->maxdescent = descent;

	/*
	 * calculation for the height of a line should ignore
	 * character offset
	 */
	if (state->charoff == 0) {
		if (ascent > state->max_lineascent)
			state->max_lineascent = ascent;
		if (descent > state->max_linedescent)
			state->max_linedescent = descent;
	}

	if (flheight > state->maxflheight)
		state->maxflheight = flheight;
}


static void
draw_line_output(state, data)
	struct render_state *state;
	char *data;
{
	draw_string(state, data);
}

void
draw_line_end(state)
	struct render_state *state;
{
	int xpos;

	xpos = set_position(state);

	/* process the special attribute. */
	switch (state->special) {
#if 0
	case SP_SHRINK:
		shrink(data, page, xpos);
		break;
#endif
	case SP_LCUTIN:
		cutin(state, xpos, state->ypos, 1);
		break;
	case SP_RCUTIN:
		cutin(state, xpos, state->ypos, -1);
		break;
	default:
		break;
	}
	if (state->obj) {
		obj_draw(state, state->target, xpos, state->ypos);
		while (state->obj)
			obj_free(state, state->obj);
	}

	state->ypos += state->max_lineascent;

	/* 
 	 * we should ignore height of images to calculate line gap.
	 * suggested by Toru Terao 
	 */ 
	if (VERT_GAP(char_size[caching]) < state->max_linedescent)
		state->ypos += state->max_linedescent;
	else
		state->ypos += VERT_GAP(char_size[caching]);

	state->ypos += 2;
}

#define min(x, y) (x < y ? x: y)  
static void
cutin(state, lx, ly, dir)
	struct render_state *state;
	int lx;
	int ly;
	int dir;
{
	u_int step, x, xoff, yoff;
	int i, sx, round;
	int root_x, root_y, use_copy;
	Window cutinWin, junkwin;
	XImage *copywin; 
	static XWindowAttributes xa;
	XWindowAttributes wa;
	Pixmap ghostWin;
	GC saveGC = gc_cache;

	XGetWindowAttributes(display, window, &wa);
	ghostWin = XCreatePixmap(display, window, wa.width, wa.height, wa.depth);
	/* all drawing should be done on the image */
	gc_cache = XCreateGC(display, ghostWin, 0, 0);
	XCopyArea(display, state->target, ghostWin, gc_cache,
			0, 0, wa.width, wa.height, 0, 0);

	if (state->repaint)
		return;

	if (!state->linewidth)
		return;

	if (!xa.width) 
		XGetWindowAttributes(display, DefaultRootWindow(display), &xa);
	XTranslateCoordinates(display, window, DefaultRootWindow(display), 
		0, 0, &root_x ,&root_y, &junkwin);
	use_copy = 1;
	if ((root_x + window_width > xa.width) || (root_y + window_height > xa.height) ||
			(root_x < 0 || root_y < 0)) use_copy = 1;

	sx = (0 < dir) ? 0 : state->width - state->linewidth;
	round = 20;	/*XXX*/
#ifndef abs
#define abs(a)	(((a) < 0) ? -(a) : (a))
#endif
	if (abs(lx - sx) < round){
		round = abs(lx - sx);
		if (!round) round = 1;
	}

	step = (lx - sx) / round;

	if (!use_copy){
		cutinWin = XCreateSimpleWindow(display, state->target,
			sx, ly, state->linewidth, state->maxascent + state->maxdescent,
			0, fore_color[caching], back_color[caching]);
		XSetWindowBackgroundPixmap(display, cutinWin, None);
		XMapSubwindows(display, state->target);
	} else {
		copywin = XGetImage(display, window, state->xoff + min(sx, lx), ly + state->yoff, state->linewidth + abs(lx - sx),	
					state->maxascent + state->maxdescent, AllPlanes, ZPixmap);
	}

	xoff = state->xoff;	
	yoff = state->yoff;	
	state->xoff = state->yoff = 0;
	if (state->obj && !use_copy) {
		obj_draw(state, cutinWin, 0, 0);
	}
	XFlush(display);

	x = sx;
	for (i = 0; i < round; i++) {
		if (use_copy && state->obj) {
				obj_draw(state, ghostWin, x + xoff, ly + yoff);
                                XCopyArea(display, ghostWin, state->target, 
                                    saveGC,
                                    xoff + min(sx, lx),
                                    ly + yoff,
                                    state->linewidth + abs(lx - sx),
                                    state->maxascent + state->maxdescent,
                                    xoff + min(sx, lx),
                                    ly + yoff);
		} else 
			XMoveWindow(display, cutinWin, x + xoff, ly + yoff);

		XFlush(display);
		usleep(CUTIN_DELAY);
		if (use_copy && state->obj) {
			XPutImage(display, ghostWin, gc_cache, copywin, 
				x - min(sx, lx) , 0, x + xoff, ly + yoff, 
				state->linewidth, state->maxascent + state->maxdescent);
		}
		x = sx + ((i+1)*(lx - sx)) / round;
	}
	XCopyArea(display, ghostWin, state->target, saveGC,
		0, 0, wa.width, wa.height, 0, 0);

	if (!use_copy) XDestroyWindow(display, cutinWin);
	state->xoff = xoff;	
	state->yoff = yoff;	

	/* freeing images */
	if(use_copy) XFree(copywin);

	/* restoring tho old GC */
	XFreeGC(display, gc_cache);
	XFreePixmap(display, ghostWin);
	gc_cache = saveGC;
}

#if 0
static void
shrink(data, page)
	char *data;
	u_int page;
{
	u_int min_csize = char_size;
	u_int max_csize = state->height / 4;
	u_int csize, i, x;
	u_int step = (max_csize - min_csize) / 3;

	if (!step)
		step = 1;

	if (state->align != AL_CENTER) {
		fprintf(stderr, "align is not center: \n");
		return;
	}

	csize = char_size;
	for (i = max_csize; i > min_csize; i -= step) {
		char_size = i;
		draw_string(state, data);
		x = (state->width - state->linewidth) / 2;
		XCopyArea(display, maskpix, state->target, gc,
			0, 0, state->linewidth, char_size, x, state->ypos);
		XCopyArea(display, pixmap, state->target, gcor,
			0, 0, state->linewidth, char_size, x, state->ypos);
		XFlush(display);
		usleep(SHRINK_DELAY);
		XFillRectangle(display, pixmap, gcall,
			0, 0, state->width, char_size);
		XFillRectangle(display, maskpix, gcall,
			0, 0, state->width, char_size);
		XClearArea(display, state->target, x, state->ypos,
			state->linewidth, char_size, 0);
	}
	char_size = csize;
}
#endif

/*
 * render characters.
 */
static void
draw_string(state, data)
	struct render_state *state;
	char *data;
{
	u_char *p, *q;
	char *registry = NULL;
	u_int code2;
	static char *rtab96[] = {
		NULL,			/* ESC - @ */
		"iso8859-1",		/* ESC - A */
		"iso8859-2",		/* ESC - B */
		"iso8859-3",		/* ESC - C */
		"iso8859-4",		/* ESC - D */
	};
#define RTAB96_MAX	(sizeof(rtab96)/sizeof(rtab96[0]))
	static char *rtab9494[] = {
		"jisx0208.1978-*",	/* ESC $ @ or ESC $ ( @ */
		"gb2312.1980-*",	/* ESC $ A or ESC $ ( A */
		"jisx0208.1983-*",	/* ESC $ B or ESC $ ( B */
		"ksc5601.1987-*",	/* ESC $ ( C */
		NULL,			/* D */
		NULL,			/* E */
		NULL,			/* F */
		NULL,			/* G */
		NULL,			/* H */
		NULL,			/* I */
		NULL,			/* J */
		NULL,			/* K */
		NULL,			/* L */
		NULL,			/* M */
		NULL,			/* N */
		"jisx0213.2000-1",	/* ESC $ ( O */
		"jisx0213.2000-2",	/* ESC $ ( P */
	};
#define RTAB9494_MAX	(sizeof(rtab9494)/sizeof(rtab9494[0]))
	int charset16 = 0;

	p = (u_char *)data;
	while (*p && *p != '\n') {
		/* 94x94 charset */
		if (p[0] == 0x1b && p[1] == '$' &&
		    '@' <= p[2] && p[2] < 'C' && rtab9494[p[2] - '@']) {
			registry = rtab9494[p[2] - '@'];
			charset16 = 1;
			p += 3;
			continue;
		}
		if (p[0] == 0x1b && p[1] == '$' && p[2] == '(' &&
		    '@' <= p[3] && p[3] < '@' + RTAB9494_MAX &&
		    rtab9494[p[3] - '@']) {
			registry = rtab9494[p[3] - '@'];
			charset16 = 1;
			p += 4;
			continue;
		}
		/* ascii (or JIS roman) */
		if (p[0] == 0x1b && p[1] == '(' &&
		    (p[2] == 'B' || p[2] == 'J')) {
			registry = NULL;
			charset16 = 0;
			p += 3;
			continue;
		}
		/* 96 charset */
		if (p[0] == 0x1b && p[1] == '-' &&
		    '@' < p[2] && p[2] < '@' + RTAB96_MAX &&
		    rtab96[p[2] - '@']) {
			registry = rtab96[p[2] - '@'];
			charset16 = 0;
			p += 3;
			continue;
		}

		if (!registry && isspace(p[0])) {
			draw_fragment(state, p, 1, registry, 0);
			p++;
			continue;
		}

		if (charset16) {
			for (q = p + 2; 0x21 <= *q && *q <= 0x7e; q += 2) {
				code2 = q[0] * 256 + q[1];
				if (strncmp(registry, "jisx0208", 8) == 0
				 && !iskinsokuchar(code2)) {
					break;
				}
			}
		} else {
			q = p;
			while (*q && isprint(*q) && !isspace(*q))
				q++;
			if (q == p)
				q++;
			else {
				/*
				 * append spaces to the end of the word.
				 * fragments in the following line:
				 *	"this is test"
				 * are:
				 *	"this_" "is_" "test"
				 */
				while (*q && isspace(*q))
					q++;
			}
		}

		q = draw_fragment(state, p, q - p, registry, charset16);

		p = q;
	}
}

static char *
draw_fragment(state, p, len, registry, charset16)
	struct render_state *state;
	u_char *p;
	u_int len;
	char *registry;
	int charset16;	/*2-octet charset?*/
{
	u_int char_len, i;
	u_short code;
	struct render_object *tail;
	struct render_object *thisline;
	struct render_object *thislineend;
	u_int startwidth;
	struct render_state backup0, backup;
	enum { MODE_UNKNOWN, MODE_X, MODE_VFLIB, MODE_FREETYPE }
		mode = MODE_UNKNOWN;
	char *p0;

#ifdef USE_XFT2
	if (!(mgp_flag & FL_NOXFT)){
		p0 = xft_draw_fragment(state, p, len, registry, charset16);
		if (p0) return p0;
	}
#endif

	if (state->obj)
		tail = state->objlast;
	else
		tail = NULL;
	startwidth = state->linewidth;

	while (len) {
		code = charset16 ? p[0] * 256 + p[1] : p[0];
		if (code != ' ') 
			state->brankline = 0; /* This isn't brankline */

#if 0
		if (code == ' ') {
			char_len = char_size[caching] / 2;
			p++;
			len--;

			state->linewidth += HORIZ_STEP(char_size[caching], char_len);
			continue;
		}
#endif
		if (code == '\t') {
			char_len = char_size[caching] / 2;
			p++;
			len--;

			char_len = HORIZ_STEP(char_size[caching], char_len) * 8;/*XXX*/
			state->linewidth = (state->linewidth + char_len) / char_len * char_len;
			continue;
		}

		/*
		 * decide which font to use.
		 * Japanese font:
		 *	VFlib - optional
		 *	then X.
		 * Western font:
		 *	If possible, freetype. (in the future) - optional
		 *	X if truely scalable.
		 *	VFlib if it is larger than some size - optional
		 *	otherwise, X.
		 */
		mode = MODE_UNKNOWN;
		if (charset16) {
#ifdef VFLIB
			if (!(mgp_flag & FL_NOVFLIB)
			 && strncmp(registry, "jisx0208.1983-", 14) == 0)
				mode = MODE_VFLIB;
#endif
#ifdef FREETYPE_CHARSET16
			if (!(mgp_flag & FL_NOFREETYPE)
			 && (strncmp(registry, "jisx0208.1983-", 14) == 0 ||
			     strncmp(registry, "jisx0213.2000-", 14) == 0)) {
				if (tfc_get(code, char_size[caching], 1, registry,
						charset16)){
					mode = MODE_FREETYPE;
				}
			}
#endif
			if (mode == MODE_UNKNOWN)
				mode = MODE_X;
		} else {
#ifdef FREETYPE
			if (!(mgp_flag & FL_NOFREETYPE)) {
				if (tfc_get(code, char_size[caching], 1, registry,
						charset16)) {
					mode = MODE_FREETYPE;
				}
			}
#endif
			if (mode == MODE_UNKNOWN) {
				/*
				 * if we can have X font that is exactly
				 * matches the required size, we use that.
				 */
				XFontStruct *xfontstruct;
				int ts;
				xfontstruct = x_setfont(
					x_findseed(state, registry),
					char_size[caching], registry, &ts);
				if (ts)
					mode = MODE_X;
			}
#ifdef VFLIB
# ifdef USE_XDRAWSTRING_ONLY_SMALL
			if (!(mgp_flag & FL_NOVFLIB) && mode == MODE_UNKNOWN) {
				if (25 < char_size)
					mode = MODE_VFLIB;
			}
# endif /* USE_XDRAWSTRING_ONLY_SMALL */
#endif

			/* last resort: use X font. */
			if (mode == MODE_UNKNOWN)
				mode = MODE_X;
		}

		/* back it up before drawing anything */
		memcpy(&backup0, state, sizeof(struct render_state));

		switch (mode) {
#ifdef VFLIB
		case MODE_VFLIB:
			char_len = draw_onechar_vf(state, code,
				state->linewidth, state->charoff,
				registry ? char_size[caching]
					 : (char_size[caching] * 4 / 5), /*XXX*/
				char_size[caching]);
			break;
#endif
#ifdef FREETYPE
		case MODE_FREETYPE:
			/*
			 * NOTE: width and height parameter (4th and 5th)
			 * are meaningless for FreeType, since we use
			 * metric info derived from TrueType font file.
			 */
			char_len = draw_onechar_tf(state, code,
				state->linewidth, state->charoff,
				char_size[caching], registry,
				(len == (charset16 ? 2 : 1)) ? 1 : 0,
				charset16);
			break;
#endif
		default:
			fprintf(stderr, "invalid drawing mode %d for %04x "
				"- fallback to X11\n", mode, code);
			/* fall through */
		case MODE_UNKNOWN:
		case MODE_X:
			char_len = draw_onechar_x(state, code,
				state->linewidth, state->charoff, char_size[caching],
				registry, (len == (charset16 ? 2 : 1)) ? 1 : 0);
			if (char_len == 0) {
				fprintf(stderr, "can't load font size %d "
					"(nor font in similar size) for "
					"font <%s:%d:%s>, glyph 0x%04x\n",
					char_size[caching], x_findseed(state, registry),
					char_size[caching], registry?registry:"NULL", code);
			}
			break;
		}

		p += (charset16 ? 2 : 1);
		len -= (charset16 ? 2 : 1);

		state->linewidth += HORIZ_STEP(char_size[caching], char_len);
		/* ukai */
		if (!charset16 && state->linewidth + HORIZ_STEP(char_size[caching], 
				char_len) > state->width) {
			if (len >= 20) break; /* too long word */
			for (i = 0; i < len; i ++){
				if (isspace(*(p +i))) break;	
			}
			if (i == len) break;
		}
	}

	if (state->width - state->leftfillpos / 2 < state->linewidth
#if 0
	 && state->align == AL_LEFTFILL1
#endif
	   ) {
		memcpy(&backup, state, sizeof(struct render_state));

		/* strip off the last fragment we wrote. */
		if (tail) {
			thisline = tail->next;
			thislineend = state->objlast;
			tail->next = NULL;
			state->objlast = tail;
			state->maxascent = backup0.maxascent;
			state->maxdescent = backup0.maxdescent;
		} else {
			thisline = state->obj;
			thislineend = state->objlast;
			state->obj = state->objlast = NULL;
			state->maxascent = backup0.maxascent;
			state->maxdescent = backup0.maxdescent;
		}
#if 0
		state->align = AL_LEFT;
#endif
		state->linewidth = startwidth;
		draw_line_end(state);	/* flush the line. */

		/* start the new line with the last fragment we wrote. */
		draw_line_start(state);
		state->linewidth = state->leftfillpos;
		state->linewidth += (backup.linewidth - startwidth);
		if (state->obj && state->objlast)
			state->objlast->next = thisline;
		else
			state->obj = thisline;
		state->objlast = thislineend;
		state->align = backup.align;
		/* fix up x position and maxascent. */
		for (tail = state->obj; tail; tail = tail->next) {
			tail->x -= startwidth;
			tail->x += state->leftfillpos;
			draw_line_itemsize(state, tail->ascent, tail->descent, 0);
		}
	}
	return p;
}

static int
iskinsokuchar(code)
	u_int code;
{
	u_short *kinsoku;

	for (kinsoku = kinsokutable; *kinsoku; kinsoku++) {
		if (code == *kinsoku)
			return 1;
	}
	return 0;
}

static struct render_object *
obj_alloc(state)
	struct render_state *state;
{
	struct render_object *obj;

	obj = malloc(sizeof(*obj));
	if (obj == NULL)
		return NULL;
	obj->next = NULL;
	if (state->obj == NULL)
		state->obj = obj;
	else
		state->objlast->next = obj;
	state->objlast = obj;
	return obj;
}

static void
obj_free(state, obj)
	struct render_state *state;
	struct render_object *obj;
{
	struct render_object *o;

	if (state->obj == obj)
		state->obj = obj->next;
	else {
		for (o = state->obj; o; o = o->next)
			if (o->next == obj)
				break;
		/* ASSERT(o != NULL); */
		o->next = obj->next;
	}
	if (state->objlast == obj)
		state->objlast = obj->next;
	switch (obj->type) {
#ifdef VFLIB
	case O_VFONT:
		obj->data.vfc->ref--;
		break;
#endif /* VFLIB */
#ifdef FREETYPE
	case O_TFONT:
		obj->data.tfc->ref--;
		break;
#endif /* FREETYPE */
	case O_IMAGE:
		freeImage(obj->data.image.image);
		break;
	case O_XFONT:
		free(obj->data.xfont.xfont);
		break;
	case O_ICON:
		if (obj->data.icon.xpoint)
			free(obj->data.icon.xpoint);
		break;
#ifdef USE_XFT2
	case O_XTFONT:
		if (obj->data.xftfont.data)
			free(obj->data.xftfont.data);
		if (obj->data.xftfont.fontname)
			free(obj->data.xftfont.fontname);
		if (obj->data.xftfont.registry)
			free(obj->data.xftfont.registry);
		break;
#endif
#ifdef USE_M17N
	case O_M17NTEXT:
		/* XXX we need to add free function for mtext data here! */
		m17n_object_unref(obj->data.m17ntext.mt);
		break;
#endif
#ifdef MNG
	case O_ANIM:
		break;
#endif /* MNG */
	}
	free(obj);
}

#ifdef VFLIB
static int
obj_new_vfont(state, x, y, vfc, size)
	struct render_state *state;
	int x, y;
	struct vfont *vfc;
	int size;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = fore_color[caching];
	obj->type = O_VFONT;
	obj->data.vfc = vfc;
	obj->data.vfc->size = size;
	obj->ascent = obj->data.vfc->ascent - y;
	obj->descent = obj->data.vfc->descent + y;
	obj->vertloc = VL_BASE;
	vfc->ref++;
	return 1;
}
#endif /* VFLIB */

#ifdef FREETYPE
static int
obj_new_tfont(state, x, y, tfc)
	struct render_state *state;
	int x, y;
	struct tfont *tfc;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = fore_color[caching];
	obj->type = O_TFONT;
	obj->data.tfc = tfc;
	obj->ascent = obj->data.tfc->ascent - y;
	obj->descent = obj->data.tfc->descent + y;
	obj->vertloc = VL_BASE;
	tfc->ref++;
	return 1;
}
#endif /* FREETYPE */

static int
obj_new_xfont(state, x, y, size, code, registry)
	struct render_state *state;
	int x, y;
	int size;
	u_int code;
	char *registry;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = fore_color[caching];
	obj->type = O_XFONT;
	obj->data.xfont.xfont = strdup(x_findseed(state, registry));
	obj->data.xfont.csize = size;
	obj->data.xfont.code = code;
	obj->data.xfont.registry = registry;
	obj->ascent = size - y;	/*XXX*/
	obj->descent = -y;	/*XXX*/
	obj->vertloc = VL_BASE;
	return 1;
}

static int
obj_new_image(state, x, y, image, xzoom, yzoom)
	struct render_state *state;
	int x, y;
	Image *image;
	int xzoom, yzoom;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->type = O_IMAGE;
	obj->data.image.image = image;
	obj->data.image.xzoom = xzoom;
	obj->data.image.yzoom = yzoom;
	obj->ascent = 0;	/*XXX*/
	obj->descent = image->height * yzoom / 100;	/*XXX*/
	obj->vertloc = VL_TOP;
	return 1;
}

#ifdef USE_IMLIB
static int
obj_new_image2(state, x, y, image, xzoom, yzoom, imimage, zoomonclk)
	struct render_state *state;
	int x, y;
	Image *image;
	int xzoom, yzoom;
	ImlibImage *imimage;
	int zoomonclk;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->type = O_IMAGE;
	obj->data.image.image = image;
	obj->data.image.xzoom = xzoom;
	obj->data.image.yzoom = yzoom;
	obj->ascent = 0;	/*XXX*/
	obj->descent = image->height * yzoom / 100;	/*XXX*/
	obj->vertloc = VL_TOP;
	obj->data.image.imimage = imimage;
	obj->data.image.zoomonclk = zoomonclk;
	return 1;
}
#endif

static int
obj_new_icon(state, x, y, itype, isize, color, npoint, xpoint)
	struct render_state *state;
	int x, y;
	u_int itype, isize;
	u_long color;
	u_int npoint;
	XPoint *xpoint;
{
	struct render_object *obj;
	int i;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = color;
	obj->type = O_ICON;
	obj->data.icon.itype = itype;
	obj->data.icon.isize = isize;
	obj->data.icon.npoint = npoint;
	if (npoint) {
		obj->data.icon.xpoint = malloc(sizeof(XPoint) * npoint);
		if (obj->data.icon.xpoint == NULL) {
			obj_free(state, obj);
			return 0;
		}
		for (i = 0; i < npoint; i++)
			obj->data.icon.xpoint[i] = xpoint[i];
	} else
		obj->data.icon.xpoint = NULL;
	obj->ascent = 0;	/*XXX*/
	obj->descent = isize;	/*XXX*/
	obj->vertloc = VL_CENTER;
#ifdef USE_M17N
	// Adjust icon position for line folding function
	if (mgp_flag & FL_NOM17N)
		obj->vertloc = VL_CENTER;
	else
		obj->vertloc = VL_ICENTER;
#endif
	return 1;
}

static Pixel
obj_image_color(image, bimage, d, inithist)
	Image *image, *bimage;
	Pixel d;
	int *inithist;
{
	int i, j;
	RGBMap rgb;
	int r, g, b;
	static char hist[256];
	byte *p;

	switch (bimage->type) {
	case IBITMAP:
		r = g = b = d ? 0xffff : 0;
		break;
	case IRGB:
		r = bimage->rgb.red[d];
		g = bimage->rgb.green[d];
		b = bimage->rgb.blue[d];
		break;
	case ITRUE:
		r = TRUE_RED(d) << 8;
		g = TRUE_GREEN(d) << 8;
		b = TRUE_BLUE(d) << 8;
		break;
	default:
		return 0;
	}
	if (image->type == ITRUE)
		return RGB_TO_TRUE(r, g, b);

	for (i = 0; i < image->rgb.used; i++) {
		if (image->rgb.red[i] == r &&
		    image->rgb.green[i] == g &&
		    image->rgb.blue[i] == b)
			return i;
	}
	if (i >= image->rgb.size) {
		if (i >= 256) {
			/* search a free slot */
			if (image->rgb.size == 256) {
				if (!*inithist) {
					*inithist = 1;
					memset(hist, 0, sizeof(hist));
					p = image->data;
					for (j = 0; j < image->height; j++)
						for (i = 0; i < image->width; i++)
							hist[*p++] = 1;
				}
				for (i = 0; i < 256; i++) {
					if (hist[i] == 0) {
						hist[i] = 1;
						goto freeslot;
					}
				}
			}
			return -1;
		}
		image->depth = 8;
		newRGBMapData(&rgb, depthToColors(image->depth));
		for (i = 0; i < image->rgb.used; i++) {
			rgb.red[i] = image->rgb.red[i];
			rgb.green[i] = image->rgb.green[i];
			rgb.blue[i] = image->rgb.blue[i];
		}
		rgb.used = i;
		freeRGBMapData(&image->rgb);
		image->rgb = rgb;
	}
  freeslot:
	image->rgb.red[i] = r;
	image->rgb.green[i] = g;
	image->rgb.blue[i] = b;
	if (image->rgb.used < i + 1)
		image->rgb.used = i + 1;
	return i;
}

static Image *
obj_image_trans(image, x, y)
	Image *image;
	u_int x, y;
{
	Image *timage;
	int i, j;
	byte *p, *b;
	Pixel d, n, pd;
	static XColor xcol;
	int pl, bpl;
	int trans;
	u_int bw, bh, bx, by;
	int inithist;

	if (!COMPLEX_BGIMAGE) {
		if (back_color[caching] != xcol.pixel) {
			xcol.pixel = back_color[caching];
			xcol.flags = DoRed|DoGreen|DoBlue;
			XQueryColor(display, colormap, &xcol);
		}
		switch (image->type) {
		case IBITMAP:
		case IRGB:
			image->rgb.red[image->trans] = xcol.red;
			image->rgb.green[image->trans] = xcol.green;
			image->rgb.blue[image->trans] = xcol.blue;
			break;
		case ITRUE:
			d = image->trans;
			n = RGB_TO_TRUE(xcol.red, xcol.green, xcol.blue);
			pl = image->pixlen;
			p = image->data;
			for (j = 0; j < image->height; j++) {
				for (i = 0; i < image->width; i++, p += pl) {
					if (memToVal(p, pl) == d)
						valToMem(n, p, pl);
				}
			}
			break;
		}
		bw = bh = 0;	/* for lint */
		goto end;
	}
	bh = bgpixmap[bgindex].image->height;
	bw = bgpixmap[bgindex].image->width;
	j = 0;
	if (image->type == IBITMAP) {
  expand:
		timage = image;
		if (verbose)
			fprintf(stderr, "obj_image_trans: expanding image\n");
		image = expand(image);
		if (image != timage)
			freeImage(timage);
	}
	pl = image->pixlen;
	p = image->data + image->width * j * pl;
	bpl = bgpixmap[bgindex].image->pixlen;
	pd = -1;
	n = 0;	/* for lint */
	trans = image->trans;
	inithist = 0;
	for ( ; j < image->height; j++) {
		by = (y + j) % bh;
		bx = x % bw;
		b = bgpixmap[bgindex].image->data + 
			(bgpixmap[bgindex].image->width * by + bx) * bpl;
		for (i = 0; i < image->width; i++, p += pl, b += bpl, bx++) {
			if (bx == bw) {
				bx = 0;
				b = bgpixmap[bgindex].image->data + 
					bgpixmap[bgindex].image->width * by * bpl;
			}
			if (memToVal(p, pl) != trans)
				continue;
			d = memToVal(b, bpl);
			if (d != pd) {
				pd = d;
				n = obj_image_color(image, 
						bgpixmap[bgindex].image, d, &inithist);
				if (n == -1)
					goto expand;
			}
			valToMem(n, p, pl);
		}
	}
  end:
	if (verbose) {
		char *p;

		switch (image->type) {
		case IBITMAP:	p = "bitmap"; break;
		case IRGB:	p = "rgb"; break;
		default:	p = "true"; break;
		}
		fprintf(stderr, "obj_image_trans: %s: "
			"trans=%d, rgb_used=%d, rgb_size=%d\n",
			p, image->trans, image->rgb.used, image->rgb.size);
		fprintf(stderr, "  image=%dx%d+%d+%d",
			image->width, image->height, x, y);
		if (COMPLEX_BGIMAGE)
			fprintf(stderr, "  bgpixmap[bgindex].image=%dx%d", bw, bh);
		fprintf(stderr, "\n");
	}
	image->trans = -1;	/* XXX: need recalculation to redraw? */
	return image;
}

static void
obj_draw_image(target, x, y, obj, page)
	Drawable target;
	u_int x, y;
	struct render_object *obj;
	int page;
{
	Image *image, *timage;
	XImageInfo *ximageinfo;
	XImage *xim;
	int private = mgp_flag & FL_PRIVATE;

	image = obj->data.image.image;
	if (obj->data.image.xzoom != 100.0 || obj->data.image.yzoom != 100.0) {
		timage = image;
		image = zoom(image,
			obj->data.image.xzoom, obj->data.image.yzoom, verbose);
		if (!image) {
			fprintf(stderr, "image zoom (%0.2fx%0.2f) failed in obj_draw_image\n",
				obj->data.image.xzoom, obj->data.image.yzoom);
			exit(1);
		}
		freeImage(timage);
	}
	if (image->trans >= 0)
		image = obj_image_trans(image, x, y);
	obj->data.image.image = image;	/* to free later */
	ximageinfo= imageToXImage(display, screen, visual, depth, image,
				private, 0,0, verbose);
	if (ximageinfo == NULL) {
		fprintf(stderr, "Cannot convert Image to XImage\n");
		cleanup(-1);
	}
	xim = ximageinfo->ximage;
	if (xim->format == XYBitmap)
		XSetBackground(display, gcfore, back_color[caching]);
	XPutImage(display, target, gcfore, xim, 0, 0,
		x, y, xim->width, xim->height);

#ifdef USE_IMLIB
	if (obj->data.image.zoomonclk) {
		regist_zimage_position(obj, x, y, xim->width, xim->height, page);
	}
#endif
	freeXImage(image, ximageinfo);
}

static void
obj_draw(state, target, xpos, ypos)
	struct render_state *state;
	Drawable target;
	u_int xpos, ypos;
{
	struct render_object *obj;
	int x = 0, y = 0;
	int width, height, xwidth, xheight;
	u_long fore;
	u_int code;
	char *registry;
	XChar2b kch[2];
#define MAXDRAWAREA 1024
	struct {
		int x, y, width, height;
	} drawarea[MAXDRAWAREA];
	int areaindex = 0;
#define addarea(X) \
{\
	if (areaindex == MAXDRAWAREA){\
		fprintf(stderr, "too many drawarea (increase MAXDRAWAREA)\n");\
			exit(1);\
	}\
	drawarea[areaindex].x = x;\
	drawarea[areaindex].y = y - obj->data.X->ascent;\
	drawarea[areaindex].width = obj->data.X->xmax+1;\
	drawarea[areaindex].height = obj->data.X->height+1;\
	areaindex ++;\
}
#if 0
	char ch[2];
#endif
	u_int isize;
	int i;
	int lineoff;   /* ypos correction for lines with superscripts */
#ifdef RASTERLIB
	XImage *bim, *xim;
	u_long bcolor;
#endif /* RASTERLIB */

	/*
	 * very complicated...
	 *
	 *	xpos, ypos	x/y position of the target,
	 *			leftmost and uppermost dot.
	 *	state->ypos	absolute y position in main window.
	 */
	xpos += state->tabxprefix ? state->tabxprefix : state->xprefix;
	width = (state->linewidth <= state->width - xpos)
			? state->linewidth
			: state->width - xpos;
	height = state->maxascent + state->maxdescent + 1;
	xpos += state->xoff;
	ypos += state->yoff;
	fore = fore_color[caching];

	/* 
	 * only used with superscript offset for calculating the
	 * exact line position (ypos correction)
	 */
	lineoff = state->maxascent - state->max_lineascent;

#ifdef RASTERLIB
	bcolor = back_color[caching];
	for (obj = state->obj; obj; obj = obj->next) {
#ifdef VFLIB
		if (obj->type == O_VFONT){
			xwidth = obj->data.vfc->width;
			xheight = obj->data.vfc->height;
			break;
		}
#endif /* VFLIB */
#ifdef FREETYPE
		if (obj->type == O_TFONT){
			xwidth = obj->data.tfc->width;
			xheight = obj->data.tfc->height;
			break;
		}
#endif /* FREETYPE */
	}
	if (obj != NULL) {	/* VFONT exist */
		xim = XCreateImage(display, visual, depth, ZPixmap,
				0, NULL, width, height,
				(depth <= 8) ? 8 : (depth <= 16) ? 16 : 32, 0);
		xim->data = malloc(xim->bytes_per_line * height);
		if (COMPLEX_BGIMAGE) {
			u_int bw, bh, bx, by, ox, oy;
			u_long p;
			u_long r, g, b;
			byte *bp;
			int bpl;
			XColor col;

			bim = bgpixmap[bgindex].ximageinfo->ximage;
			bw = bim->width;
			bh = bim->height;
			ox = xpos;
			oy = state->ypos + state->yoff;
			bcolor = (u_long)-1; /* tell vfc_image() to calculate */
			by = oy % bh;
			if (bw == 1) {
				r = g = b = 0;
				bpl = bgpixmap[bgindex].image->pixlen;
				bp = bgpixmap[bgindex].image->data + by * bpl;
				for (y = 0;
				     y < height;
				     y++, by++, bp += bpl) {
					if (by == bh)
						by = 0;
					p = memToVal(bp, bpl);
					if (TRUEP(bgpixmap[bgindex].image)) {
						r += TRUE_RED(p) << 8;
						g += TRUE_GREEN(p) << 8;
						b += TRUE_BLUE(p) << 8;
					} else {
						r += bgpixmap[bgindex].image->rgb.red[p];
						g += bgpixmap[bgindex].image->rgb.green[p];
						b += bgpixmap[bgindex].image->rgb.blue[p];
					}
					p = XGetPixel(bim, 0, by);
					for (x = 0; x < width; x++)
						XPutPixel(xim, x, y, p);
				}
				col.red = r / height;
				col.green = g / height;
				col.blue = b / height;
				col.flags = DoRed|DoGreen|DoBlue;
				/* XXX:actually we don't need to allocate. */
				if (XAllocColor(display, colormap, &col)) {
					regist_alloc_colors(&font_clr,
						&col.pixel, 1);
					bcolor = col.pixel;
				}
#if 0
			fprintf(stderr, "bim=%dx%d, r=%x, g=%x, b=%x, "
				"bcolor=%x\n",
				bgpixmap[bgindex].image->width, bgpixmap[bgindex].image->height,
				col.red, col.green, col.blue, bcolor);
#endif
			} else {
				for (y = 0; y < height; y++, by++) {
					if (by == bh)
						by = 0;
					for (x = 0, bx = ox % bw; x < width; x++, bx++) {
						if (bx == bw)
							bx = 0;
						p = XGetPixel(bim, bx, by);
						XPutPixel(xim, x, y, p);
					}
				}
			}
		} else {
			memset(xim->data, 0, xim->bytes_per_line * height);
			XAddPixel(xim, bcolor);
		}
		for ( ; obj; obj = obj->next) {
			x = obj->x;
			switch (obj->vertloc) {
			case VL_BASE:
				y = state->maxascent;
				break;
			case VL_CENTER:
				y = (state->maxascent + state->maxdescent) / 2;
				y += (obj->ascent - obj->descent) / 2;
				break;
			case VL_TOP:
				y = obj->ascent;
				break;
			case VL_BOTTOM:
				y = state->maxascent + state->maxdescent;
				y -= obj->descent;
				break;
			}
			y += obj->y;
#ifdef VFLIB
			if (obj->type == O_VFONT) {
				(void)vfc_image(obj->data.vfc,
					obj->fore, bcolor, xim, x, y);
				addarea(vfc);
			}
#endif /* VFLIB */
#ifdef FREETYPE
			if (obj->type == O_TFONT) {
				(void)tfc_image(obj->data.tfc,
					obj->fore, bcolor, xim, x, y);
				addarea(tfc);
			}
#endif /* FREETYPE */
		}
#if 0
		XPutImage(display, target, gcfore, xim, 0, 0,
			xpos, ypos, width, height);
#else
		for (i = 0; i < areaindex; i ++)
			XPutImage(display, target, gcfore, xim,
				drawarea[i].x, drawarea[i].y,
				drawarea[i].x + xpos,
				ypos + drawarea[i].y - lineoff,
				drawarea[i].width, drawarea[i].height);
#endif
		XDestroyImage(xim);
		if (mgp_flag & FL_GLYPHEDGE) {
			XDrawLine(display, target, gcfore, state->xoff, ypos,
				state->xoff + state->width - 1, ypos);
			XDrawLine(display, target, gcfore,
				state->xoff, ypos + state->maxascent,
				state->xoff + state->width - 1,
				ypos + state->maxascent);
			XDrawLine(display, target, gcgreen,
				state->xoff,
				ypos + state->maxascent + state->maxdescent,
				state->xoff + state->width - 1,
				ypos + state->maxascent + state->maxdescent);
			XDrawLine(display, target, gcred,
				state->xoff, ypos + height,
				state->xoff + state->width - 1, ypos + height);
		}

	}
#endif /* RASTERLIB */
	for (obj = state->obj; obj; obj = obj->next) {
#if 0
		x = obj->x + offx;
		y = obj->y + offy;
#else
		x = obj->x;
		switch (obj->vertloc) {
		case VL_BASE:
			y = state->maxascent;
			break;
		case VL_ICENTER:
			if (state->maxflheight){
				y = (state->maxascent + state->maxflheight) / 2;
			} else
				y = (state->maxascent + state->maxdescent) / 2;
			y += (obj->ascent - obj->descent) / 2;
			break;
		case VL_CENTER:
			y = (state->maxascent + state->maxdescent) / 2;
			y += (obj->ascent - obj->descent) / 2;
			break;
		case VL_TOP:
			y = obj->ascent;
			break;
		case VL_BOTTOM:
			y = state->maxascent + state->maxdescent;
			y -= obj->descent;
			break;
		}
		x += xpos;
		y += ypos;
#endif
		switch (obj->type) {
#ifdef MNG
		case O_ANIM:
			obj_draw_anim(state, x, y, obj);
			break;
#endif /* MNG */
		case O_IMAGE:
			obj_draw_image(target, x, y, obj, state->page);
			break;
#ifdef USE_XFT2
		case O_XTFONT:
			y += obj->y;
			set_xrender_color(obj->fore, state->opaque);
			xft_font = xft_setfont(obj->data.xftfont.fontname, 
						obj->data.xftfont.size,
						obj->data.xftfont.registry);
			
			XftDraw *dummy = xft_getdraw(target);
			if (obj->data.xftfont.charset16){
				XftDrawStringUtf8(dummy,
						&xft_forecolor, xft_font, 
						x, y - lineoff,
						obj->data.xftfont.data,
						obj->data.xftfont.len);
			} else
				XftDrawString8(dummy,
						&xft_forecolor, xft_font, 
						x, y - lineoff,
						obj->data.xftfont.data,
						obj->data.xftfont.len);
			XftDrawDestroy(dummy);
			break;
#endif
#ifdef USE_M17N
		case O_M17NTEXT:
			y += obj->y;
			M17N_draw_object(obj, target, x, y);
			break;
#endif
		case O_XFONT:
			y += obj->y;
			code = obj->data.xfont.code;
			registry = obj->data.xfont.registry;
			(void)x_setfont(obj->data.xfont.xfont,
				obj->data.xfont.csize,
				registry, NULL);
			if (obj->fore != fore) {
				fore = obj->fore;
				XSetForeground(display, gcfore, fore);
			}

#if 1
			/* is it always okay? */
			kch[0].byte1 = (code >> 8) & 0xff;
			kch[0].byte2 = code & 0xff;
			XDrawString16(display, target, gcfore,
					x, y - lineoff, kch, 1);
#else
			if (registry) {
				kch[0].byte1 = (code >> 8) & 0xff;
				kch[0].byte2 = code & 0xff;
				XDrawString16(display, target, gcfore,
					x, y - lineoff, kch, 1);
			} else {
				ch[0] = code & 0xff;
				XDrawString(display, target, gcfore,
					x, y - lineoff, ch, 1);
			}
#endif
			break;
		case O_ICON:
			if (obj->fore != fore) {
				fore = obj->fore;
				XSetForeground(display, gcfore, fore);
			}
			isize = obj->data.icon.isize;
			switch (obj->data.icon.itype) {
			case 1: /* this is box */
				XFillRectangle(display, target, gcfore, x, y,
					isize, isize);
				break;
			case 2: /* this is arc */
				XFillArc(display, target, gcfore, x, y,
					isize, isize, 0, 360 * 64);
				break;
			case 3: case 4: case 5: case 6:
			case 7:
				for (i = 0; i < obj->data.icon.npoint; i++) {
					obj->data.icon.xpoint[i].x += x;
					obj->data.icon.xpoint[i].y += y;
				}
				XFillPolygon(display, target, gcfore, 
					obj->data.icon.xpoint,
					obj->data.icon.npoint,
					Convex, CoordModeOrigin);
				break;
			}
			break;
		default:
			break;
		}
	}
	if (fore != fore_color[caching]){
		XSetForeground(display, gcfore, fore_color[caching]);
	}
	/* ASSERT(state->obj == NULL); */
	/* ASSERT(state->objlast == NULL); */
}

#ifdef VFLIB
static u_int
draw_onechar_vf(state, code, x, y, width, height)
	struct render_state *state;
	u_int code;
	int x, y;
	u_int width, height;
{
	struct vfont *vfc;

	vfc = vfc_get(code, width, height, 1);
	draw_line_itemsize(state, vfc->ascent, vfc->descent, 0);

	obj_new_vfont(state, x, y, vfc, height);
	return vfc->charlen;
}
#endif /* VFLIB */

/* gucOS port: X server fonts don't exist — the freetype engine
 * (tfont.c) is the only text path. x_setfont always fails over to it;
 * draw_onechar_x advances invisibly with a one-time warning (it is only
 * reached when freetype has no glyph at all). */
static XFontStruct *
x_setfont(xfont, csize, registry, truescalable)
	char *xfont;
	u_int csize;
	char *registry;
	int *truescalable;
{
	if (truescalable)
		*truescalable = 0;
	return NULL;
}

static u_int
draw_onechar_x(state, code, x, y, size, argregistry, lastchar)
	struct render_state *state;
	u_int code;
	int x, y;
	int size;
	char *argregistry;
	int lastchar;
{
	static int warned;

	if (!warned) {
		warned = 1;
		fprintf(stderr, "mgp: no freetype glyph for 0x%04x and no X "
		    "font fallback in this port -- check %%deffont/%%tfont\n",
		    code);
	}
	return size / 2;	/* keep the layout advancing */
}

/*
 * render misc items.
 */
static void
back_gradation(state, cg0)
	struct render_state *state;
	struct ctrl_grad *cg0;
{
	struct ctrl_grad cg1;
	struct ctrl_grad *cg;
	int srcwidth, srcheight;
	int dstwidth, dstheight;
	int dir, numcolor;
	float xzoomrate, yzoomrate;
	int hquality, vquality;

	Image *myimage, *image;
	Pixmap mypixmap;
	XImageInfo *ximageinfo;
	byte *pic;
	int private = mgp_flag & FL_PRIVATE;
	static Cursor curs;

	/* okay, please wait for a while... */
	if (!curs)
		curs = XCreateFontCursor(display, XC_watch);
	XDefineCursor(display, window, curs);
	XFlush(display);

	/* just for safety */
	memcpy(&cg1, cg0, sizeof(struct ctrl_grad));
	cg = &cg1;

	/* grab parameters */
	dir = cg->ct_direction;
	numcolor = cg->ct_numcolor;
	hquality = b_quality[caching];
	vquality = b_quality[caching];

	/*
	 * XXX zoomflag is too complex to understand.
	 */
	if (!cg->ct_zoomflag) {
		int t;
		int i;

		dstwidth = window_width * cg->ct_width / 100;
		dstheight = window_height * cg->ct_height / 100;
		srcwidth = dstwidth;
		srcheight = dstheight;

		/*
		 * apply quality factor if srcwidth/height are large enough.
		 */
#define TOOSMALLFACTOR 8
		t = srcwidth;
		for (i = 100; hquality < i; i--) {
			t = srcwidth * i / 100;
			if (t < cg->ct_g_colors * TOOSMALLFACTOR)
				break;
		}
		srcwidth = t;

		t = srcheight;
		for (i = 100; vquality < i; i--) {
			t = srcheight * i / 100;
			if (t < cg->ct_g_colors * TOOSMALLFACTOR)
				break;
		}
		srcheight = t;
#undef TOOSMALLFACTOR
	} else {
		dstwidth = window_width;
		dstheight = window_height;
		srcwidth = state->width * cg->ct_width / 100;
		srcheight = state->height * cg->ct_height / 100;

		/*
		 * we don't apply quality factor here, since srcwidth/height
		 * is already smaller than dstwidth/height.
		 */
	}

#if 0
	if (srcwidth * hquality / 100 < cg->ct_g_colors * TOOSMALLFACTOR
	 || srcheight * vquality / 100 < cg->ct_g_colors * TOOSMALLFACTOR) {
		srcwidth = srcwidth * hquality / 100;
		srcheight = srcheight * vquality / 100;
	}
#endif

	xzoomrate = 100.0 * dstwidth / srcwidth;
	yzoomrate = 100.0 * dstheight / srcheight;

	/* performace enhance hack for special case */
	if (dir % 90 == 0) {
		float *q;
		int *p, *r;

		/*
		 * 0 or 180: reduce width
		 * 90 or 270: reduce height
		 */
		p = (dir % 180 == 0) ? &srcwidth : &srcheight;
		q = (dir % 180 == 0) ? &xzoomrate : &yzoomrate;
		r = (dir % 180 == 0) ? &dstwidth : &dstheight;

		/* rely upon use X11 background image tiling. */
		*q = (float) 100.0;
#ifndef DITHERED_BGRAD
		*p = 1;
		*r = 1;
#else
		*p = 3;
		*r = 3;
#endif
	}

	if (verbose) {
		fprintf(stderr, "raw: %d,%d qu: %d,%d "
			"dst: %d,%d src: %d,%d zoom: %0.2f,%0.2f\n",
			cg->ct_width, cg->ct_height,
			hquality, vquality,
			dstwidth, dstheight, srcwidth, srcheight,
			xzoomrate, yzoomrate);
	}

	screen = DefaultScreen(display);

	/* make gradation image */
	pic = draw_gradation(srcwidth, srcheight, cg);
	myimage = make_XImage(pic, srcwidth, srcheight);

	if (numcolor < 64)
		myimage = reduce(myimage, numcolor, verbose);

	if (verbose) {
		fprintf(stderr, "background zoomrate: (%0.2f,%0.2f)\n",
			xzoomrate, yzoomrate);
		fprintf(stderr, "background zoom mode %d: "
			"(%d, %d)->(%d, %d)[%d]\n", cg->ct_zoomflag,
			srcwidth, srcheight, dstwidth, dstheight, b_quality);
	}

	if (xzoomrate != 100.0 || yzoomrate != 100.0) {
		image = myimage;
		myimage = zoom(image, xzoomrate, yzoomrate, verbose);
		if (!image) {
			fprintf(stderr, "image zoom (%0.2fx%0.2f) failed in back_gradataion\n",
				xzoomrate, yzoomrate);
			exit(1);
		}
		freeImage(image);
	}

#ifndef COLOR_BUGFIX
	if (private) free_alloc_colors(&back_clr);
#endif
	ximageinfo = imageToXImage(display, screen, visual, depth, myimage,
		private, 0, 1, verbose);
	if (!ximageinfo) {
		fprintf(stderr, "Cannot convert Image to XImage\n");
		cleanup(-1);
	}

	regist_background_pixmap(ximageinfo, myimage);

	XUndefineCursor(display, window);
	XFlush(display);
}


/* !TODO: move rotation code into some library */
/* rotate image by 90 degrees (counter clockwise) */
static void rotate_image_p90(image)
	Image *image;
{
	unsigned int row, column, pl = image->pixlen;
	unsigned int new_height = image->width, new_width = image->height, new_linelen = new_width * pl;
	byte *src, *tgt, *col_head;
	Pixel d;
	/* allocate buffer for new image */
	byte *rot_data = lmalloc(new_linelen * new_height);

	/* do the rotation */
	for (row = 0, src = image->data, col_head = rot_data + (new_height - 1) * new_linelen; 
			row < image->height; 
			row++, col_head += pl) {
		for (column = 0, tgt = col_head; 
				column < image->width; 
				column++, src += pl, tgt -= new_linelen) {
			d = memToVal(src, pl);
			valToMem(d, tgt, pl);
		}
	}

	/* swap to rotated image, exchange height and width
	   and point to rotated data */
	image->height = new_height;
	image->width = new_width;
	lfree(image->data);
	image->data = rot_data;
}


/* rotate image by -90 degrees (clockwise) */
static void rotate_image_m90(image)
Image *image;
{
	unsigned int row, column, pl = image->pixlen;
	unsigned int new_height = image->width, new_width = image->height, new_linelen = new_width * pl;
	byte *src, *tgt;
	Pixel d;
	/* allocate buffer for new image */
	byte *rot_data = lmalloc(new_linelen * new_height);

	/* do the rotation */
	for (row = 0, src = image->data; row < image->height; row++) {
		for (column = 0, tgt = rot_data + new_linelen - (row + 1) * pl; 
				column < image->width; 
				column++, src += pl, tgt += new_linelen) {
			d = memToVal(src, pl);
			valToMem(d, tgt, pl);
		}
	}

	/* swap to rotated image, exchange height and width
	   and point to rotated data */
	image->height = new_height;
	image->width = new_width;
	lfree(image->data);
	image->data = rot_data;

	return;
}


/* rotate image by 180 degrees */
static void rotate_image_180(image)
	Image *image;
{
	unsigned int row, column, pl = image->pixlen;
	unsigned int new_height = image->height, new_width = image->width, new_linelen = new_width * pl;
	byte *src, *tgt;
	Pixel d;
	/* allocate buffer for new image */
	byte *rot_data = lmalloc(new_linelen * new_height);

	/* do the rotation */
	for (row = 0, src = image->data; row < image->height; row++) {
		for (column = 0, tgt = rot_data + (new_height - row) * new_linelen - pl; 
				column < image->width; 
				column++, src += pl, tgt -= pl) {
			d = memToVal(src, pl);
			valToMem(d, tgt, pl);
		}
	}

	/* swap to rotated image, exchange height and width
	   and point to rotated data */
	image->height = new_height;
	image->width = new_width;
	lfree(image->data);
	image->data = rot_data;

	return;
}


static void
image_load(state, filename, numcolor, ximagesize, yimagesize, backflag, zoomflag, centerflag, raise, rotate, zoomonclk)
	struct render_state *state;
	char *filename;
	int numcolor;
	int ximagesize;
	int yimagesize;
	int backflag;
	int zoomflag;
	int centerflag;
	int raise;
	int rotate;
	int zoomonclk;
{
	Image *image, *myimage;
	Pixmap mypixmap;
	XImageInfo *ximageinfo;
	u_int image_posx;
	int width, height, yoffset;
	float xzoomrate, yzoomrate;
	int	private = mgp_flag & FL_PRIVATE;
	static Cursor curs;
	static char backfile[MAXPATHLEN];
	static int backzoom, backnumcolor, backx, backy;
#ifdef USE_IMLIB
	ImlibImage *imimage;
#endif

	if (!caching){
		if (!curs)
			curs = XCreateFontCursor(display, XC_watch);
		XDefineCursor(display, state->target, curs);
		XFlush(display);
	}

	if ((myimage = loadImage(filename, verbose)) == NULL) {
		fprintf(stderr, "failed to load image file\n");
		cleanup(-1);
	}
	switch (rotate) {
		case 0:
			/* Do nothing */
			break;
	
		case -90:
		case 270:
			rotate_image_m90(myimage);
			break;

		case 90:
			rotate_image_p90(myimage);
			break;

		case -180:
		case 180:
			rotate_image_180(myimage);
			break;

		default:
			fprintf(stderr, "rotation by %d degrees not supported.\n", rotate);
			cleanup(-1);
	}
	width = myimage->width;
	height = myimage->height;

	if (myimage->depth == 1 && myimage->trans < 0) {
		XColor xc;

		xc.flags = DoRed | DoGreen | DoBlue;
		xc.pixel = fore_color[caching];
		XQueryColor(display, colormap, &xc);
		*(myimage->rgb.red + 1) = xc.red;
		*(myimage->rgb.green + 1) = xc.green;
		*(myimage->rgb.blue + 1) = xc.blue;
		myimage->trans = 0;	/* call obj_image_trans() later */
	}

	if (numcolor)
		myimage = reduce(myimage, numcolor, verbose);

#if 0
	if (zoomflag == 2) {
		/*
		 * auto resize according to physical and desired screen size.
		 * allow 5% error for '-o' option.
		 */
		if (ximagesize == 0 || ximagesize == state->width)
			ximagesize = 100;
		else
			ximagesize = state->width * 100 / ximagesize;
		if (yimagesize == 0 || yimagesize == state->height)
			yimagesize = 100;
		else
			yimagesize = state->height * 100 / yimagesize;
		if (ximagesize > 95 && ximagesize < 105 &&
		    yimagesize > 95 && yimagesize < 105)
			ximagesize = yimagesize = 0;
	}
	if (ximagesize != 0) {
		if (!zoomflag)
			xzoomrate = state->width * ximagesize / width;
		else
			xzoomrate = ximagesize;
	} else
		xzoomrate = 100.0;
	if (yimagesize != 0) {
		if (!zoomflag)
			yzoomrate = state->height * yimagesize / height;
		else
			yzoomrate = yimagesize;
	} else
		yzoomrate = 100.0;
#else
	if (!ximagesize) ximagesize = 100;
	if (!yimagesize) yimagesize = 100;
	xzoomrate = (float) ximagesize;
	yzoomrate = (float) yimagesize;
	image_zoomratio(state, &xzoomrate, &yzoomrate, zoomflag, width, height);
#endif

	if (backflag) {
		if (xzoomrate != 100 || yzoomrate != 100) {
			image = myimage;
			myimage = zoom(image, xzoomrate, yzoomrate, verbose);
			if (!image) {
				fprintf(stderr, "image zoom (%dx%d) failed in image_load\n",
					xzoomrate, yzoomrate);
				exit(1);
			}
			freeImage(image);
		}

#ifndef COLOR_BUGFIX
		if (private) free_alloc_colors(&back_clr);
#endif
		ximageinfo= imageToXImage(display, screen, visual, depth,
				myimage, private, 0, 1, verbose);
		if (ximageinfo == NULL) {
			fprintf(stderr, "Cannot convert Image to XImage\n");
			cleanup(-1);
		}
		regist_background_pixmap(ximageinfo, myimage);
		goto end;
	}

#if 1  /* by h.kakugawa@computer.org */
	switch(valign){
	case VL_TOP:
		draw_line_itemsize(state, 
				   (height * raise) * yzoomrate / 10000,
				   height * (100 + raise) * yzoomrate / 10000, 0);
		break;
	case VL_BOTTOM:
		draw_line_itemsize(state, 
				   height * (100 + raise) * yzoomrate / 10000,
				   (height * raise) * yzoomrate / 10000, 0);
		break;
	case VL_CENTER:
		draw_line_itemsize(state, 
				   height * (100 + raise) * yzoomrate / 20000,
				   height * (100 + raise) * yzoomrate / 20000, 0);
		break;
	}
#else
	switch(valign){
	case VL_TOP:
		draw_line_itemsize(state, 0, height * yzoomrate / 100, 0);
		break;
	case VL_BOTTOM:
		draw_line_itemsize(state, height * yzoomrate / 100, 0, 0);
		break;
	case VL_CENTER:
		draw_line_itemsize(state, height * yzoomrate / 200, 
			height * yzoomrate / 200, 0);
		break;
	}
#endif

	if (centerflag)
		image_posx = char_size[caching] / 2 - (width * xzoomrate / 100) / 2;
	else
		image_posx = 0;

#ifdef USE_IMLIB
	imimage = search_imdata(filename);
	obj_new_image2(state, state->linewidth + image_posx,
		- height * yzoomrate / 100 / 2,
		myimage, xzoomrate, yzoomrate, imimage, zoomonclk);
#else
	obj_new_image(state, state->linewidth + image_posx,
		- height * yzoomrate / 100 / 2,
		myimage, xzoomrate, yzoomrate);
#endif

	state->linewidth += (width * xzoomrate / 100);
end:
	if (!caching){
		XUndefineCursor(display, state->target);
		XFlush(display);
	}
}

/* gucOS port: EPS inclusion ran an external ghostscript pipeline. */
static void
image_load_ps(state, filename, numcolor, ximagesize, yimagesize, backflag, zoomflag, centerflag, raise, rotate, zoomonclk)
	struct render_state *state;
	char *filename;
	int numcolor;
	int ximagesize;
	int yimagesize;
	int backflag;
	int zoomflag;
	int centerflag;
	int raise;
	int rotate;
	int zoomonclk;
{
	fprintf(stderr, "mgp: PostScript image \"%s\" skipped "
	    "(no ghostscript in this port)\n", filename);
}

void
timebar(state)
	struct render_state *state;
{
	int pos, n, p, barlen;
	GC pgc;

	if (t_start == 0 || tbar_mode == 0 || caching)
		return;

	pos = (window_width - 2) * (state->page - 1) / (maxpage - 1);
	p = time(NULL) - t_start;
	barlen = window_width - window_width * p / t_fin / 60;

	if (window_width / 2 < barlen)
		pgc = gcgreen;
	else if (window_width / 3 < barlen)
		pgc = gcyellow;
	else
		pgc = gcred;
	if (barlen > 0) {
		XClearArea(display, state->target, 0, window_height - 2,
			window_width, 2, 0);
		XFillRectangle(display, state->target, pgc,
			window_width - barlen, window_height - 1, barlen, 1);
		XFillRectangle(display, state->target, pgc,
			pos, window_height - 5, 2, 5);
	} else if (barlen < 0) {
		barlen = - barlen;
		n = p / t_fin / 60;
		if (n > window_height - 1)
			n = window_height - 1;
		if (n)
			XFillRectangle(display, state->target, gcred,
				0, window_height - n,
				barlen, n);
		XClearArea(display, state->target, 0, window_height - (n + 2),
			window_width, n + 2, 0);
		XFillRectangle(display, state->target, gcred,
			0, window_height - (n + 1),
			barlen % window_width, n + 1);
		XFillRectangle(display, state->target, gcred,
			pos, window_height - (n + 1 + 4),
			2, 5);
	}
}

static void
process_icon(state, cp)
	struct render_state *state;
	struct ctrl *cp;
{
	u_int i, icon_type, icon_size, icon_x, icon_y, index;
	u_long tmp_color;
	static struct ctl_words icon_words[] = {
		{ 1, 'x', "box", 3 },
		{ 2, 'x', "arc", 3 },
		{ 3, 'x', "delta1", 6 },
		{ 4, 'x', "delta2", 6 },
		{ 5, 'x', "delta3", 6 },
		{ 6, 'x', "delta4", 6 },
		{ 7, 'x', "dia", 3 },
		{ 0, 'x', NULL, 0 }
	};
	XPoint xpoint[4];
	static struct icon_point {
		int	point_num;
		XPoint xpoint[4];
	} icon_point[] = {{ 3, {{1, 0}, {0, 2}, {2, 2}, {0, 0}}},
			  { 3, {{0, 0}, {2, 0}, {1, 2}, {0, 0}}},
			  { 3, {{0, 0}, {0, 2}, {2, 1}, {0, 0}}},
			  { 3, {{2, 0}, {2, 2}, {0, 1}, {0, 0}}},
			  { 4, {{1, 0}, {0, 1}, {1, 2}, {2, 1}}}};
		
	for (i = 0; icon_words[i].ctl_strlen != 0; i++) {
		if (!strncasecmp(cp->ctic_value, icon_words[i].ctl_string,
			strlen(cp->ctic_value))) {
				break;
		}
	}

	icon_type = icon_words[i].ctl_type; /* may be 0 */
	icon_size = char_size[caching] * cp->ctic_size / 100;

	switch(icon_type){
	case 0:
		/* this is image */
		icon_x = icon_size * 100 / state->width;
		icon_y = icon_size * 100 / state->height;
		if (icon_x == 0) icon_x = 1;
		if (icon_y == 0) icon_y = 1;
		tmp_color = fore_color[caching];
		fore_color[caching] = cp->ctic_color;
		image_load(state, cp->ctic_value, 0, icon_x, icon_y, 0, 0, 1, 0, 0, 0);
		fore_color[caching] = tmp_color;
		break;

	case 1:
		/* this is box */
		obj_new_icon(state,
			state->linewidth + char_size[caching]/2 - icon_size/2,
			POSY(icon_size), icon_type, icon_size,
			cp->ctic_color, 0, NULL);
		state->linewidth += char_size[caching];
		break;

	case 2:
		/* this is arc */
		obj_new_icon(state,
			state->linewidth + char_size[caching]/2 - icon_size/2,
			POSY(icon_size), icon_type, icon_size, 
			cp->ctic_color, 0, NULL);
		state->linewidth += char_size[caching];
		break;

	case 3:
	case 4:
	case 5:
	case 6:
	case 7:
		index = icon_type - 3;
		icon_x = state->linewidth + (char_size[caching] - icon_size) / 2;
#if 0
		icon_y = POSY(icon_size);
#else
		icon_y = 0;
#endif
		for (i = 0; i < icon_point[index].point_num; i ++){
			xpoint[i].x = icon_x +
				icon_point[index].xpoint[i].x * icon_size / 2;
			xpoint[i].y = icon_y +
				icon_point[index].xpoint[i].y * icon_size / 2;
		}
		obj_new_icon(state, 0, 0, icon_type, icon_size, 
			cp->ctic_color, icon_point[index].point_num, xpoint);
		state->linewidth += char_size[caching];
		break;

	default:
		break;
	}

	cp = NULL;
	state->brankline = 0;
}

static void
draw_bar(state, cp)
	struct render_state *state;
	struct ctrl *cp;
{
	u_int width, swidth, st, len;
	XColor col, scol;
	static GC gcbar, gcsbar;
	static u_long prevcolor = -1;

	if (!gcbar) {
		gcbar = XCreateGC(display, state->target, 0, 0);
		XSetFunction(display, gcbar, GXcopy);
		gcsbar = XCreateGC(display, state->target, 0, 0);
		XSetFunction(display, gcsbar, GXcopy);
	}
	col.pixel = cp->ctb_color;
	if (col.pixel == -1)
		col.pixel = fore_color[caching];
	if (col.pixel != prevcolor) {
		prevcolor = col.pixel;
		col.flags = DoRed|DoGreen|DoBlue;
		XQueryColor(display, colormap, &col);
		scol.red   = col.red   / 2;
		scol.green = col.green / 2;
		scol.blue  = col.blue  / 2;
		if (!XAllocColor(display, colormap, &scol))
			scol.pixel = col.pixel;
		XSetForeground(display, gcbar, col.pixel);
		XSetForeground(display, gcsbar, scol.pixel);
	}
	width = cp->ctb_width * state->height / 1000;
	swidth = width / 2;
	width -= swidth;
	st = cp->ctb_start * state->width / 100 + state->xoff;
	len = cp->ctb_length * state->width / 100;
	XFillRectangle(display, state->target, gcbar, st, state->ypos + state->yoff, len, width);
	XFillRectangle(display, state->target, gcsbar, st, state->ypos + state->yoff + width, len, swidth);

	state->ypos += width + swidth + VERT_GAP(char_size[caching]) / 2;
	if (state->maxascent < width + swidth)
		state->maxascent = width + swidth;
	state->brankline = 0;
}

/* gucOS port: %system/%xsystem/%tsystem fork external (X) clients and
 * reparent their windows into the presentation — no X server here, and
 * fork() doesn't exist in this world. Decks still load; the directives
 * report themselves once. */
static void
process_system(state, cp)
	struct render_state *state;
	struct ctrl *cp;
{
	static int warned;

	if (!warned) {
		warned = 1;
		fprintf(stderr, "mgp: %%system directives are disabled "
		    "in this port\n");
	}
}

static void
process_xsystem(state, cp)
	struct render_state *state;
	struct ctrl *cp;
{
	process_system(state, cp);
}

static void
process_tsystem(state, cp)
	struct render_state *state;
	struct ctrl *cp;
{
	process_system(state, cp);
}

void
draw_reinit(state)
	struct render_state *state;
{
	/* invalidate the background image cache */

	bg_ctl_last = bg_ctl_cache = NULL;
	x_registerseed(state, NULL, NULL);
}

/* gucOS port: epstoimage (the gs pipeline) went with image_load_ps. */

static void
image_setcolor(state)
	struct render_state *state;
{
	struct render_object *obj;
	Image *image;
	int i;
	Intensity *red, *green, *blue;
	XColor fore, back;

	obj = state->objlast;
	if (obj->type != O_IMAGE)
		return;

	image = obj->data.image.image;
	if (image->trans >= 0)
		return;

	switch (image->type) {
	case IBITMAP:
		/*
		 * XXX: Actually, no one comes here.
		 *      This translation for IBITMAP was done by image_load().
		 */
		fore.pixel = fore_color[caching];
		fore.flags = DoRed | DoGreen | DoBlue;
		XQueryColor(display, colormap, &fore);
		image->rgb.red  [1] = fore.red;
		image->rgb.green[1] = fore.green;
		image->rgb.blue [1] = fore.blue;
		image->trans = 0;
		break;

	case IRGB:
		red   = image->rgb.red;
		green = image->rgb.green;
		blue  = image->rgb.blue;
		for (i = 0; i < image->rgb.used; i++) {
			if (red[i] != green[i] || red[i] != blue[i])
				return;
		}
		/* grayscale */

		fore.pixel = fore_color[caching];
		fore.flags = DoRed | DoGreen | DoBlue;
		XQueryColor(display, colormap, &fore);

		if (!COMPLEX_BGIMAGE) {
			back.pixel = back_color[caching];
			back.flags = DoRed | DoGreen | DoBlue;
			XQueryColor(display, colormap, &back);
		} else {
			int  x, y, bpl;
			byte *p;
			Pixel d;

			/* XXX: use background color of center position */
			x = (obj->x + image->width/2) % bgpixmap[bgindex].image->width;
			y = (state->ypos + image->height/2) 
					% bgpixmap[bgindex].image->height;
			bpl = bgpixmap[bgindex].image->pixlen;
			p = bgpixmap[bgindex].image->data 
				+ (bgpixmap[bgindex].image->width * y + x) * bpl;
			d = memToVal(p, bpl);
			if (bgpixmap[bgindex].image->type == ITRUE) {
				back.red   = TRUE_RED(d) << 8;
				back.green = TRUE_GREEN(d) << 8;
				back.blue  = TRUE_BLUE(d) << 8;
			} else {
				back.red   = bgpixmap[bgindex].image->rgb.red  [d];
				back.green = bgpixmap[bgindex].image->rgb.green[d];
				back.blue  = bgpixmap[bgindex].image->rgb.blue [d];
			}
		}
		for (i = 0; i < image->rgb.used; i++) {
			if (red[i] >= 65000)	/*XXX*/
				image->trans = i;
			red[i]   = (back.red   * red  [i]
				  + fore.red   * (65535-red  [i])) / 65535;
			green[i] = (back.green * green[i]
				  + fore.green * (65535-green[i])) / 65535;
			blue[i]  = (back.blue  * blue [i]
				  + fore.blue  * (65535-blue [i])) / 65535;
		}
		break;

	case ITRUE:
		/* XXX: assume background color is on the left right corner */
		image->trans = memToVal(image->data, image->pixlen);
	}
}

#ifdef FREETYPE
static u_int
draw_onechar_tf(state, code, x, y, size, registry, lastchar, charset16)
	struct render_state *state;
	u_int code;
	int x, y;
	u_int size;
	char *registry;
	int lastchar;
	int	charset16;
{
	struct tfont *tfc;
	int charlen;

	tfc = tfc_get(code, size, 1, registry, charset16);
	draw_line_itemsize(state, tfc->ascent, tfc->descent, 0);

	/* usually */
	charlen = tfc->charlen;

	/*
	 * for the very first char on the line, the char may goes over the
	 * edge at the lefthand side.  offset the image to the right so that
	 * whole part of the bitmap appears on the screen.
	 * beware the sign-ness of tfc->xoff.
	 */
	if (x + tfc->xoff < 0) {
		x -= tfc->xoff;
		charlen -= tfc->xoff;
	}

	/*
	 * For the last char, make sure that the whole part of the bitmap
	 * appears on the screen.
	 */
	if (lastchar && tfc->charlen < tfc->xoff + tfc->width)
		charlen += tfc->xoff + tfc->width - tfc->charlen;

	/*
	 * (x, y): left side, baseline of the font (FreeType font origin)
	 */
	obj_new_tfont(state, x, y, tfc);

	return charlen;
}
#endif /* FREETYPE */

static void
x_registerseed(state, seed, registry)
	struct render_state *state;
	char *seed;
	char *registry;
{
	char tmp1[BUFSIZ], tmp2[BUFSIZ];
	char *p;
	struct ctrl *cp;
	int hyphen;

	/* if both of arguments are NULL, initialize */
	if (!seed && !registry) {
		if (state->xfont)
			ctlfree(state->xfont);
		state->xfont = NULL;
		return;
	}

	if (!registry)
		registry = "iso8859-1";

	/* canonicalize seed */
	hyphen = 0;
	for (p = seed; *p; p++) {
		if (*p == '-')
			hyphen++;
		if (*p == ':') {
			hyphen = 0;
			break;
		}
	}
	switch (hyphen) {
	case 0:
		/* maybe alias, don't canonicalize */
		break;
	case 1:
		sprintf(tmp1, "%s-*", seed);
		seed = tmp1;
		break;
	case 2:
	case XLFD_HYPHEN:
		/* as is */
		break;
	default:
		fprintf(stderr, "invalid XFONT seed <%s>\n", seed);
		break;
	}

	/* canonicalize registry */
	if (!registry)
		registry = "iso8859-1";
	hyphen = 0;
	for (p = registry; *p; p++) {
		if (*p == '-')
			hyphen++;
	}
	switch (hyphen) {
	case 0:
		sprintf(tmp2, "%s-*", registry);
		registry = tmp2;
		break;
	case 1:
		/* as is */
		break;
	default:
		fprintf(stderr, "invalid XFONT registry <%s>\n", registry);
		exit(1);
	}

	cp = NULL;
	for (cp = state->xfont; cp; cp = cp->ct_next) {
		if (!cp->ctc2_value2) continue;
		if (strcmp(cp->ctc2_value2, registry) == 0)
			break;
	}
	if (cp) {
		if (!strcmp(cp->ctc2_value1, seed)) return;
		free(cp->ctc2_value1);
		cp->ctc2_value1 = strdup(seed);
	} else {
		cp = ctlalloc1(CTL_XFONT2);
		cp->ctc2_value1 = strdup(seed);
		cp->ctc2_value2 = strdup(registry);
		cp->ct_next = state->xfont;
		state->xfont = cp;
	}
}

static char *
x_findseed(state, registry)
	struct render_state *state;
	char *registry;
{
	struct ctrl *cp;

	if (!registry)
		registry = "iso8859-1";
	for (cp = state->xfont; cp; cp = cp->ct_next) {
		if (strcmp(cp->ctc2_value2, registry) == 0) {
			return cp->ctc2_value1;
		}
	}
	return "*-*-*";		/*anything, canonicalized*/
}

/* cache specified page */
static void
cache_page(state, page)
	struct render_state *state;
	int page;
{
	struct ctrl *tmp_bg_ctl;
	int tmp_bgindex;

	/* we don't need caching */
	if (cached_page == page || page > maxpage || page <= 0)
		return;

	if (!page_attribute[page].pg_linenum) return;

	XFlush(display);
	memset(state, 0, sizeof(struct render_state));
	state->target = cachewin;  /*XXX*/
	state->width = window_width;
	state->height = window_height;
	state->page = page;
	caching = 1;
	tmp_bg_ctl = bg_ctl;
	tmp_bgindex = bgindex;
	if (verbose){
		printf("now caching %d page ...\n", page);
		fflush(stdout);
	}
	draw_page(state, NULL);
	if (verbose){
		printf("caching done \n");
	}
	caching = 0;
	cached_page = page;
	bg_ctl = tmp_bg_ctl;
	bgindex = tmp_bgindex;
}

static void
set_from_cache(state)
	struct render_state *state;
{
	int	i;

	char_size[0] = char_size[1];
	horiz_gap[0] = horiz_gap[1];
	vert_gap[0] = vert_gap[1];
	fore_color[0] = fore_color[1];
	back_color[0] = back_color[1];
	ctrl_color[0] = ctrl_color[1];
	b_quality[0] = b_quality[1];

	memcpy(state, &cache_state, sizeof(struct render_state));	
	state->target = window;

	XSetForeground(display, gcfore, fore_color[0]);
	XSetBackground(display, gcfore, back_color[0]);
	bg_ctl = bg_ctl_last = bg_ctl_cache;
	if (bg_ctl){
		for (i = 0; i < MAXBGPIXMAP; i ++){
			if (bgpixmap[i].ctl && ctlcmp(bg_ctl, bgpixmap[i].ctl) == 0)
				bgindex = i;
		}
		set_background_pixmap(bg_ctl);
	}

	switch(cache_effect){
		case 1:
			cache_effect1();
			break;
		case 2:
			cache_effect2();
			break;
		default:
			break;
	}
	XCopyArea(display, cachewin, window, gc_cache, 
		0, 0, window_width, window_height, 0, 0);
	XFlush(display);
}

void
reset_background_pixmap()
{
	int	i = 0;

	bg_ctl_last = NULL;
	bg_ctl_cache = NULL;

	for (i = 0; i < MAXBGPIXMAP; i ++) {
		if (bgpixmap[i].image){
			XFreePixmap(display, bgpixmap[i].pixmap); 
			freeXImage(bgpixmap[i].image, bgpixmap[i].ximageinfo);
			freeImage(bgpixmap[i].image);
		}
		bgpixmap[i].ctl = NULL;
		bgpixmap[i].image = NULL;
		bgpixmap[i].ximageinfo = NULL;
	}
}

static void
cache_effect1()
{
	int x, step;

	step = cache_value ? window_width / cache_value : 1;
	if (!step) step = 1;

	for (x = window_width; x > step; x -= step){
		XCopyArea(display, window, window, gc_cache,
			step, 0,  window_width - step, window_height, 0, 0);

		XCopyArea(display, cachewin, window, gc_cache,
			window_width - x, 0, step, window_height, 
			window_width - step, 0);
#if 1
		XSync(display, False);
#else
		XFlush(display);
#endif
#if 1/*ONOE*/
	    { XEvent e;
		if (XCheckMaskEvent(display, ~NoEventMask, &e) == True) {
			printf("event type=%d\n", e.type);
			XPutBackEvent(display, &e);
			break;
		}
	    }
#endif
	}
}

static void
cache_effect2()
{
	int x, step;

	step = cache_value ? window_width / (cache_value * 2) : 1;
	if (!step) step = 1;

	for (x = 0; x < window_width; x += step){
		XCopyArea(display, window, window, gc_cache,
			x, 0,  window_width - step -x , window_height, x + step, 0);

		XCopyArea(display, cachewin, window, gc_cache,
			x, 0, step, window_height, x, 0);

		XFlush(display);
	}
}

/*
	pcache directive process
*/
static void
pcache_process(page)
int	page;
{
	if (!pcache.flag)
		return;

	if (pcache.page != page)
		return;

	if (pcache.mgpflag)
		mgp_flag |= FL_FRDCACHE;
	else 
		mgp_flag ^= FL_FRDCACHE;
	cache_mode   = pcache.mode;
	cache_effect = pcache.effect;
	cache_value  =  pcache.value;
	pcache.flag  = 0;
}


/*
	predraw: if this page contains texts only, 
			   draw page in pixmap once, then copy to window.
*/
static void
predraw(state)
	struct render_state *state;
{
	if (!caching && cached_page != state->page 
			&& page_attribute[state->page].pg_text
			&& page_attribute[state->page].pg_linenum){
		cache_page(&cache_state, state->page);
		set_from_cache(state);
		pcache_process(state->page);
	}
}


static void
get_background_pixmap(ctl, state)
	struct ctrl *ctl;
	struct render_state *state;
{
	int	i;

	/*
	 * check if background is already cached
	 */
	for (i = 0; i < MAXBGPIXMAP; i ++){
		if (bgpixmap[i].ctl && ctlcmp(ctl, bgpixmap[i].ctl) == 0){
			bgindex = i;
			return;			
		}
	}

	if (i == MAXBGPIXMAP){
		/* this background is not cached, we have to generate one */
		switch(ctl->ct_op){
		case CTL_BIMAGE: 
			image_load(state, ctl->ctm_fname, ctl->ctm_numcolor,
						ctl->ctm_ximagesize, ctl->ctm_yimagesize, 1,
						ctl->ctm_zoomflag, 0, 0, ctl->ctm_rotate, 0);
			break;
		case CTL_BGRAD:
			back_gradation(state, &ctl->ct_val.ctrl_grad);
			break;
		case CTL_BACK:
			break;
		default:
			fprintf(stderr, "fatal error in get_background_pixmap()\n");
			cleanup(-1);
			break;
		}
	}
}

static void
regist_background_pixmap(ximageinfo, image)
	XImageInfo	*ximageinfo;
	Image		*image;
{
	Pixmap	pixmap;
	int	i, j;

	/* search empty slot */	
	for (i = 0; i < MAXBGPIXMAP; i ++){
		if (bgpixmap[i].ctl == NULL)
			break;
	}

	if (i == MAXBGPIXMAP){
		/* no empty slot, we need to make one  */
		XFreePixmap(display, bgpixmap[MAXBGPIXMAP -1].pixmap); 
		freeXImage(bgpixmap[MAXBGPIXMAP -1].image, 
					bgpixmap[MAXBGPIXMAP -1].ximageinfo);
		freeImage(bgpixmap[MAXBGPIXMAP -1].image);
		for (j = MAXBGPIXMAP -2; j >= 0; j --){
			bgpixmap[j +1].ctl = bgpixmap[j].ctl;
			bgpixmap[j +1].pixmap = bgpixmap[j].pixmap;
			bgpixmap[j +1].image = bgpixmap[j].image;
			bgpixmap[j +1].ximageinfo = bgpixmap[j].ximageinfo;
		}
		bg_ctl_last = NULL;
		i = 0;
	}

	pixmap = ximageToPixmap(display, 
			RootWindow(display, screen), ximageinfo);
	bgpixmap[i].ctl = bg_ctl;
	bgpixmap[i].pixmap = pixmap;
	bgpixmap[i].image = image;
	bgpixmap[i].ximageinfo = ximageinfo;
	bgindex = i;
}

static void
set_background_pixmap(ctl)
	struct ctrl *ctl;
{
	int	i;

	switch(ctl->ct_op){
	case CTL_BIMAGE: 
	case CTL_BGRAD:
		for (i = 0; i < MAXBGPIXMAP; i ++){
			if (bgpixmap[i].ctl && ctlcmp(ctl, bgpixmap[i].ctl) == 0)
				break;	
		}
		if (i == MAXBGPIXMAP){
			fprintf(stderr, "fatal error in set_background_pixmap()\n");
			cleanup(-1);
		}
		XSetWindowBackgroundPixmap(display, window, bgpixmap[i].pixmap);
		break;
	case CTL_BACK:
		XSetWindowBackground(display, window, ctl->ctl_value);
		break;
	default:
		fprintf(stderr, "fatal error in set_background_pixmap() op=%d\n", 
			ctl->ct_op);
		cleanup(-1);
		break;
	}
}

/*
 * Clear target pixmap 
 */
static void
XClearPixmap(display, target)
	Display *display;
	Drawable target;
{
	int	i; 
	int x, y, width, height;
	XImage *xim;

	switch(bg_ctl->ct_op){
	case CTL_BIMAGE: 
	case CTL_BGRAD:
		for (i = 0; i < MAXBGPIXMAP; i ++){
			if (bgpixmap[i].ctl && ctlcmp(bg_ctl, bgpixmap[i].ctl) == 0)
				break;	
		}
		if (i == MAXBGPIXMAP){
			fprintf(stderr, "fatal error in XClearPixmap()\n");
			cleanup(-1);
		}

		xim = bgpixmap[i].ximageinfo->ximage;
		for (y = 0; y < window_height; y += xim->height)
			for (x = 0; x < window_width; x += xim->width)
				XPutImage(display, target, gc_cache, 
					xim, 0, 0, x, y, 
					xim->width, xim->height);
		break;
	case CTL_BACK:
		XSetForeground(display, gc_cache, bg_ctl->ctl_value);
		XFillRectangle(display, target,
			gc_cache, 0, 0, window_width, window_height);
		break;
	default:
		fprintf(stderr, "fatal error in XClearPixmap()\n");
		cleanup(-1);
		break;
	}
}

int
get_regid(registry)
    char *registry;
{
	char *p;

	if (!registry || registry[0] == '\0') return 0;
	if (strlen(registry) == 9 && !strncmp("iso8859-", registry, 8) &&
		registry[8] >= '1' && registry[8] <= '4') {
			p = registry + 8;
			return atoi(p) -1;
	} else
		return -1;
}

#ifdef MNG
int
obj_new_anim(state, x, y, width, height, filename, key)
    struct render_state *state;
    int x, y;
    int width, height;
    char *filename;
	void *key;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->type = O_ANIM;
	obj->data.anim.width = width;
	obj->data.anim.height = height;
	obj->data.anim.filename = strdup(filename);
	obj->data.anim.key = key;	/* for regchild */
	obj->ascent = 0;	/*XXX*/
	obj->descent = height;	/*XXX*/
	obj->vertloc = VL_CENTER;

	return 1;
}

static void
obj_draw_anim(state, x, y, obj)
    struct render_state *state;
	u_int x, y;
	struct render_object *obj;
{
	pid_t 	pid;

	if (!(pid = fork())){
		mngload(obj->data.anim.filename, x, y, 
			obj->data.anim.width, obj->data.anim.height);
		while(1) sleep(1);
	}
	regchild(pid, obj->data.anim.key, -1, state->page);
}

static void
process_anim(state, cp)
    struct render_state *state;
	struct ctrl *cp;
{
	int width, height;

	width = 200;
	height = 100;

	/*
	 * we support only mng so far
	 */
	mngpreload(state, cp->ctc_value, &width, &height);

	obj_new_anim(state, state->linewidth, - height, 
		width, height, cp->ctc_value, cp);

	switch(valign){
	case VL_TOP:
		draw_line_itemsize(state, 0, height, 0);
		break;
	case VL_BOTTOM:
		draw_line_itemsize(state, height, 0, 0);
		break;
	case VL_CENTER:
		draw_line_itemsize(state, height /2 , height /2, 0);
		break;
	}

	state->linewidth += width;
	state->brankline = 0;
}
#endif
#ifdef USE_XFT2
void
set_xrender_color(value, opaque)
		long value; 
		int opaque;
{	
	XColor xc;
	XRenderColor render_color;

	xft_forecolor.color.alpha = 65535 * opaque / 100;
	if (value == xft_forecolor.pixel) return;

	xc.flags = DoRed | DoGreen | DoBlue;
	xc.pixel = value;
	XQueryColor(display, colormap, &xc);

	xft_forecolor.pixel = value;
	xft_forecolor.color.red = xc.red;
	xft_forecolor.color.green = xc.green;
	xft_forecolor.color.blue = xc.blue;
}

static char *
xft_draw_fragment(state, p, len, registry, charset16)
	struct render_state *state;
	u_char *p;
	u_int len;
	char *registry;
	int charset16;	/*2-octet charset?*/
{
	XGlyphInfo extents;
	struct ctrl *cp;
	char *fontname = NULL;
	int i;
	static char etab[3][20] = { "iso-2022-jp", "gb2312", "ksc5601"};
	static char rtab[3][20] = { "jisx208", "gb2312", "ksc5601"};
	static char prefix[3][20] = { "\033$B", "\033$A", "\033$(C"};
	char buf16[1024], *p16;
	char out16[1024], *o16;
	int ileft, oleft;
#ifdef HAVE_ICONV
	static iconv_t icv[3];
#endif

	for (i = 0; i < len; i ++){
		if (!isspace(*(p + i))) state->brankline = 0; /* This isn't brankline */
	}
	if (!registry) registry = "iso8859-1";
	for (cp = state->xfont; cp; cp = cp->ct_next) {
		if (!cp->ctc2_value2) continue;
		if (strcmp(cp->ctc2_value2, registry) == 0) {
			fontname = cp->ctc2_value1;
			break;
		}
	}
	if (!fontname) return NULL;
	if (!(xft_font = xft_setfont(fontname, char_size[caching], registry))) return NULL;

	if (charset16) {
#ifdef HAVE_ICONV
		for (i = 0; i < 3; i ++) {
			if (!strncmp(registry, rtab[i], 3)) break;
		}
		if (i == 3) return NULL; /* cannot find codeset */
		sprintf(buf16, "%s%s\0", prefix[i], p);  	
		if (icv[i] == (iconv_t)0) icv[i] = iconv_open("UTF-8", etab[i]);
		if (icv[i] == (iconv_t)-1) {
			fprintf(stderr, "your iconv doesn't support %s\n",
			    etab[i]);
			return NULL;
		}
		p16 = buf16; o16 = out16; 	
		ileft = len + strlen(prefix[i]); oleft = sizeof(out16);
		if (iconv(icv[i], &p16, &ileft, &o16, &oleft) < 0) {
			perror("iconv");
			return NULL;
		}

		/* measure drawing are */
		XftTextExtentsUtf8(display, xft_font, (XftChar8 *)out16,
		    sizeof(out16) - oleft, &extents);

		/* line folding check */
		if (state->width - state->leftfillpos / 2 - state->linewidth <
		    extents.xOff) {
			draw_line_end(state);
			draw_line_start(state);
			state->linewidth = state->leftfillpos;
		}

		draw_line_itemsize(state, xft_font->ascent, xft_font->descent, 0);
		if (obj_new_xftfont(state, state->linewidth, 0, out16,
		    sizeof(out16) - oleft, fontname, registry,
		    char_size[caching], charset16, xft_font)) {
			state->linewidth += extents.xOff;
			return p + len;
		} else
#endif
			return NULL; 
	}

	XftTextExtents8(display, xft_font, (XftChar8 *)p, len, &extents);

	/* line folding check */
	if (state->width - state->leftfillpos / 2 - state->linewidth < extents.xOff) {
		if (isspace(*(p + len -1))) {
		    XftTextExtents8(display, xft_font, (XftChar8 *)p, len -1, &extents);
			if (state->width - state->leftfillpos / 2 - state->linewidth >= extents.xOff) goto nofolding;
			draw_line_end(state); 
		 	draw_line_start(state);
			state->linewidth = state->leftfillpos;
			return p;
		}

		for (i = 2; i < len; i ++){
			XftTextExtents8(display, xft_font, (XftChar8 *)p, len -i, &extents);
			if (state->width - state->leftfillpos / 2 - state->linewidth >= extents.xOff){
				len -= i;
				break;
			}
		}
		draw_line_itemsize(state, xft_font->ascent, xft_font->descent, 0);
		if (obj_new_xftfont(state, state->linewidth, state->charoff, p, len, fontname,
	   		registry, char_size[caching], charset16, xft_font)) {
			draw_line_end(state); 
		 	draw_line_start(state);
			state->linewidth = state->leftfillpos;
			return p +len;
		} else 
			return NULL;
	}

nofolding:

#if 1
	draw_line_itemsize(state, xft_font->ascent, xft_font->descent, 0);
#else
	draw_line_itemsize(state, extents.y, extents.height - extents.y, 0);
#endif

	if (obj_new_xftfont(state, state->linewidth, state->charoff, p, len, fontname,
	    registry, char_size[caching], charset16, xft_font)) {
		state->linewidth += extents.xOff;
		return p + len;
	} else
		return NULL; 
}

static int
obj_new_xftfont(state, x, y, p, len, fontname, registry, size, charset16, xft_font)
	struct render_state *state;
	int x, y;
	char *p;
	int len;
	char *fontname;
	char *registry;
	int size;
	int charset16;
	XftFont *xft_font;
{
	struct render_object *obj;
	char buf[65535], *p1;  

	p1 = buf;
	bzero(buf, sizeof(buf));
	if (sizeof(buf) > len)
		memcpy(buf, p, len);
	else
		return 0;

	obj = obj_alloc(state);
	if (obj == NULL)
		return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = fore_color[caching];
	obj->type = O_XTFONT;
	obj->data.xftfont.data = strdup(p1);
	obj->data.xftfont.fontname = strdup(fontname);
	obj->data.xftfont.registry = strdup(registry);
	obj->data.xftfont.len = len;
	obj->data.xftfont.size = size;
	obj->data.xftfont.charset16 = charset16;
	obj->ascent = xft_font->ascent;
	obj->descent = xft_font->descent;
	obj->vertloc = VL_BASE;
	return 1;
}

static XftDraw *
xft_getdraw(Drawable drawable) 
{
	int i;
	for (i = 0; i < 2; i ++) {
		if (xft_xdraw[i] == drawable)
			return xft_draw[i];
	}
	for (i = 0; i < 2; i ++) {
		if (!xft_xdraw[i])
			xft_draw[i] = XftDrawCreate(display, drawable, visual,
			    colormap);
		return xft_draw[i];
	}
	return NULL; /* should not happen */
}

static 
XftFont *
xft_setfont(xfontarg, csize, registry)
	char *xfontarg;
	int csize;
	char *registry;
{
	char *xfont;
	static XftFont *last_xftfont;
	static char lastfont[100];
	static int lastsize = 0;
	XftFont *xftfont;
	char *p, *p2;
	char style[100];
	char font[100];
	int stlen;

	bzero(style, sizeof(style));
	bzero(font, sizeof(font));

	xfont = strdup(xfontarg);
	if (!xfont)
		return NULL;

	if (!strcmp(xfont, lastfont) && lastsize == csize) {
		free(xfont);
		return last_xftfont;
	}

	if ((p = strchr(xfont, ':')) != NULL) {
		/*
		 * if xfont contsins ":", we believe this is a Xft font name
		 * with the style expression.
		 */
		p2 = p + 1;
		/* allow to use ":style=" syntax */
		if ((strstr(p2, "style=") != NULL) || (strstr(p2, "STYLE=") != NULL)) 
			p2 += 6;
		*p = '\0';
		strlcpy(font, xfont, sizeof(font));
		strlcpy(style, p2, sizeof(style));
	} else if ((p = strchr(xfont, '-')) != NULL) {
		/*
		 * if xfont contains "-", we believe this is a conventional
		 * xfont name and try to convert it for xft
		 */
		*p++ = 0;
		strlcpy(font, xfont, sizeof(font));
		if (strncmp(p, "bold-i", 6) == 0)
			strlcpy(style, "Bold Italic", sizeof(style));
		else if (strncmp(p, "bold-", 5) == 0)
			strlcpy(style, "Bold", sizeof(style));
		else if ((p = strchr(p, '-')) != NULL && p[1] == 'i')
			strlcpy(style, "Italic", sizeof(style));
	} else 
		strlcpy(font, xfont, sizeof(font));
	if (style[0]) {
		xftfont = XftFontOpen(display, screen,
		    XFT_FAMILY, XftTypeString, font,
		    XFT_ENCODING, XftTypeString, registry,
		    XFT_STYLE, XftTypeString, style,
		    XFT_PIXEL_SIZE, XftTypeDouble, (float)csize, 0);
	} else {
		xftfont = XftFontOpen(display, screen,
		    XFT_FAMILY, XftTypeString, font,
		    XFT_ENCODING, XftTypeString, registry,
		    XFT_PIXEL_SIZE, XftTypeDouble, (float)csize, 0);
	}
	if (xftfont == 0) {
		free(xfont);
		return NULL;
	}
	if (style[0])
		snprintf(lastfont, sizeof(lastfont), "%s:%s", font, style);
	else
		snprintf(lastfont, sizeof(lastfont), "%s", font);
	if (verbose) {
		fprintf(stderr, "using xftfont [%s] size: %d\n", lastfont,
		    csize);
	}
	lastsize = csize;
	last_xftfont = xftfont;
	free(xfont);
	return last_xftfont;
}
#endif
#ifdef USE_M17N
obj_new_mtext(state, x, y, mt, from, to, drawframe, ascent, descent)
	struct render_state *state;
	int x, y;
	MText *mt;
	int from, to;
	MFrame *drawframe;	
	int ascent, descent;
{
	struct render_object *obj;

	obj = obj_alloc(state);
	if (obj == NULL) return 0;
	obj->x = x;
	obj->y = y;
	obj->fore = fore_color[caching]; /* we don't need this */
	obj->type = O_M17NTEXT;
	obj->ascent = ascent;
	obj->descent = descent;
	obj->vertloc = VL_BASE;
	obj->data.m17ntext.mt = mt;
	m17n_object_ref (mt);
	obj->data.m17ntext.drawframe = drawframe;
	obj->data.m17ntext.from = from;
	obj->data.m17ntext.to = to;
	return 1;
}
#endif

#ifdef USE_IMLIB
void
regist_zimage_position(obj, x, y, width, height, page)
	struct render_object *obj;
	int x, y, width, height, page;
{
	int i;

	for (i = 0; i < ZIMAGENUM; i ++){
		/* already registered */
		if (zimage[i] == obj->data.image.imimage) return;
	}
	for (i = 0; i < ZIMAGENUM; i ++){
		if (!zimage[i]) break;
	}
	if (i == ZIMAGENUM) {
		fprintf(stderr, "Warning: too many images\n");
		return;
	}
	zimage[i] = obj->data.image.imimage;
	zonzoom[i] = obj->data.image.zoomonclk;
	zx[i] = x;
	zy[i] = y;
	zwidth[i] = width;
	zheight[i] = height;
	zpage[i] = page;
}

static void
clear_zimage(page)
	int page;
{
	int i;
	zoomin = 0;
	manage_pixmap((Pixmap)NULL, 0, page);
	for (i = 0; i < ZIMAGENUM; i ++){
		if (zpage[i] == page) zimage[i] = 0;
	}
}

int
search_zimage(x, y, page)
	int x, y, page;
{
	int i;
	for (i = 0; i < ZIMAGENUM; i ++){
		if (!zimage[i]) continue;
		if (zx[i] <= x && zx[i] + zwidth[i] >= x && 
		    zy[i] <= y && zy[i] + zheight[i] >= y && zpage[i] == page) {
			return i;
		}
	}
	return -1;
}

void
zoomin_zimage(id) 
	int id;
{
	Pixmap pixmap;
	int i, w, h, x, y, xf, yf;
	int ratio = 10; 
	float zstep = (window_width * zonzoom[id] / 100.0 - zwidth[id]) / (float)ratio;
	float xstep;
	float ystep;
	float xyratio = (float)zheight[id] / zwidth[id];

	xf = window_width * (100 - zonzoom[id]) / 200.0; 
	yf = (window_height - (window_width * zonzoom[id] / 100.0 * xyratio)) / 2;
	xstep = (float)(xf - zx[id]) / ratio;
	ystep = (float)(yf - zy[id]) / ratio;

	 for (i = 0; i <= ratio; i ++) {
		w = zstep * i + zwidth[id];	
		h = w * xyratio+1;
		x = zx[id] + xstep * i;
		y = zy[id] + ystep * i;
		pixmap = pixmap_fromimimage(zimage[id], w, h); 
		manage_pixmap(pixmap, 1, zpage[id]);
		if (i > 0) clear_region(id, i-1, i, 0); 
		XCopyArea(display, pixmap, window, gcfore, 0,0, w, h, x, y); 
		XFlush(display);
		if (i < ratio) usleep(10000);
	 }
}

void
zoomout_zimage(id) 
	int id;
{
	Pixmap pixmap;
	int i, w, h, x, y, xf, yf;
	int ratio = 10; 
	float zstep = (window_width * zonzoom[id] / 100.0 - zwidth[id]) / (float)ratio;
	float xstep;
	float ystep;
	float xyratio = (float)zheight[id] / zwidth[id];

	xf = window_width * (100 - zonzoom[id]) / 200.0; 
	yf = (window_height - (window_width * zonzoom[id] / 100.0 * xyratio)) / 2;
	xstep = (float)(xf - zx[id]) / ratio;
	ystep = (float)(yf - zy[id]) / ratio;

	for (i = ratio-1; i >= 0; i --) {
		w = zstep * i + zwidth[id];	
		h = w * xyratio+1;
		x = zx[id] + xstep * i;
		y = zy[id] + ystep * i;
		pixmap = pixmap_fromimimage(zimage[id], w, h); 
		manage_pixmap(pixmap, 1, zpage[id]);
		if (i < ratio) clear_region(id, i+1, i, 0);
		XCopyArea(display, pixmap, window, gcfore, 0, 0, w, h, x, y); 
		XFlush(display);
		if (i > 0) usleep(10000);
	}
	clear_region(id, ratio, 1, 1);
}

void
clear_region(id, prev, cur, clear)
	int id, prev, cur, clear;
{
	int i, w, h, x, y, xf, yf;
	int x1, x2, y1, y2, w1, w2, h1, h2;
	int ratio = 10; 
	float zstep = (window_width * zonzoom[id] / 100.0 - zwidth[id]) / (float)ratio;
	float xstep;
	float ystep;
	float xyratio = (float)zheight[id] / zwidth[id];

	if (prev > ratio) return;
	xf = window_width * (100 - zonzoom[id]) / 200.0; 
	yf = (window_height - (window_width * zonzoom[id] / 100.0 * xyratio)) / 2;
	xstep = (float)(xf - zx[id]) / ratio;
	ystep = (float)(yf - zy[id]) / ratio;

	x1 = zx[id] + xstep * prev;
	y1 = zy[id] + ystep * prev;
	w1 = zstep * prev + zwidth[id];	
	h1 = w1 * xyratio+1;

	x2 = zx[id] + xstep * cur;
	y2 = zy[id] + ystep * cur;
	w2 = zstep * cur + zwidth[id];	
	h2 = w2 * xyratio+1;

	if (x2 > x1) XClearArea(display, window, x1-1, y1, x2 - x1, h1, clear); 
	if (y2 > y1) XClearArea(display, window, x1, y1, w1, y2 -y1, clear); 
	if (x2 + w2 < x1 + w1) XClearArea(display, window, x2 + w2, y1, x1 + w1 - x2 - w2, h1, clear); 
	if (y2 + h2 < y1 + h1) XClearArea(display, window, x1, y2 + h2, w1, y1 + h1 - y2 - h2, clear); 
}
#endif
