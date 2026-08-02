/* gdiplus.c — gdiplus-mini (ticket #94 / 0453). The 29 flat GDI+ entry
 * points derived from ReactOS shimgvw @ e3e58ac1, implemented over this
 * tree's decoders and gdi32.
 *
 * Layout of this file:
 *   1. GUID tables and the codec tables
 *   2. the image object and its pixel model
 *   3. the ONE decode entry point + the four format back ends
 *   4. draw
 *   5. transform
 *   6. encode / save
 *   7. frames + property items
 *   8. the flat API, in the header's order
 *
 * PIXEL MODEL. One format everywhere: uint32_t = R | G<<8 | B<<16 | A<<24,
 * which is gdi32's own bitmap word (gdi32.c bitmap_new), so handing pixels
 * to CreateBitmap is a memcpy and never a swizzle. Every decoder is
 * configured to produce exactly that:
 *   - libpng      : PNG_FORMAT_RGBA (byte order R,G,B,A)
 *   - libjpeg     : JCS_RGB, alpha filled 0xFF
 *   - libnsgif    : NSGIF_BITMAP_FMT_R8G8B8A8
 *   - libnsbmp    : writes R | G<<8 | B<<16 | A<<24 natively
 * All four coincide on a little-endian host, which wasm is.
 */

#include <windows.h>
#include <objbase.h>
#include <gdiplusflat.h>
#include "win32_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <png.h>
#include <jpeglib.h>
#include <setjmp.h>
#include <nsgif.h>
#include <libnsbmp.h>

/* Vendor knowledge stays with its consumer (source-lib design §4.2, the
 * gdi32.c/freetype rule): the in-OS link set for gdiplus is this TU plus
 * every decoder TU it calls into. Keep in sync with the `deps` of
 * os/win32/gdiplus.json — the require-drift gate in os/os-common.js
 * checks exactly that. */
__require_source("png/png.c");
__require_source("png/pngerror.c");
__require_source("png/pngget.c");
__require_source("png/pngmem.c");
__require_source("png/pngpread.c");
__require_source("png/pngread.c");
__require_source("png/pngrio.c");
__require_source("png/pngrtran.c");
__require_source("png/pngrutil.c");
__require_source("png/pngset.c");
__require_source("png/pngtrans.c");
__require_source("png/pngwio.c");
__require_source("png/pngwrite.c");
__require_source("png/pngwtran.c");
__require_source("png/pngwutil.c");
__require_source("z/adler32.c");
__require_source("z/compress.c");
__require_source("z/crc32.c");
__require_source("z/deflate.c");
__require_source("z/inflate.c");
__require_source("z/inftrees.c");
__require_source("z/inffast.c");
__require_source("z/trees.c");
__require_source("z/uncompr.c");
__require_source("z/zutil.c");
__require_source("jpeg/jaricom.c");
__require_source("jpeg/jcapimin.c");
__require_source("jpeg/jcapistd.c");
__require_source("jpeg/jcarith.c");
__require_source("jpeg/jccoefct.c");
__require_source("jpeg/jccolor.c");
__require_source("jpeg/jcdctmgr.c");
__require_source("jpeg/jchuff.c");
__require_source("jpeg/jcinit.c");
__require_source("jpeg/jcmainct.c");
__require_source("jpeg/jcmarker.c");
__require_source("jpeg/jcmaster.c");
__require_source("jpeg/jcomapi.c");
__require_source("jpeg/jcparam.c");
__require_source("jpeg/jcprepct.c");
__require_source("jpeg/jcsample.c");
__require_source("jpeg/jctrans.c");
__require_source("jpeg/jdapimin.c");
__require_source("jpeg/jdapistd.c");
__require_source("jpeg/jdarith.c");
__require_source("jpeg/jdatadst.c");
__require_source("jpeg/jdatasrc.c");
__require_source("jpeg/jdcoefct.c");
__require_source("jpeg/jdcolor.c");
__require_source("jpeg/jddctmgr.c");
__require_source("jpeg/jdhuff.c");
__require_source("jpeg/jdinput.c");
__require_source("jpeg/jdmainct.c");
__require_source("jpeg/jdmarker.c");
__require_source("jpeg/jdmaster.c");
__require_source("jpeg/jdmerge.c");
__require_source("jpeg/jdpostct.c");
__require_source("jpeg/jdsample.c");
__require_source("jpeg/jdtrans.c");
__require_source("jpeg/jerror.c");
__require_source("jpeg/jfdctflt.c");
__require_source("jpeg/jfdctfst.c");
__require_source("jpeg/jfdctint.c");
__require_source("jpeg/jidctflt.c");
__require_source("jpeg/jidctfst.c");
__require_source("jpeg/jidctint.c");
__require_source("jpeg/jquant1.c");
__require_source("jpeg/jquant2.c");
__require_source("jpeg/jutils.c");
__require_source("jpeg/jmemmgr.c");
__require_source("jpeg/jmemnobs.c");
__require_source("nsgif/gif.c");
__require_source("nsgif/lzw.c");
__require_source("nsbmp/libnsbmp.c");

/* ============================================================ 1. GUIDs */

const GUID ImageFormatUndefined =
    { 0xb96b3ca9, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatMemoryBMP =
    { 0xb96b3caa, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatBMP =
    { 0xb96b3cab, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatEMF =
    { 0xb96b3cac, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatWMF =
    { 0xb96b3cad, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatJPEG =
    { 0xb96b3cae, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatPNG =
    { 0xb96b3caf, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatGIF =
    { 0xb96b3cb0, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatTIFF =
    { 0xb96b3cb1, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatEXIF =
    { 0xb96b3cb2, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
const GUID ImageFormatIcon =
    { 0xb96b3cb5, 0x0728, 0x11d3, { 0x9d,0x7b,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };

const GUID FrameDimensionTime =
    { 0x6aedbd6d, 0x3fb5, 0x418a, { 0x83,0xa6,0x7f,0x45,0x22,0x9d,0xc8,0x72 } };
const GUID FrameDimensionResolution =
    { 0x84236f7b, 0x3bd3, 0x428f, { 0x8d,0xab,0x4e,0xa1,0x43,0x9c,0xa3,0x15 } };
const GUID FrameDimensionPage =
    { 0x7462dc86, 0x6180, 0x4c7e, { 0x8e,0x3f,0xee,0x73,0x33,0xa7,0xa4,0x83 } };

/* The real Windows codec CLSIDs, so a Clsid that crosses this boundary
 * still names the same codec anywhere else. */
static const CLSID k_clsidBMP =
    { 0x557cf400, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
static const CLSID k_clsidJPEG =
    { 0x557cf401, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
static const CLSID k_clsidGIF =
    { 0x557cf402, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
static const CLSID k_clsidPNG =
    { 0x557cf406, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };

/* ---- the codec tables (plan step 4: STATIC, not a plug-in registry) ----
 *
 * The lists are not decorative: shimgvw drives its Save-As filter and its
 * "which files in this folder can I browse" scan straight off them, so a
 * codec listed here is a PROMISE. The ENCODER list therefore holds only
 * BMP and PNG — the two formats GdipSaveImageToFile can really write
 * (0453 plan step 4). Listing JPEG as an encoder we cannot drive would be
 * exactly the silent-success failure this shim refuses. The consequence is
 * real and funded: shimgvw's "rotate and save" picks its filter index out
 * of THIS list, so it will refuse on a JPEG until ticket #379 lands one. */
typedef struct CodecDesc {
    const CLSID  *clsid;
    const GUID   *format;
    const WCHAR  *codecName;
    const WCHAR  *formatDescription;
    const WCHAR  *filenameExtension;
    const WCHAR  *mimeType;
    DWORD         flags;
} CodecDesc;

static const CodecDesc k_encoders[] = {
    { &k_clsidBMP, &ImageFormatBMP, u"Built-in BMP Codec", u"BMP",
      u"*.BMP;*.DIB;*.RLE", u"image/bmp",
      ImageCodecFlagsEncoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
    { &k_clsidPNG, &ImageFormatPNG, u"Built-in PNG Codec", u"PNG",
      u"*.PNG", u"image/png",
      ImageCodecFlagsEncoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
};

static const CodecDesc k_decoders[] = {
    { &k_clsidBMP, &ImageFormatBMP, u"Built-in BMP Codec", u"BMP",
      u"*.BMP;*.DIB;*.RLE", u"image/bmp",
      ImageCodecFlagsDecoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
    { &k_clsidJPEG, &ImageFormatJPEG, u"Built-in JPEG Codec", u"JPEG",
      u"*.JPG;*.JPEG;*.JPE;*.JFIF", u"image/jpeg",
      ImageCodecFlagsDecoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
    { &k_clsidGIF, &ImageFormatGIF, u"Built-in GIF Codec", u"GIF",
      u"*.GIF", u"image/gif",
      ImageCodecFlagsDecoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
    { &k_clsidPNG, &ImageFormatPNG, u"Built-in PNG Codec", u"PNG",
      u"*.PNG", u"image/png",
      ImageCodecFlagsDecoder | ImageCodecFlagsSupportBitmap | ImageCodecFlagsBuiltin },
};

#define ENCODER_COUNT ((UINT)(sizeof k_encoders / sizeof k_encoders[0]))
#define DECODER_COUNT ((UINT)(sizeof k_decoders / sizeof k_decoders[0]))

/* ============================================================ 2. objects */

struct GpImage {
    UINT       w, h;
    UINT       frameCount;
    UINT       activeFrame;
    uint32_t **frames;      /* frameCount buffers, each w*h pixels */
    UINT      *delays;      /* centiseconds per frame, or NULL */
    UINT       loopCount;   /* 0 = forever; GDIP_NO_LOOP = the file said nothing */
    GUID       rawFormat;
    UINT       flags;
    int        animated;    /* frame dimension is Time rather than Page */
};

#define GDIP_NO_LOOP ((UINT)-1)

struct GpGraphics {
    HDC               hdc;
    InterpolationMode interpolation;
    SmoothingMode     smoothing;
    int               warnedInterp;   /* one line per graphics, not per frame */
    int               warnedAlpha;
};

struct GpImageAttributes {
    WrapMode wrap;
    ARGB     argb;
    BOOL     clamp;
};

static int g_startupCount;

/* GDI+ refuses everything before GdiplusStartup; so does this. */
#define REQUIRE_STARTED() do {                                            \
        if (g_startupCount <= 0) {                                        \
            WIN32_UNSUPPORTED("gdiplus call before GdiplusStartup");       \
            return GdiplusNotInitialized;                                 \
        }                                                                 \
    } while (0)

static void image_free(GpImage *img) {
    if (!img) return;
    if (img->frames) {
        for (UINT i = 0; i < img->frameCount; i++) free(img->frames[i]);
        free(img->frames);
    }
    free(img->delays);
    free(img);
}

/* Alpha bookkeeping: HasAlpha says the pixels CAN carry alpha, and
 * HasTranslucent says at least one really does. shimgvw draws its
 * checkerboard on either. */
static void image_scan_alpha(GpImage *img, int formatHasAlpha) {
    img->flags = ImageFlagsColorSpaceRGB | ImageFlagsReadOnly;
    if (!formatHasAlpha) return;
    img->flags |= ImageFlagsHasAlpha;
    for (UINT f = 0; f < img->frameCount; f++) {
        const uint32_t *p = img->frames[f];
        for (UINT i = 0, n = img->w * img->h; i < n; i++) {
            if ((p[i] >> 24) != 0xFF) { img->flags |= ImageFlagsHasTranslucent; return; }
        }
    }
}

static GpImage *image_new(UINT w, UINT h, UINT frames) {
    if (!w || !h || !frames) return NULL;
    GpImage *img = (GpImage *)calloc(1, sizeof *img);
    if (!img) return NULL;
    img->frames = (uint32_t **)calloc(frames, sizeof *img->frames);
    if (!img->frames) { free(img); return NULL; }
    for (UINT i = 0; i < frames; i++) {
        img->frames[i] = (uint32_t *)calloc((size_t)w * h, 4);
        if (!img->frames[i]) { img->frameCount = i; image_free(img); return NULL; }
    }
    img->w = w;
    img->h = h;
    img->frameCount = frames;
    img->loopCount = GDIP_NO_LOOP;
    img->rawFormat = ImageFormatUndefined;
    return img;
}

/* ============================================================ 3. decode */

/* ---- PNG (libpng simplified read) ---- */

static GpStatus decode_png(const BYTE *data, size_t size, GpImage **out) {
    png_image pi;
    memset(&pi, 0, sizeof pi);
    pi.version = PNG_IMAGE_VERSION;
    if (!png_image_begin_read_from_memory(&pi, data, size))
        return GenericError;                 /* corrupt stream: the can-fail path */
    int hasAlpha = (pi.format & PNG_FORMAT_FLAG_ALPHA) != 0;
    pi.format = PNG_FORMAT_RGBA;
    GpImage *img = image_new(pi.width, pi.height, 1);
    if (!img) { png_image_free(&pi); return OutOfMemory; }
    if (!png_image_finish_read(&pi, NULL, img->frames[0], 0, NULL)) {
        png_image_free(&pi);
        image_free(img);
        return GenericError;
    }
    img->rawFormat = ImageFormatPNG;
    image_scan_alpha(img, hasAlpha);
    *out = img;
    return Ok;
}

/* ---- JPEG (IJG libjpeg; longjmp error manager, never exit()) ---- */

struct jpeg_err_jump { struct jpeg_error_mgr mgr; jmp_buf jb; };

static void jpeg_bail(j_common_ptr ci) {
    longjmp(((struct jpeg_err_jump *)ci->err)->jb, 1);
}

static GpStatus decode_jpeg(const BYTE *data, size_t size, GpImage **out) {
    struct jpeg_decompress_struct ci;
    struct jpeg_err_jump je;
    GpImage *img = NULL;
    JSAMPLE *row = NULL;

    ci.err = jpeg_std_error(&je.mgr);
    je.mgr.error_exit = jpeg_bail;
    if (setjmp(je.jb)) {
        jpeg_destroy_decompress(&ci);
        free(row);
        image_free(img);
        return GenericError;                 /* corrupt stream: the can-fail path */
    }
    jpeg_create_decompress(&ci);
    jpeg_mem_src(&ci, (unsigned char *)data, (unsigned long)size);
    jpeg_read_header(&ci, TRUE);
    ci.out_color_space = JCS_RGB;
    jpeg_start_decompress(&ci);

    img = image_new(ci.output_width, ci.output_height, 1);
    if (!img) { longjmp(je.jb, 1); }
    row = (JSAMPLE *)malloc((size_t)ci.output_width * 3);
    if (!row) { longjmp(je.jb, 1); }

    while (ci.output_scanline < ci.output_height) {
        UINT y = ci.output_scanline;
        JSAMPROW rows[1];
        rows[0] = row;
        jpeg_read_scanlines(&ci, rows, 1);
        uint32_t *dst = img->frames[0] + (size_t)y * img->w;
        for (UINT x = 0; x < img->w; x++)
            dst[x] = (uint32_t)row[x * 3] | ((uint32_t)row[x * 3 + 1] << 8) |
                     ((uint32_t)row[x * 3 + 2] << 16) | 0xFF000000u;
    }
    jpeg_finish_decompress(&ci);
    jpeg_destroy_decompress(&ci);
    free(row);
    img->rawFormat = ImageFormatJPEG;
    image_scan_alpha(img, 0);
    *out = img;
    return Ok;
}

/* ---- GIF (libnsgif; every frame decoded up front) ---- */

typedef struct GifBmp { int w, h; uint32_t *px; } GifBmp;

static nsgif_bitmap_t *gif_bmp_create(int w, int h) {
    GifBmp *b = (GifBmp *)calloc(1, sizeof *b);
    if (!b) return NULL;
    b->px = (uint32_t *)calloc((size_t)w * h, 4);
    if (!b->px) { free(b); return NULL; }
    b->w = w; b->h = h;
    return b;
}
static void gif_bmp_destroy(nsgif_bitmap_t *bitmap) {
    GifBmp *b = (GifBmp *)bitmap;
    if (!b) return;
    free(b->px);
    free(b);
}
static uint8_t *gif_bmp_get_buffer(nsgif_bitmap_t *bitmap) {
    return (uint8_t *)((GifBmp *)bitmap)->px;
}

static GpStatus decode_gif(const BYTE *data, size_t size, GpImage **out) {
    static const nsgif_bitmap_cb_vt vt = {
        .create = gif_bmp_create,
        .destroy = gif_bmp_destroy,
        .get_buffer = gif_bmp_get_buffer,
    };
    nsgif_t *gif = NULL;
    if (nsgif_create(&vt, NSGIF_BITMAP_FMT_R8G8B8A8, &gif) != NSGIF_OK)
        return OutOfMemory;
    if (nsgif_data_scan(gif, size, data) != NSGIF_OK) {
        /* A truncated GIF can still carry usable leading frames, which is
         * why nsgif reports and continues; but if the header never landed
         * there is no image at all. */
        const nsgif_info_t *probe = nsgif_get_info(gif);
        if (!probe || probe->frame_count == 0) {
            nsgif_destroy(gif);
            return GenericError;             /* corrupt stream: the can-fail path */
        }
    }
    nsgif_data_complete(gif);

    const nsgif_info_t *info = nsgif_get_info(gif);
    if (!info || info->frame_count == 0 || !info->width || !info->height) {
        nsgif_destroy(gif);
        return GenericError;
    }
    GpImage *img = image_new(info->width, info->height, info->frame_count);
    if (!img) { nsgif_destroy(gif); return OutOfMemory; }
    img->delays = (UINT *)calloc(info->frame_count, sizeof(UINT));
    if (!img->delays) { image_free(img); nsgif_destroy(gif); return OutOfMemory; }

    UINT decoded = 0;
    for (UINT f = 0; f < img->frameCount; f++) {
        nsgif_bitmap_t *bm = NULL;
        if (nsgif_frame_decode(gif, f, &bm) != NSGIF_OK || !bm) break;
        memcpy(img->frames[f], ((GifBmp *)bm)->px, (size_t)img->w * img->h * 4);
        const nsgif_frame_info_t *fi = nsgif_get_frame_info(gif, f);
        img->delays[f] = fi ? fi->delay : 0;
        decoded = f + 1;
    }
    if (decoded == 0) {
        image_free(img);
        nsgif_destroy(gif);
        return GenericError;
    }
    /* Truncated tail: keep what really decoded rather than serve zeroed
     * frames that would look like a legitimately blank animation. */
    for (UINT f = decoded; f < img->frameCount; f++) free(img->frames[f]);
    img->frameCount = decoded;

    /* libnsgif normalises the NETSCAPE "repeat N more times" byte into a
     * "play N+1 times" count (src/gif.c: `if (loop_max > 0) loop_max++`)
     * and defaults it to 1 when the extension is ABSENT. GDI+ reports the
     * file's own number and has no property at all when the extension is
     * missing, so unwind both: 0 stays 0 (forever), 1 means "no extension"
     * -> no property, and anything else is loop_max-1. */
    img->loopCount = (info->loop_max == 1) ? GDIP_NO_LOOP
                   : (info->loop_max <= 0) ? 0u
                   : (UINT)(info->loop_max - 1);
    img->animated = img->frameCount > 1;
    img->rawFormat = ImageFormatGIF;
    image_scan_alpha(img, 1);
    nsgif_destroy(gif);
    *out = img;
    return Ok;
}

/* ---- BMP (libnsbmp) ---- */

typedef struct BmpBmp { int w, h; uint32_t *px; } BmpBmp;

static void *bmp_bmp_create(int w, int h, unsigned int state) {
    (void)state;
    BmpBmp *b = (BmpBmp *)calloc(1, sizeof *b);
    if (!b) return NULL;
    b->px = (uint32_t *)calloc((size_t)w * h, 4);
    if (!b->px) { free(b); return NULL; }
    b->w = w; b->h = h;
    return b;
}
static void bmp_bmp_destroy(void *bitmap) {
    BmpBmp *b = (BmpBmp *)bitmap;
    if (!b) return;
    free(b->px);
    free(b);
}
static unsigned char *bmp_bmp_get_buffer(void *bitmap) {
    return (unsigned char *)((BmpBmp *)bitmap)->px;
}

static GpStatus decode_bmp(const BYTE *data, size_t size, GpImage **out) {
    bmp_bitmap_callback_vt cb;
    cb.bitmap_create = bmp_bmp_create;
    cb.bitmap_destroy = bmp_bmp_destroy;
    cb.bitmap_get_buffer = bmp_bmp_get_buffer;

    bmp_image bmp;
    memset(&bmp, 0, sizeof bmp);
    if (bmp_create(&bmp, &cb) != BMP_OK) return OutOfMemory;
    if (bmp_analyse(&bmp, size, (uint8_t *)data) != BMP_OK) {
        bmp_finalise(&bmp);
        return GenericError;                 /* corrupt stream: the can-fail path */
    }
    if (bmp_decode(&bmp) != BMP_OK || !bmp.bitmap) {
        bmp_finalise(&bmp);
        return GenericError;
    }
    GpImage *img = image_new(bmp.width, bmp.height, 1);
    if (!img) { bmp_finalise(&bmp); return OutOfMemory; }
    memcpy(img->frames[0], ((BmpBmp *)bmp.bitmap)->px,
           (size_t)img->w * img->h * 4);
    bmp_finalise(&bmp);
    /* A 32bpp BMP may carry an alpha channel; libnsbmp forces 0xFF when
     * it decides the image is opaque, so scanning is the honest test. */
    img->rawFormat = ImageFormatBMP;
    image_scan_alpha(img, 1);
    *out = img;
    return Ok;
}

/* ---- the ONE decode entry point (plan step 2) ----
 * Format is decided by SIGNATURE, never by a filename: GdipLoadImageFrom-
 * Stream has no name to look at, and a viewer must not be fooled by a
 * .png that is really a JPEG. */
static GpStatus decode_memory(const BYTE *data, size_t size, GpImage **out) {
    if (!data || !out) return InvalidParameter;
    *out = NULL;
    if (size >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' &&
        data[3] == 'G' && data[4] == 0x0D && data[5] == 0x0A &&
        data[6] == 0x1A && data[7] == 0x0A)
        return decode_png(data, size, out);
    if (size >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
        return decode_jpeg(data, size, out);
    if (size >= 6 && memcmp(data, "GIF8", 4) == 0 &&
        (data[4] == '7' || data[4] == '9') && data[5] == 'a')
        return decode_gif(data, size, out);
    if (size >= 2 && data[0] == 'B' && data[1] == 'M')
        return decode_bmp(data, size, out);
    /* Deliberately NOT guessed at. ICO/CUR in particular reaches GDI+ on
     * Windows (shimgvw's loader.cpp rewrites a .cur header into an .ico
     * and hands the container straight through), and this shim does not
     * decode it yet — ticket #379 funds it. Until then it is a loud
     * refusal, not a blank window. */
    WIN32_UNSUPPORTED("gdiplus decode: unrecognised image signature "
                      "(%02X %02X %02X %02X)",
                      size > 0 ? data[0] : 0, size > 1 ? data[1] : 0,
                      size > 2 ? data[2] : 0, size > 3 ? data[3] : 0);
    return UnknownImageFormat;
}

/* ============================================================ 4. draw */

static int round_to_int(REAL v) {
    return (int)floorf((float)v + 0.5f);
}

/* Wrap the active frame as a gdi32 memory DC. The bitmap is a COPY (gdi32
 * CreateBitmap memcpys), which is also what keeps StretchBlt off its
 * same-surface refusal: source and destination are always different
 * buffers, whatever the caller's DC happens to be. */
static HDC frame_dc(GpImage *img, HBITMAP *outBm, HGDIOBJ *outOld) {
    HBITMAP bm = CreateBitmap((int)img->w, (int)img->h, 1, 32,
                              img->frames[img->activeFrame]);
    if (!bm) return NULL;
    HDC dc = CreateCompatibleDC(NULL);
    if (!dc) { DeleteObject(bm); return NULL; }
    *outOld = SelectObject(dc, bm);
    *outBm = bm;
    return dc;
}

/* ============================================================ 5. transform */

/* `quarters` clockwise turns, then an optional horizontal flip — GDI+'s
 * RotateFlipType is exactly (rotation | flipX) and is applied in that
 * order. Returns a fresh buffer; *ow/*oh get the new extent. */
static uint32_t *rotate_flip_frame(const uint32_t *src, UINT w, UINT h,
                                   int quarters, int flipX,
                                   UINT *ow, UINT *oh) {
    UINT nw = (quarters & 1) ? h : w;
    UINT nh = (quarters & 1) ? w : h;
    uint32_t *dst = (uint32_t *)malloc((size_t)nw * nh * 4);
    if (!dst) return NULL;
    for (UINT y = 0; y < h; y++) {
        for (UINT x = 0; x < w; x++) {
            UINT dx, dy;
            switch (quarters) {
            case 1:  dx = nw - 1 - y; dy = x;            break;  /*  90 CW */
            case 2:  dx = w - 1 - x;  dy = h - 1 - y;    break;  /* 180    */
            case 3:  dx = y;          dy = nh - 1 - x;   break;  /* 270 CW */
            default: dx = x;          dy = y;            break;
            }
            if (flipX) dx = nw - 1 - dx;
            dst[(size_t)dy * nw + dx] = src[(size_t)y * w + x];
        }
    }
    *ow = nw;
    *oh = nh;
    return dst;
}

/* ============================================================ 6. encode */

static int utf16_to_utf8(const WCHAR *w, char *out, int cap) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, out, cap, NULL, NULL);
    return n > 0;
}

static GpStatus encode_png_file(GpImage *img, const char *path) {
    png_image pi;
    memset(&pi, 0, sizeof pi);
    pi.version = PNG_IMAGE_VERSION;
    pi.width = img->w;
    pi.height = img->h;
    pi.format = PNG_FORMAT_RGBA;
    if (!png_image_write_to_file(&pi, path, 0,
                                 img->frames[img->activeFrame], 0, NULL))
        return GenericError;
    return Ok;
}

static void put_le32(BYTE *p, uint32_t v) {
    p[0] = (BYTE)(v); p[1] = (BYTE)(v >> 8);
    p[2] = (BYTE)(v >> 16); p[3] = (BYTE)(v >> 24);
}
static void put_le16(BYTE *p, uint32_t v) {
    p[0] = (BYTE)(v); p[1] = (BYTE)(v >> 8);
}

/* 32bpp BI_RGB, bottom-up — the plainest BMP that round-trips through our
 * own decoder and through every other reader. */
static GpStatus encode_bmp_file(GpImage *img, const char *path) {
    UINT w = img->w, h = img->h;
    size_t pixBytes = (size_t)w * h * 4;
    BYTE hdr[54];
    memset(hdr, 0, sizeof hdr);
    hdr[0] = 'B'; hdr[1] = 'M';
    put_le32(hdr + 2, (uint32_t)(54 + pixBytes));
    put_le32(hdr + 10, 54);
    put_le32(hdr + 14, 40);
    put_le32(hdr + 18, w);
    put_le32(hdr + 22, h);                 /* positive: bottom-up */
    put_le16(hdr + 26, 1);
    put_le16(hdr + 28, 32);
    put_le32(hdr + 30, 0);                 /* BI_RGB */
    put_le32(hdr + 34, (uint32_t)pixBytes);

    FILE *f = fopen(path, "wb");
    if (!f) return Win32Error;
    if (fwrite(hdr, 1, sizeof hdr, f) != sizeof hdr) { fclose(f); return Win32Error; }
    const uint32_t *px = img->frames[img->activeFrame];
    BYTE *row = (BYTE *)malloc((size_t)w * 4);
    if (!row) { fclose(f); return OutOfMemory; }
    for (UINT y = 0; y < h; y++) {
        const uint32_t *src = px + (size_t)(h - 1 - y) * w;
        for (UINT x = 0; x < w; x++) {
            uint32_t v = src[x];
            row[x * 4 + 0] = (BYTE)(v >> 16);   /* B */
            row[x * 4 + 1] = (BYTE)(v >> 8);    /* G */
            row[x * 4 + 2] = (BYTE)(v);         /* R */
            row[x * 4 + 3] = (BYTE)(v >> 24);   /* A */
        }
        if (fwrite(row, 1, (size_t)w * 4, f) != (size_t)w * 4) {
            free(row); fclose(f); return Win32Error;
        }
    }
    free(row);
    return fclose(f) == 0 ? Ok : Win32Error;
}

/* ============================================================ 7. frames */

static const GUID *image_dimension(GpImage *img) {
    return img->animated ? &FrameDimensionTime : &FrameDimensionPage;
}

/* GDI+ reports the buffer a caller must allocate for GdipGetPropertyItem:
 * the PropertyItem header PLUS its value bytes, in one block. */
static UINT property_value_bytes(GpImage *img, PROPID id) {
    if (id == PropertyTagFrameDelay)
        return img->delays ? img->frameCount * (UINT)sizeof(LONG) : 0;
    if (id == PropertyTagLoopCount)
        return img->loopCount == GDIP_NO_LOOP ? 0 : (UINT)sizeof(WORD);
    return 0;
}

/* ============================================================ 8. the API */

/* ---- lifecycle ---- */

GpStatus WINGDIPAPI GdiplusStartup(ULONG_PTR *token,
                                   GDIPCONST GdiplusStartupInput *input,
                                   GdiplusStartupOutput *output) {
    if (!token || !input) return InvalidParameter;
    if (input->GdiplusVersion != 1) {
        WIN32_UNSUPPORTED("GdiplusStartup version %u (only 1)",
                          (unsigned)input->GdiplusVersion);
        return UnsupportedGdiplusVersion;
    }
    if (input->DebugEventCallback) {
        WIN32_UNSUPPORTED("GdiplusStartup DebugEventCallback");
        return NotImplemented;
    }
    if (output) {
        /* The output block exists only to hand back the background-thread
         * notification hooks, and there is no background thread here. A
         * caller that asked for them must not be told it got them. */
        WIN32_UNSUPPORTED("GdiplusStartup notification hooks "
                          "(no background thread in this OS)");
        return NotImplemented;
    }
    g_startupCount++;
    *token = (ULONG_PTR)g_startupCount;
    return Ok;
}

void WINGDIPAPI GdiplusShutdown(ULONG_PTR token) {
    (void)token;
    if (g_startupCount > 0) g_startupCount--;
}

GpStatus WINGDIPAPI GdipDisposeImage(GpImage *image) {
    REQUIRE_STARTED();
    if (!image) return InvalidParameter;
    image_free(image);
    return Ok;
}

GpStatus WINGDIPAPI GdipDeleteGraphics(GpGraphics *graphics) {
    REQUIRE_STARTED();
    if (!graphics) return InvalidParameter;
    free(graphics);
    return Ok;
}

/* ---- load ---- */

GpStatus WINGDIPAPI GdipLoadImageFromStream(IStream *stream, GpImage **image) {
    REQUIRE_STARTED();
    if (!stream || !image) return InvalidParameter;
    *image = NULL;

    STATSTG st;
    if (FAILED(IStream_Stat(stream, &st, STATFLAG_NONAME))) return GenericError;
    size_t size = (size_t)st.cbSize.QuadPart;
    if (!size) return GenericError;

    LARGE_INTEGER zero;
    zero.QuadPart = 0;
    if (FAILED(IStream_Seek(stream, zero, STREAM_SEEK_SET, NULL)))
        return GenericError;

    BYTE *buf = (BYTE *)malloc(size);
    if (!buf) return OutOfMemory;
    ULONG got = 0;
    if (FAILED(IStream_Read(stream, buf, (ULONG)size, &got)) || got != size) {
        free(buf);
        return GenericError;
    }
    GpStatus s = decode_memory(buf, size, image);
    free(buf);
    return s;
}

GpStatus WINGDIPAPI GdipLoadImageFromFile(GDIPCONST WCHAR *filename,
                                          GpImage **image) {
    REQUIRE_STARTED();
    if (!filename || !image) return InvalidParameter;
    *image = NULL;

    char path[MAX_PATH * 4];
    if (!utf16_to_utf8(filename, path, (int)sizeof path)) return InvalidParameter;

    FILE *f = fopen(path, "rb");
    if (!f) return FileNotFound;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return GenericError; }
    long n = ftell(f);
    if (n <= 0) { fclose(f); return GenericError; }
    rewind(f);
    BYTE *buf = (BYTE *)malloc((size_t)n);
    if (!buf) { fclose(f); return OutOfMemory; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    if (got != (size_t)n) { free(buf); return GenericError; }
    GpStatus s = decode_memory(buf, (size_t)n, image);
    free(buf);
    return s;
}

GpStatus WINGDIPAPI GdipCreateFromHDC(HDC hdc, GpGraphics **graphics) {
    REQUIRE_STARTED();
    if (!hdc || !graphics) return InvalidParameter;
    *graphics = NULL;
    GpGraphics *g = (GpGraphics *)calloc(1, sizeof *g);
    if (!g) return OutOfMemory;
    g->hdc = hdc;
    g->interpolation = InterpolationModeDefault;
    g->smoothing = SmoothingModeDefault;
    *graphics = g;
    return Ok;
}

/* ---- query ---- */

GpStatus WINGDIPAPI GdipGetImageWidth(GpImage *image, UINT *width) {
    REQUIRE_STARTED();
    if (!image || !width) return InvalidParameter;
    *width = image->w;
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageHeight(GpImage *image, UINT *height) {
    REQUIRE_STARTED();
    if (!image || !height) return InvalidParameter;
    *height = image->h;
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageRawFormat(GpImage *image, GUID *format) {
    REQUIRE_STARTED();
    if (!image || !format) return InvalidParameter;
    *format = image->rawFormat;
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageFlags(GpImage *image, UINT *flags) {
    REQUIRE_STARTED();
    if (!image || !flags) return InvalidParameter;
    *flags = image->flags;
    return Ok;
}

/* ---- draw ---- */

GpStatus WINGDIPAPI GdipDrawImageRectRect(
        GpGraphics *graphics, GpImage *image,
        REAL dstx, REAL dsty, REAL dstwidth, REAL dstheight,
        REAL srcx, REAL srcy, REAL srcwidth, REAL srcheight,
        GpUnit srcUnit, GDIPCONST GpImageAttributes *imageAttributes,
        DrawImageAbort callback, void *callbackData) {
    REQUIRE_STARTED();
    if (!graphics || !image) return InvalidParameter;
    (void)imageAttributes;   /* wrap mode only shows outside the source rect,
                              * and the source rect is always clamped inside
                              * the image here — so it can never be reached.
                              * See GdipSetImageAttributesWrapMode. */
    if (srcUnit != UnitPixel) {
        WIN32_UNSUPPORTED("GdipDrawImageRectRect srcUnit %d (only UnitPixel)",
                          (int)srcUnit);
        return InvalidParameter;
    }
    if (callback || callbackData) {
        WIN32_UNSUPPORTED("GdipDrawImageRectRect abort callback");
        return NotImplemented;
    }

    int dx = round_to_int(dstx), dy = round_to_int(dsty);
    int dw = round_to_int(dstwidth), dh = round_to_int(dstheight);
    int sx = round_to_int(srcx), sy = round_to_int(srcy);
    int sw = round_to_int(srcwidth), sh = round_to_int(srcheight);
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) {
        /* gdi32's StretchBlt refuses non-positive extents (it has no
         * mirroring path). Rather than let it fail deep inside, say what
         * was asked for. */
        WIN32_UNSUPPORTED("GdipDrawImageRectRect non-positive extent "
                          "(dst %dx%d src %dx%d)", dw, dh, sw, sh);
        return InvalidParameter;
    }

    if (graphics->interpolation != InterpolationModeNearestNeighbor &&
        graphics->interpolation != InterpolationModeDefault &&
        graphics->interpolation != InterpolationModeLowQuality &&
        !graphics->warnedInterp) {
        graphics->warnedInterp = 1;
        WIN32_UNSUPPORTED("GdipDrawImageRectRect interpolation mode %d "
                          "(drawn NEAREST — 0453 accepted scope)",
                          (int)graphics->interpolation);
    }
    if ((image->flags & (ImageFlagsHasAlpha | ImageFlagsHasTranslucent)) &&
        !graphics->warnedAlpha) {
        graphics->warnedAlpha = 1;
        /* Recorded, not silently absorbed: SRCCOPY does not blend. The
         * compositing primitive is gdi32 AlphaBlend, ticket #285. */
        WIN32_UNSUPPORTED("GdipDrawImageRectRect: image has alpha but the "
                          "blit is SRCCOPY (no compositing; ticket #285)");
    }

    HBITMAP bm = NULL;
    HGDIOBJ old = NULL;
    HDC src = frame_dc(image, &bm, &old);
    if (!src) return OutOfMemory;
    BOOL ok = StretchBlt(graphics->hdc, dx, dy, dw, dh, src, sx, sy, sw, sh,
                         SRCCOPY);
    SelectObject(src, old);
    DeleteDC(src);
    DeleteObject(bm);
    return ok ? Ok : GenericError;
}

GpStatus WINGDIPAPI GdipSetSmoothingMode(GpGraphics *graphics,
                                         SmoothingMode mode) {
    REQUIRE_STARTED();
    if (!graphics) return InvalidParameter;
    if (mode < SmoothingModeDefault || mode > SmoothingModeAntiAlias)
        return InvalidParameter;
    /* Real state, and honestly inert: smoothing governs the anti-aliasing
     * of VECTOR primitives, and this shim draws no vectors at all. There
     * is nothing here for it to change. */
    graphics->smoothing = mode;
    return Ok;
}

GpStatus WINGDIPAPI GdipSetInterpolationMode(GpGraphics *graphics,
                                             InterpolationMode mode) {
    REQUIRE_STARTED();
    if (!graphics) return InvalidParameter;
    if (mode < InterpolationModeDefault ||
        mode > InterpolationModeHighQualityBicubic)
        return InvalidParameter;
    graphics->interpolation = mode;
    graphics->warnedInterp = 0;
    return Ok;
}

GpStatus WINGDIPAPI GdipCreateImageAttributes(GpImageAttributes **attr) {
    REQUIRE_STARTED();
    if (!attr) return InvalidParameter;
    *attr = NULL;
    GpImageAttributes *a = (GpImageAttributes *)calloc(1, sizeof *a);
    if (!a) return OutOfMemory;
    a->wrap = WrapModeClamp;
    *attr = a;
    return Ok;
}

GpStatus WINGDIPAPI GdipSetImageAttributesWrapMode(GpImageAttributes *attr,
                                                   WrapMode wrap, ARGB argb,
                                                   BOOL clamp) {
    REQUIRE_STARTED();
    if (!attr) return InvalidParameter;
    if (wrap < WrapModeTile || wrap > WrapModeClamp) return InvalidParameter;
    attr->wrap = wrap;
    attr->argb = argb;
    attr->clamp = clamp;
    return Ok;
}

GpStatus WINGDIPAPI GdipDisposeImageAttributes(GpImageAttributes *attr) {
    REQUIRE_STARTED();
    if (!attr) return InvalidParameter;
    free(attr);
    return Ok;
}

/* ---- frames ---- */

GpStatus WINGDIPAPI GdipImageGetFrameDimensionsCount(GpImage *image,
                                                     UINT *count) {
    REQUIRE_STARTED();
    if (!image || !count) return InvalidParameter;
    *count = 1;   /* raster images carry exactly one dimension */
    return Ok;
}

GpStatus WINGDIPAPI GdipImageGetFrameDimensionsList(GpImage *image,
                                                    GUID *dimensionIDs,
                                                    UINT count) {
    REQUIRE_STARTED();
    if (!image || !dimensionIDs || count < 1) return InvalidParameter;
    dimensionIDs[0] = *image_dimension(image);
    return Ok;
}

GpStatus WINGDIPAPI GdipImageGetFrameCount(GpImage *image,
                                           GDIPCONST GUID *dimensionID,
                                           UINT *count) {
    REQUIRE_STARTED();
    if (!image || !count) return InvalidParameter;
    if (dimensionID && !IsEqualGUID(dimensionID, image_dimension(image)))
        return InvalidParameter;
    *count = image->frameCount;
    return Ok;
}

GpStatus WINGDIPAPI GdipImageSelectActiveFrame(GpImage *image,
                                               GDIPCONST GUID *dimensionID,
                                               UINT frameIndex) {
    REQUIRE_STARTED();
    if (!image) return InvalidParameter;
    /* A wrong dimension MUST fail: shimgvw's anime.c probes Time first and
     * falls back to Page precisely on this status. */
    if (dimensionID && !IsEqualGUID(dimensionID, image_dimension(image)))
        return InvalidParameter;
    if (frameIndex >= image->frameCount) return InvalidParameter;
    image->activeFrame = frameIndex;
    return Ok;
}

GpStatus WINGDIPAPI GdipGetPropertyItemSize(GpImage *image, PROPID propId,
                                            UINT *size) {
    REQUIRE_STARTED();
    if (!image || !size) return InvalidParameter;
    UINT bytes = property_value_bytes(image, propId);
    if (!bytes) { *size = 0; return PropertyNotFound; }
    *size = (UINT)sizeof(PropertyItem) + bytes;
    return Ok;
}

GpStatus WINGDIPAPI GdipGetPropertyItem(GpImage *image, PROPID propId,
                                        UINT size, PropertyItem *buffer) {
    REQUIRE_STARTED();
    if (!image || !buffer) return InvalidParameter;
    UINT bytes = property_value_bytes(image, propId);
    if (!bytes) return PropertyNotFound;
    if (size < (UINT)sizeof(PropertyItem) + bytes) return InsufficientBuffer;

    BYTE *value = (BYTE *)buffer + sizeof(PropertyItem);
    buffer->id = propId;
    buffer->length = bytes;
    buffer->value = value;
    if (propId == PropertyTagFrameDelay) {
        buffer->type = PropertyTagTypeLong;
        LONG *out = (LONG *)value;
        for (UINT i = 0; i < image->frameCount; i++)
            out[i] = (LONG)image->delays[i];   /* centiseconds, as GDI+ */
    } else {
        buffer->type = PropertyTagTypeShort;
        WORD loop = (WORD)image->loopCount;
        memcpy(value, &loop, sizeof loop);
    }
    return Ok;
}

/* ---- transform ---- */

GpStatus WINGDIPAPI GdipImageRotateFlip(GpImage *image, RotateFlipType type) {
    REQUIRE_STARTED();
    if (!image) return InvalidParameter;
    if ((int)type < 0 || (int)type > 7) return InvalidParameter;
    int quarters = (int)type & 3;
    int flipX = ((int)type & 4) != 0;
    if (!quarters && !flipX) return Ok;

    /* Every frame turns, not just the active one: an animation that
     * rotated one frame would tear on the next tick. */
    UINT nw = image->w, nh = image->h;
    for (UINT f = 0; f < image->frameCount; f++) {
        UINT ow, oh;
        uint32_t *rot = rotate_flip_frame(image->frames[f], image->w, image->h,
                                          quarters, flipX, &ow, &oh);
        if (!rot) return OutOfMemory;   /* earlier frames stay turned; the
                                         * caller is out of memory either way */
        free(image->frames[f]);
        image->frames[f] = rot;
        nw = ow;
        nh = oh;
    }
    image->w = nw;
    image->h = nh;
    return Ok;
}

/* ---- save / enumerate ---- */

GpStatus WINGDIPAPI GdipSaveImageToFile(GpImage *image,
                                        GDIPCONST WCHAR *filename,
                                        GDIPCONST CLSID *clsidEncoder,
                                        GDIPCONST EncoderParameters *params) {
    REQUIRE_STARTED();
    if (!image || !filename || !clsidEncoder) return InvalidParameter;
    if (params) {
        WIN32_UNSUPPORTED("GdipSaveImageToFile encoder parameters");
        return NotImplemented;
    }
    char path[MAX_PATH * 4];
    if (!utf16_to_utf8(filename, path, (int)sizeof path)) return InvalidParameter;

    if (IsEqualGUID(clsidEncoder, &k_clsidPNG))
        return encode_png_file(image, path);
    if (IsEqualGUID(clsidEncoder, &k_clsidBMP))
        return encode_bmp_file(image, path);
    /* Only the two codecs GdipGetImageEncoders advertises can get here at
     * all through a well-behaved caller; anything else is a caller that
     * invented a CLSID, and it hears about it. */
    WIN32_UNSUPPORTED("GdipSaveImageToFile: no encoder for CLSID "
                      "%08X-%04X-%04X (only BMP and PNG)",
                      (unsigned)clsidEncoder->Data1,
                      (unsigned)clsidEncoder->Data2,
                      (unsigned)clsidEncoder->Data3);
    return UnknownImageFormat;
}

/* The ImageCodecInfo block layout GDI+ promises: `numX` structs first,
 * then the strings they point at, all inside the caller's `size` bytes. */
static UINT codec_block_size(const CodecDesc *tab, UINT n) {
    UINT bytes = n * (UINT)sizeof(ImageCodecInfo);
    for (UINT i = 0; i < n; i++) {
        const WCHAR *strs[5];
        strs[0] = tab[i].codecName;
        strs[1] = u"gdiplus-mini";              /* DllName */
        strs[2] = tab[i].formatDescription;
        strs[3] = tab[i].filenameExtension;
        strs[4] = tab[i].mimeType;
        for (int k = 0; k < 5; k++) {
            UINT len = 0;
            while (strs[k][len]) len++;
            bytes += (len + 1) * (UINT)sizeof(WCHAR);
        }
    }
    return bytes;
}

static WCHAR *pack_wstr(WCHAR **cursor, const WCHAR *s) {
    WCHAR *dst = *cursor;
    UINT i = 0;
    while (s[i]) { dst[i] = s[i]; i++; }
    dst[i] = 0;
    *cursor = dst + i + 1;
    return dst;
}

static GpStatus fill_codecs(const CodecDesc *tab, UINT n, UINT num, UINT size,
                            ImageCodecInfo *out, const char *what) {
    if (!out) return InvalidParameter;
    if (num != n || size < codec_block_size(tab, n)) {
        WIN32_UNSUPPORTED("GdipGetImage%s: buffer %u bytes for %u codecs "
                          "(need %u for %u)", what, (unsigned)size,
                          (unsigned)num, (unsigned)codec_block_size(tab, n),
                          (unsigned)n);
        return InvalidParameter;
    }
    memset(out, 0, size);
    WCHAR *cursor = (WCHAR *)((BYTE *)out + n * sizeof(ImageCodecInfo));
    for (UINT i = 0; i < n; i++) {
        out[i].Clsid = *tab[i].clsid;
        out[i].FormatID = *tab[i].format;
        out[i].CodecName = pack_wstr(&cursor, tab[i].codecName);
        out[i].DllName = pack_wstr(&cursor, u"gdiplus-mini");
        out[i].FormatDescription = pack_wstr(&cursor, tab[i].formatDescription);
        out[i].FilenameExtension = pack_wstr(&cursor, tab[i].filenameExtension);
        out[i].MimeType = pack_wstr(&cursor, tab[i].mimeType);
        out[i].Flags = tab[i].flags;
        out[i].Version = 1;
    }
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageEncodersSize(UINT *numEncoders, UINT *size) {
    REQUIRE_STARTED();
    if (!numEncoders || !size) return InvalidParameter;
    *numEncoders = ENCODER_COUNT;
    *size = codec_block_size(k_encoders, ENCODER_COUNT);
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageEncoders(UINT numEncoders, UINT size,
                                         ImageCodecInfo *encoders) {
    REQUIRE_STARTED();
    return fill_codecs(k_encoders, ENCODER_COUNT, numEncoders, size, encoders,
                       "Encoders");
}

GpStatus WINGDIPAPI GdipGetImageDecodersSize(UINT *numDecoders, UINT *size) {
    REQUIRE_STARTED();
    if (!numDecoders || !size) return InvalidParameter;
    *numDecoders = DECODER_COUNT;
    *size = codec_block_size(k_decoders, DECODER_COUNT);
    return Ok;
}

GpStatus WINGDIPAPI GdipGetImageDecoders(UINT numDecoders, UINT size,
                                         ImageCodecInfo *decoders) {
    REQUIRE_STARTED();
    return fill_codecs(k_decoders, DECODER_COUNT, numDecoders, size, decoders,
                       "Decoders");
}
