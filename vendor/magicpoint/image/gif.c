/*
 * gif.c — GIF image loader for the gucOS MagicPoint port (todos/0119
 * giflib follow-up). A thin wrapper over the vendored giflib 5.2 decoder
 * (vendor/giflib), producing a truecolor Image the same way png.c does.
 *
 * Scope: STATIC GIFs — the first frame, decoded at its own dimensions and
 * mapped palette-index -> RGB into a newTrueImage. Multi-frame animation,
 * transparency compositing and sub-canvas frame offsets are out of scope
 * (the fork already descoped MNG animation); the first frame of an animated
 * GIF renders as a still, which is the intended behaviour here.
 *
 * The loader/identifier prototypes match imagetypes.c's function-pointer
 * table exactly (real prototypes — wasm typed calls need them).
 */
#ifdef USE_GIF

#include "image.h"
#include <string.h>
#include <gif_lib.h>

int
gifIdent(char *fullname, char *name)
{
	FILE *fp;
	char  hdr[6];
	int   ok;

	(void)name;
	if (!(fp = fopen(fullname, "rb"))) return 0;
	ok = (fread(hdr, 1, 6, fp) == 6) &&
	     (memcmp(hdr, "GIF87a", 6) == 0 || memcmp(hdr, "GIF89a", 6) == 0);
	fclose(fp);
	return ok;
}

Image *
gifLoad(char *fullname, char *name, unsigned int verbose)
{
	GifFileType    *gif;
	SavedImage     *frame;
	ColorMapObject *cmap;
	Image          *image;
	byte           *dst;
	int             err = 0, w, h, x, y, idx;

	(void)name;
	if (!gifIdent(fullname, fullname)) return NULL;

	gif = DGifOpenFileName(fullname, &err);
	if (!gif) {
		if (verbose)
			fprintf(stderr, "gifLoad: %s: %s\n", fullname, GifErrorString(err));
		return NULL;
	}
	if (DGifSlurp(gif) != GIF_OK || gif->ImageCount < 1) {
		if (verbose) fprintf(stderr, "gifLoad: %s: decode failed\n", fullname);
		DGifCloseFile(gif, &err);
		return NULL;
	}

	frame = &gif->SavedImages[0];
	cmap  = frame->ImageDesc.ColorMap ? frame->ImageDesc.ColorMap
	                                  : gif->SColorMap;
	if (!cmap) {
		if (verbose) fprintf(stderr, "gifLoad: %s: no palette\n", fullname);
		DGifCloseFile(gif, &err);
		return NULL;
	}
	w = frame->ImageDesc.Width;
	h = frame->ImageDesc.Height;
	if (verbose)
		fprintf(stderr, "gifLoad: [%s] %dx%d, %d colors, %d frame(s)\n",
		        fullname, w, h, cmap->ColorCount, gif->ImageCount);

	image = newTrueImage(w, h);
	dst = image->data;
	for (y = 0; y < h; y++) {
		for (x = 0; x < w; x++) {
			idx = frame->RasterBits[y * w + x];
			if (idx >= cmap->ColorCount) idx = 0;   /* clamp bad index */
			*dst++ = cmap->Colors[idx].Red;
			*dst++ = cmap->Colors[idx].Green;
			*dst++ = cmap->Colors[idx].Blue;
		}
	}

	DGifCloseFile(gif, &err);
	return image;
}

#endif /* USE_GIF */
