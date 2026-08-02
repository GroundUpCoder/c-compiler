/* gdiplusflat.h — gdiplus-mini: the flat GDI+ surface (ticket #94 / 0453).
 *
 * NOT a general GDI+ implementation, and deliberately so. This is exactly
 * the flat `Gdip*` API that the ReactOS "Picture and Fax Viewer"
 * (dll/win32/shimgvw) calls, DERIVED from those sources rather than
 * copied from a scoping estimate:
 *
 *   source   : github.com/reactos/reactos, dll/win32/shimgvw
 *   revision : e3e58ac1aacc3a2eb361c1fcbcc0c632c2616782 (master, 2026-06-30)
 *   method   : grep -ohE '\b(Gdip|Gdiplus)[A-Za-z0-9_]*' *.c *.cpp *.h
 *   result   : 32 unique matches, of which 3 are NOT functions
 *              (`Gdiplus` the C++ namespace in loader.cpp,
 *               `GdiplusStartupInput` the struct type,
 *               `GdiplusVersion` its field)
 *   => 29 flat functions, every one of them declared below.
 *
 * The design note's "28" was a compressed-notation estimate; expanding
 * its own groups yields 29 too, so the note is short by one, not this
 * header long by one. (0453's journal has the per-group arithmetic.)
 *
 * WHAT IT RUNS ON — everything is over machinery this tree already has:
 *   decode : libpng (PNG), IJG libjpeg (JPEG, ticket #93), libnsgif
 *            (GIF, all frames), libnsbmp (BMP)
 *   draw   : gdi32's StretchBlt, NEAREST-NEIGHBOUR (jku's scoping reply
 *            accepted nearest first — "quality is not the bar for v1")
 *   encode : libpng and a BMP writer, for GdipSaveImageToFile
 *   stream : the ole32 memory IStream (objbase.h)
 *
 * FAIL-LOUD CONTRACT (acceptance arm 2). Anything this shim cannot do
 * says so: an unsupported argument returns a real GDI+ error status AND
 * emits one `win32: unsupported ...` line through WIN32_UNSUPPORTED. No
 * function here returns Ok without having done the work. The two places
 * where behaviour is legitimately narrower than Windows are documented
 * at their declarations and are visible to the caller:
 *   - GdipSetInterpolationMode ACCEPTS every valid mode, because recording
 *     the state IS a setter's whole contract; the DRAW then announces that
 *     it sampled nearest anyway.
 *   - GdipDrawImageRectRect does not alpha-composite; see its comment.
 * Neither is a silent success: both are announced at the point where the
 * behaviour actually narrows. Where the shim would otherwise have to
 * INVENT pixels — a source rect outside the image, which GDI+ would fill
 * from the wrap mode — it refuses outright instead.
 */
#pragma once

#include <windows.h>
#include <objbase.h>

typedef float REAL;
typedef DWORD ARGB;
typedef DWORD PROPID;
#define GDIPCONST const
#define WINGDIPAPI

/* ---------------- status ---------------- */

typedef enum {
    Ok                        = 0,
    GenericError              = 1,
    InvalidParameter          = 2,
    OutOfMemory               = 3,
    ObjectBusy                = 4,
    InsufficientBuffer        = 5,
    NotImplemented            = 6,
    Win32Error                = 7,
    WrongState                = 8,
    Aborted                   = 9,
    FileNotFound              = 10,
    ValueOverflow             = 11,
    AccessDenied              = 12,
    UnknownImageFormat        = 13,
    FontFamilyNotFound        = 14,
    FontStyleNotFound         = 15,
    NotTrueTypeFont           = 16,
    UnsupportedGdiplusVersion = 17,
    GdiplusNotInitialized     = 18,
    PropertyNotFound          = 19,
    PropertyNotSupported      = 20
} GpStatus, Status;

/* ---------------- opaque objects ---------------- */

typedef struct GpImage           GpImage;
typedef struct GpImage           GpBitmap;
typedef struct GpGraphics        GpGraphics;
typedef struct GpImageAttributes GpImageAttributes;

/* ---------------- enums ---------------- */

typedef enum {
    UnitWorld = 0, UnitDisplay = 1, UnitPixel = 2, UnitPoint = 3,
    UnitInch = 4, UnitDocument = 5, UnitMillimeter = 6
} GpUnit, Unit;

typedef enum {
    InterpolationModeInvalid = -1,
    InterpolationModeDefault = 0,
    InterpolationModeLowQuality = 1,
    InterpolationModeHighQuality = 2,
    InterpolationModeBilinear = 3,
    InterpolationModeBicubic = 4,
    InterpolationModeNearestNeighbor = 5,
    InterpolationModeHighQualityBilinear = 6,
    InterpolationModeHighQualityBicubic = 7
} InterpolationMode;

typedef enum {
    SmoothingModeInvalid = -1,
    SmoothingModeDefault = 0,
    SmoothingModeHighSpeed = 1,
    SmoothingModeHighQuality = 2,
    SmoothingModeNone = 3,
    SmoothingModeAntiAlias = 4
} SmoothingMode;

typedef enum {
    WrapModeTile = 0,
    WrapModeTileFlipX = 1,
    WrapModeTileFlipY = 2,
    WrapModeTileFlipXY = 3,
    WrapModeClamp = 4
} WrapMode;

typedef enum {
    RotateNoneFlipNone = 0,
    Rotate90FlipNone   = 1,
    Rotate180FlipNone  = 2,
    Rotate270FlipNone  = 3,
    RotateNoneFlipX    = 4,
    Rotate90FlipX      = 5,
    Rotate180FlipX     = 6,
    Rotate270FlipX     = 7,
    RotateNoneFlipY    = Rotate180FlipX,
    Rotate90FlipY      = Rotate270FlipX,
    Rotate180FlipY     = RotateNoneFlipX,
    Rotate270FlipY     = Rotate90FlipX,
    RotateNoneFlipXY   = Rotate180FlipNone,
    Rotate90FlipXY     = Rotate270FlipNone,
    Rotate180FlipXY    = RotateNoneFlipNone,
    Rotate270FlipXY    = Rotate90FlipNone
} RotateFlipType;

/* ImageFlags — shimgvw reads HasAlpha/HasTranslucent to decide whether to
 * paint a checkerboard behind the image. */
#define ImageFlagsNone               0x00000000
#define ImageFlagsScalable           0x00000001
#define ImageFlagsHasAlpha           0x00000002
#define ImageFlagsHasTranslucent     0x00000004
#define ImageFlagsPartiallyScalable  0x00000008
#define ImageFlagsColorSpaceRGB      0x00000010
#define ImageFlagsColorSpaceGRAY     0x00000040
#define ImageFlagsReadOnly           0x00010000
#define ImageFlagsCaching            0x00020000

#define ImageCodecFlagsEncoder       0x00000001
#define ImageCodecFlagsDecoder       0x00000002
#define ImageCodecFlagsSupportBitmap 0x00000004
#define ImageCodecFlagsBuiltin       0x00010000

/* Property tags. GIF frame delays and loop count are the two shimgvw
 * reads (anime.c); the shim reports PropertyNotFound for every other
 * tag rather than invent metadata. */
#define PropertyTagFrameDelay        0x5100
#define PropertyTagLoopCount         0x5101

#define PropertyTagTypeByte      1
#define PropertyTagTypeASCII     2
#define PropertyTagTypeShort     3
#define PropertyTagTypeLong      4
#define PropertyTagTypeRational  5
#define PropertyTagTypeUndefined 7
#define PropertyTagTypeSLONG     9
#define PropertyTagTypeSRational 10

/* ---------------- structs ---------------- */

typedef struct PropertyItem {
    PROPID id;
    ULONG  length;    /* value size in BYTES */
    WORD   type;
    void  *value;
} PropertyItem;

/* ImageCodecInfo — GdipGetImageEncoders/Decoders fill an array of these
 * followed, in the SAME caller buffer, by the strings the members point
 * at. That packing is why the *Size query returns a byte count as well
 * as a codec count. */
typedef struct ImageCodecInfo {
    CLSID  Clsid;
    GUID   FormatID;
    const WCHAR *CodecName;
    const WCHAR *DllName;
    const WCHAR *FormatDescription;
    const WCHAR *FilenameExtension;
    const WCHAR *MimeType;
    DWORD  Flags;
    DWORD  Version;
    DWORD  SigCount;
    DWORD  SigSize;
    const BYTE *SigPattern;
    const BYTE *SigMask;
} ImageCodecInfo;

typedef struct EncoderParameter {
    GUID  Guid;
    ULONG NumberOfValues;
    ULONG Type;
    void *Value;
} EncoderParameter;

typedef struct EncoderParameters {
    UINT             Count;
    EncoderParameter Parameter[1];
} EncoderParameters;

typedef int (*DebugEventProc)(int level, char *message);
typedef Status (*NotificationHookProc)(ULONG_PTR *token);
typedef void (*NotificationUnhookProc)(ULONG_PTR token);

/* shimgvw.c writes `struct GdiplusStartupInput gdiplusStartupInput;` —
 * the tag name is load-bearing, not just the typedef. */
struct GdiplusStartupInput {
    UINT           GdiplusVersion;   /* real gdiplus spells this UINT32 */
    DebugEventProc DebugEventCallback;
    BOOL           SuppressBackgroundThread;
    BOOL           SuppressExternalCodecs;
};
typedef struct GdiplusStartupInput GdiplusStartupInput;

typedef struct GdiplusStartupOutput {
    NotificationHookProc   NotificationHook;
    NotificationUnhookProc NotificationUnhook;
} GdiplusStartupOutput;

typedef BOOL (*DrawImageAbort)(void *);

/* ---------------- well-known GUIDs ----------------
 * The real Windows values, so a format GUID that crosses this boundary
 * still means what it means everywhere else. Defined in gdiplus.c. */

extern const GUID ImageFormatUndefined;
extern const GUID ImageFormatMemoryBMP;
extern const GUID ImageFormatBMP;
extern const GUID ImageFormatEMF;
extern const GUID ImageFormatWMF;
extern const GUID ImageFormatJPEG;
extern const GUID ImageFormatPNG;
extern const GUID ImageFormatGIF;
extern const GUID ImageFormatTIFF;
extern const GUID ImageFormatEXIF;
extern const GUID ImageFormatIcon;

extern const GUID FrameDimensionTime;
extern const GUID FrameDimensionResolution;
extern const GUID FrameDimensionPage;

/* ============================================================ the 29 */

/* -- lifecycle (4) -- */
GpStatus WINGDIPAPI GdiplusStartup(ULONG_PTR *token,
                                   GDIPCONST GdiplusStartupInput *input,
                                   GdiplusStartupOutput *output);
void     WINGDIPAPI GdiplusShutdown(ULONG_PTR token);
GpStatus WINGDIPAPI GdipDisposeImage(GpImage *image);
GpStatus WINGDIPAPI GdipDeleteGraphics(GpGraphics *graphics);

/* -- load (3) -- */
GpStatus WINGDIPAPI GdipLoadImageFromStream(IStream *stream, GpImage **image);
GpStatus WINGDIPAPI GdipLoadImageFromFile(GDIPCONST WCHAR *filename,
                                          GpImage **image);
GpStatus WINGDIPAPI GdipCreateFromHDC(HDC hdc, GpGraphics **graphics);

/* -- query (4) -- */
GpStatus WINGDIPAPI GdipGetImageWidth(GpImage *image, UINT *width);
GpStatus WINGDIPAPI GdipGetImageHeight(GpImage *image, UINT *height);
GpStatus WINGDIPAPI GdipGetImageRawFormat(GpImage *image, GUID *format);
GpStatus WINGDIPAPI GdipGetImageFlags(GpImage *image, UINT *flags);

/* -- draw (6) --
 *
 * GdipDrawImageRectRect scales the source rect onto the destination rect
 * with gdi32's StretchBlt, through a PRIVATE offscreen bitmap holding the
 * active frame. Two consequences worth knowing, both deliberate:
 *
 *   - The sampling is NEAREST NEIGHBOUR whatever the interpolation mode
 *     says (see GdipSetInterpolationMode).
 *   - The blit is SRCCOPY: per-pixel alpha in the image is NOT composited
 *     over the destination. A translucent PNG lands opaque. This shim
 *     reports the alpha honestly through GdipGetImageFlags, so a viewer
 *     still knows to draw its checkerboard — it just will not show
 *     through. Compositing needs gdi32 AlphaBlend, which is ticket #285;
 *     this shim does NOT carry a private copy of it.
 *
 * srcUnit must be UnitPixel; anything else is a loud InvalidParameter.
 * `callback`/`callbackData` (the abort hook) must be NULL — there is no
 * partial-draw pump to abort.
 *
 * The source rect must lie INSIDE the image. Outside it GDI+ fills from
 * the GpImageAttributes wrap mode, and no wrap mode is implemented here,
 * so an out-of-bounds source rect is a loud InvalidParameter naming the
 * wrap mode — never an Ok that quietly leaves those destination pixels
 * as they were. */
GpStatus WINGDIPAPI GdipDrawImageRectRect(
        GpGraphics *graphics, GpImage *image,
        REAL dstx, REAL dsty, REAL dstwidth, REAL dstheight,
        REAL srcx, REAL srcy, REAL srcwidth, REAL srcheight,
        GpUnit srcUnit, GDIPCONST GpImageAttributes *imageAttributes,
        DrawImageAbort callback, void *callbackData);

GpStatus WINGDIPAPI GdipSetSmoothingMode(GpGraphics *graphics,
                                         SmoothingMode mode);
/* Stores the mode and returns Ok — which is the WHOLE contract of a GDI+
 * state setter, so this is not a silent success: the setter really did
 * record what it was asked to record, and a caller that reads the state
 * back gets its own value. What is narrower is the DRAW, and that is
 * where it is announced: every draw whose mode is not
 * InterpolationModeNearestNeighbor emits one WIN32_UNSUPPORTED line
 * naming the requested mode. (WIN32_UNSUPPORTED reports once per call
 * site, so that is one line per process — the STATUS is what a caller
 * reads, and it is Ok because the draw really happened, just nearest.)
 * InterpolationModeDefault is included — on real GDI+ Default is
 * bilinear, so exempting it would make the commonest case, a caller that
 * never sets a mode at all, the one silently substituted. */
GpStatus WINGDIPAPI GdipSetInterpolationMode(GpGraphics *graphics,
                                             InterpolationMode mode);
GpStatus WINGDIPAPI GdipCreateImageAttributes(GpImageAttributes **attr);
/* Stores the wrap mode. It becomes consequential only where the source
 * rect leaves the image — and GdipDrawImageRectRect REFUSES that case
 * loudly, naming this mode, rather than returning Ok having filled
 * nothing. So the stored value is never quietly ignored. */
GpStatus WINGDIPAPI GdipSetImageAttributesWrapMode(GpImageAttributes *attr,
                                                   WrapMode wrap, ARGB argb,
                                                   BOOL clamp);
GpStatus WINGDIPAPI GdipDisposeImageAttributes(GpImageAttributes *attr);

/* -- frames / animation (6) -- */
GpStatus WINGDIPAPI GdipImageGetFrameDimensionsCount(GpImage *image,
                                                     UINT *count);
GpStatus WINGDIPAPI GdipImageGetFrameDimensionsList(GpImage *image,
                                                    GUID *dimensionIDs,
                                                    UINT count);
GpStatus WINGDIPAPI GdipImageGetFrameCount(GpImage *image,
                                           GDIPCONST GUID *dimensionID,
                                           UINT *count);
GpStatus WINGDIPAPI GdipImageSelectActiveFrame(GpImage *image,
                                               GDIPCONST GUID *dimensionID,
                                               UINT frameIndex);
GpStatus WINGDIPAPI GdipGetPropertyItemSize(GpImage *image, PROPID propId,
                                            UINT *size);
GpStatus WINGDIPAPI GdipGetPropertyItem(GpImage *image, PROPID propId,
                                        UINT size, PropertyItem *buffer);

/* -- transform (1) -- */
GpStatus WINGDIPAPI GdipImageRotateFlip(GpImage *image, RotateFlipType type);

/* -- save / enumerate (5) --
 * encoderParams must be NULL: no encoder parameter (quality, colour
 * depth, multi-frame) is honoured, and silently ignoring one would be
 * exactly the "mistake not-implemented for succeeded" this shim refuses. */
GpStatus WINGDIPAPI GdipSaveImageToFile(GpImage *image,
                                        GDIPCONST WCHAR *filename,
                                        GDIPCONST CLSID *clsidEncoder,
                                        GDIPCONST EncoderParameters *params);
GpStatus WINGDIPAPI GdipGetImageEncodersSize(UINT *numEncoders, UINT *size);
GpStatus WINGDIPAPI GdipGetImageEncoders(UINT numEncoders, UINT size,
                                         ImageCodecInfo *encoders);
GpStatus WINGDIPAPI GdipGetImageDecodersSize(UINT *numDecoders, UINT *size);
GpStatus WINGDIPAPI GdipGetImageDecoders(UINT numDecoders, UINT size,
                                         ImageCodecInfo *decoders);

/* ---------------- the gdiplus require block (source-lib design §4.1) ----
 * gdiplus.c is NOT in the base veneer link set: it drags in four image
 * decoders, and a Solitaire has no business paying for a JPEG library.
 * It is its own component (os/win32/gdiplus.json), so its consumer pulls
 * it from here. The DECODER TUs are required by gdiplus.c itself — vendor
 * knowledge stays with its consumer (§4.2, the gdi32.c/freetype rule). */
__require_source("win32/gdiplus.c");
