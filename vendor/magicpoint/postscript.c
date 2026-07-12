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
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE PROJECT OR CONTRIBUTORS BE LIABLER
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */
/*
 * $Id: postscript.c,v 1.9 1999/11/28 14:35:08 nishida Exp $
 */

#include "mgp.h"

int
ps_boundingbox(fname, px1, py1, px2, py2)
	char *fname;
	int *px1;
	int *py1;
	int *px2;
	int *py2;
{
	FILE *epsfp;
	char buf[BUFSIZ];
	int x1, y1, x2, y2;

	epsfp = NULL;
	epsfp = fopen(fname, "r");
	if (!epsfp) {
		fprintf(stderr, "failed to open postscript file %s\n", fname);
		goto fail;
	}

	/* magic number */
	if (fgets(buf, sizeof(buf), epsfp) == NULL) {
		fprintf(stderr, "error reading %s: file empty?\n", fname);
		goto fail;
	}
	if (buf[0] != '%' || buf[1] != '!') {
		fprintf(stderr, "%s is not a postscript file, it seems\n",
			fname);
		goto fail;
	}
	while (1) {
		if (fgets(buf, sizeof(buf), epsfp) == NULL)
			break;
		if (buf[0] != '%')
			break;
		if (strncmp(buf, "%%EndComments", 12) == 0)
			break;
		if (sscanf(buf, "%%%%BoundingBox: %d %d %d %d",
				&x1, &y1, &x2, &y2) == 4) {
			if (px1) *px1 = x1;
			if (py1) *py1 = y1;
			if (px2) *px2 = x2;
			if (py2) *py2 = y2;
			fclose(epsfp);
			return 0;
		}
	}

	fprintf(stderr, "No BoundingBox in %s\n", fname);
fail:
	if (epsfp)
		fclose(epsfp);
	return -1;
}

void
image_zoomratio(state, xp, yp, zoomflag, width, height)
	struct render_state *state;
	float *xp, *yp;
	int zoomflag;
	int width;	/* width of the image in file */
	int height;	/* height of the image in file */
{
	int xmode, ymode;
	double x, y;

	if (!xp || !yp) {
		fprintf(stderr, "internal error: "
			"invalid parameter to image_zoomratio\n");
		exit(1);
	}

	xmode = zoomflag & Z_XMASK;
	ymode = (zoomflag & Z_YMASK) >> Z_YSHIFT;

	if (mgp_flag & FL_VERBOSE) {
		char *xmodestr, *ymodestr;

		xmodestr = ymodestr = "?";
		switch (xmode) {
		case Z_ABSOLUTE: xmodestr = "abs"; break;
		case Z_NORMAL:	xmodestr = "asis"; break;
		case Z_SCREEN:	xmodestr = "screen"; break;
		case Z_SCREEN0:	xmodestr = "screen0"; break;
		case Z_OBEY:	xmodestr = "obey"; break;
		}
		switch (ymode) {
		case Z_ABSOLUTE: ymodestr = "abs"; break;
		case Z_NORMAL:	ymodestr = "asis"; break;
		case Z_SCREEN:	ymodestr = "screen"; break;
		case Z_SCREEN0:	ymodestr = "screen0"; break;
		case Z_OBEY:	ymodestr = "obey"; break;
		}

		fprintf(stderr, "computing zoom: screen=(%d,%d) "
			"image=(%d,%d) zoom param=(%0.2f/%s,%0.2f/%s)\n",
			state->width, state->height,
			width, height,
			*xp, xmodestr, *yp, ymodestr);
	}

	if (xmode == ymode && xmode == Z_OBEY) {
		fprintf(stderr, "internal error: "
			"x and y axis obey each other (ignore zoom factor)\n");
		return;
	}

	x = (double)*xp / 100;
	y = (double)*yp / 100;

	if (xmode == Z_OBEY)	/*DIRTY!*/
		goto yfirst;

	switch (xmode) {
	case Z_ABSOLUTE:
		x = (double)*xp / 100;
		break;
	case Z_NORMAL:	/* as is */
		break;
	case Z_SCREEN:	/* screen relative */
		x = x * state->width / width;
		break;
	case Z_SCREEN0:	/* original screen size specified */
		x = state->width / (double)*xp;
		break;
	default:
		fprintf(stderr, "wrong zooming mode for x axis %d\n", xmode);
		exit(1);
	}

yfirst:
	switch (ymode) {
	case Z_ABSOLUTE:
		y = (double)*yp / 100;
		break;
	case Z_NORMAL:
		break;
	case Z_SCREEN:
		y = y * state->height / height;
		break;
	case Z_SCREEN0:
		y = state->height / (double)*yp;
		break;
	case Z_OBEY:
		y = x;
		break;
	default:
		fprintf(stderr, "wrong zooming mode for y axis %d\n", ymode);
		exit(1);
	}

	if (xmode != Z_OBEY)
		goto finish;

	switch (xmode) {
	case Z_ABSOLUTE:
		x = 100 * x / width;
		break;
	case Z_NORMAL:	/* as is */
		break;
	case Z_SCREEN:	/* screen relative */
		x = state->width * x / width;
		break;
	case Z_SCREEN0:	/* original screen size specified */
		x = state->width / x;
		break;
	case Z_OBEY:
		x = y;
		break;
	default:
		fprintf(stderr, "wrong zooming mode for x axis %d\n", xmode);
		exit(1);
	}

finish:
	if (mgp_flag & FL_VERBOSE) {
		fprintf(stderr, "resulting zoom=(%f,%f)\n", x, y);
	}
	*xp = (float)(x * 100);
	*yp = (float)(y * 100);
}
