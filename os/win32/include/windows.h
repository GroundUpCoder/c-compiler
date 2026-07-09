/* windows.h — the Win32 veneer for this OS (todos/WIN32.md).
 *
 * 0057: the gdi32 drawing subset (CPU rasterizer into the shm surface —
 * the DWM redirection model: CPU draw -> shm -> GPU composite). user32
 * windowing is 0058; kernel32 is 0059. Until 0058 lands, an HWND is the
 * `__gdi_bind_hwnd` scaffold over an SDL window (see gdi32.c).
 *
 * ANSI-only for now (todos/WIN32.md friction #2: implement W, shim A —
 * the A/W split arrives with the 0060 port corpus). The *A aliases below
 * keep ported sources compiling.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* ---------------- windef: the base types (ILP32) ---------------- */

typedef int BOOL;
typedef unsigned char BYTE;
typedef unsigned short WORD;
typedef unsigned int DWORD;
typedef unsigned int UINT;
typedef unsigned int ULONG;
typedef int INT;
typedef int LONG;
typedef short SHORT;
typedef unsigned short USHORT;
typedef long long LONGLONG;
typedef unsigned long long ULONGLONG;
typedef float FLOAT;
typedef char CHAR;
typedef void VOID;
typedef void *PVOID, *LPVOID, *HANDLE;
typedef const void *LPCVOID;
typedef char *LPSTR, *PSTR;
typedef const char *LPCSTR, *PCSTR;
typedef BYTE *LPBYTE;
typedef WORD *LPWORD;
typedef DWORD *LPDWORD;
typedef INT *LPINT;
typedef LONG *PLONG, *LPLONG;
typedef BOOL *LPBOOL;
typedef unsigned int WPARAM;
typedef int LPARAM;
typedef int LRESULT;
typedef DWORD COLORREF;
typedef COLORREF *LPCOLORREF;
typedef HANDLE HINSTANCE;
typedef HANDLE HMODULE;

#ifndef TRUE
#define TRUE  1
#define FALSE 0
#endif
#ifndef NULL
#define NULL ((void *)0)
#endif
#define CALLBACK
#define WINAPI
#define CONST const

/* Handles: one underlying GDI object type keeps SelectObject cast-free in
 * plain C; HDC and HWND are their own structs. All opaque here. */
typedef struct __GDIOBJ *HGDIOBJ;
typedef struct __GDIOBJ *HPEN;
typedef struct __GDIOBJ *HBRUSH;
typedef struct __GDIOBJ *HFONT;
typedef struct __GDIOBJ *HBITMAP;
typedef struct __GDIOBJ *HRGN;      /* regions: only NULL is meaningful (0057) */
typedef struct __DC  *HDC;
typedef struct __HWND *HWND;

typedef struct tagPOINT { LONG x, y; } POINT, *PPOINT, *LPPOINT;
typedef struct tagSIZE  { LONG cx, cy; } SIZE, *PSIZE, *LPSIZE;
typedef struct tagRECT  { LONG left, top, right, bottom; } RECT, *PRECT, *LPRECT;
typedef const RECT *LPCRECT;

/* ---------------- wingdi: colors ---------------- */

#define RGB(r, g, b) ((COLORREF)(((BYTE)(r)) | (((WORD)(BYTE)(g)) << 8) | (((DWORD)(BYTE)(b)) << 16)))
#define GetRValue(c) ((BYTE)(c))
#define GetGValue(c) ((BYTE)(((WORD)(c)) >> 8))
#define GetBValue(c) ((BYTE)((c) >> 16))
#define CLR_INVALID  0xFFFFFFFFu

/* ---------------- wingdi: objects ---------------- */

/* GetStockObject */
#define WHITE_BRUSH        0
#define LTGRAY_BRUSH       1
#define GRAY_BRUSH         2
#define DKGRAY_BRUSH       3
#define BLACK_BRUSH        4
#define NULL_BRUSH         5
#define HOLLOW_BRUSH       NULL_BRUSH
#define WHITE_PEN          6
#define BLACK_PEN          7
#define NULL_PEN           8
#define SYSTEM_FONT        13
#define DEFAULT_GUI_FONT   17

/* Pen styles (PS_SOLID and PS_NULL honored; other styles draw solid) */
#define PS_SOLID       0
#define PS_DASH        1
#define PS_DOT         2
#define PS_DASHDOT     3
#define PS_DASHDOTDOT  4
#define PS_NULL        5
#define PS_INSIDEFRAME 6

/* Brush styles */
#define BS_SOLID   0
#define BS_NULL    1
#define BS_HOLLOW  BS_NULL
#define BS_HATCHED 2

/* Hatch styles */
#define HS_HORIZONTAL 0
#define HS_VERTICAL   1
#define HS_FDIAGONAL  2
#define HS_BDIAGONAL  3
#define HS_CROSS      4
#define HS_DIAGCROSS  5

/* Binary raster ops (SetROP2) — all 16 implemented */
#define R2_BLACK       1
#define R2_NOTMERGEPEN 2
#define R2_MASKNOTPEN  3
#define R2_NOTCOPYPEN  4
#define R2_MASKPENNOT  5
#define R2_NOT         6
#define R2_XORPEN      7
#define R2_NOTMASKPEN  8
#define R2_MASKPEN     9
#define R2_NOTXORPEN   10
#define R2_NOP         11
#define R2_MERGENOTPEN 12
#define R2_COPYPEN     13
#define R2_MERGEPENNOT 14
#define R2_MERGEPEN    15
#define R2_WHITE       16

/* Ternary raster ops (BitBlt/StretchBlt/PatBlt) — the implemented set */
#define SRCCOPY     0x00CC0020u
#define SRCPAINT    0x00EE0086u
#define SRCAND      0x008800C6u
#define SRCINVERT   0x00660046u
#define SRCERASE    0x00440328u
#define NOTSRCCOPY  0x00330008u
#define NOTSRCERASE 0x001100A6u
#define MERGEPAINT  0x00BB0226u
#define PATCOPY     0x00F00021u
#define PATINVERT   0x005A0049u
#define DSTINVERT   0x00550009u
#define BLACKNESS   0x00000042u
#define WHITENESS   0x00FF0062u

/* Background mode */
#define TRANSPARENT 1
#define OPAQUE      2

/* GetDeviceCaps */
#define HORZRES    8
#define VERTRES    10
#define BITSPIXEL  12
#define PLANES     14
#define NUMCOLORS  24
#define LOGPIXELSX 88
#define LOGPIXELSY 90

/* Region complexity returns */
#define ERROR         0
#define NULLREGION    1
#define SIMPLEREGION  2
#define COMPLEXREGION 3
#define RGN_ERROR     ERROR

#define GDI_ERROR 0xFFFFFFFFu

/* ---------------- wingdi: fonts ---------------- */

#define FW_DONTCARE 0
#define FW_THIN     100
#define FW_LIGHT    300
#define FW_NORMAL   400
#define FW_MEDIUM   500
#define FW_SEMIBOLD 600
#define FW_BOLD     700
#define FW_HEAVY    900

#define ANSI_CHARSET    0
#define DEFAULT_CHARSET 1
#define OEM_CHARSET     255

#define OUT_DEFAULT_PRECIS  0
#define CLIP_DEFAULT_PRECIS 0
#define DEFAULT_QUALITY     0
#define ANTIALIASED_QUALITY 4
#define DEFAULT_PITCH       0
#define FIXED_PITCH         1
#define VARIABLE_PITCH      2
#define FF_DONTCARE         0
#define FF_MODERN           48

#define LF_FACESIZE 32
typedef struct tagLOGFONT {
    LONG lfHeight;
    LONG lfWidth;
    LONG lfEscapement;
    LONG lfOrientation;
    LONG lfWeight;
    BYTE lfItalic;
    BYTE lfUnderline;
    BYTE lfStrikeOut;
    BYTE lfCharSet;
    BYTE lfOutPrecision;
    BYTE lfClipPrecision;
    BYTE lfQuality;
    BYTE lfPitchAndFamily;
    CHAR lfFaceName[LF_FACESIZE];
} LOGFONT, *PLOGFONT, *LPLOGFONT;

typedef struct tagTEXTMETRIC {
    LONG tmHeight;
    LONG tmAscent;
    LONG tmDescent;
    LONG tmInternalLeading;
    LONG tmExternalLeading;
    LONG tmAveCharWidth;
    LONG tmMaxCharWidth;
    LONG tmWeight;
    LONG tmOverhang;
    LONG tmDigitizedAspectX;
    LONG tmDigitizedAspectY;
    CHAR tmFirstChar;
    CHAR tmLastChar;
    CHAR tmDefaultChar;
    CHAR tmBreakChar;
    BYTE tmItalic;
    BYTE tmUnderlined;
    BYTE tmStruckOut;
    BYTE tmPitchAndFamily;
    BYTE tmCharSet;
} TEXTMETRIC, *PTEXTMETRIC, *LPTEXTMETRIC;

/* ---------------- wingdi: bitmaps / DIBs ---------------- */

typedef struct tagBITMAP {
    LONG bmType;
    LONG bmWidth;
    LONG bmHeight;
    LONG bmWidthBytes;
    WORD bmPlanes;
    WORD bmBitsPixel;
    LPVOID bmBits;
} BITMAP, *PBITMAP, *LPBITMAP;

typedef struct tagRGBQUAD {
    BYTE rgbBlue;
    BYTE rgbGreen;
    BYTE rgbRed;
    BYTE rgbReserved;
} RGBQUAD;

typedef struct tagBITMAPINFOHEADER {
    DWORD biSize;
    LONG  biWidth;
    LONG  biHeight;
    WORD  biPlanes;
    WORD  biBitCount;
    DWORD biCompression;
    DWORD biSizeImage;
    LONG  biXPelsPerMeter;
    LONG  biYPelsPerMeter;
    DWORD biClrUsed;
    DWORD biClrImportant;
} BITMAPINFOHEADER, *PBITMAPINFOHEADER, *LPBITMAPINFOHEADER;

typedef struct tagBITMAPINFO {
    BITMAPINFOHEADER bmiHeader;
    RGBQUAD bmiColors[1];
} BITMAPINFO, *PBITMAPINFO, *LPBITMAPINFO;

#define BI_RGB 0
#define DIB_RGB_COLORS 0

/* ---------------- user32 slice needed by painting (0058 takes over) --- */

typedef struct tagPAINTSTRUCT {
    HDC  hdc;
    BOOL fErase;
    RECT rcPaint;
    BOOL fRestore;
    BOOL fIncUpdate;
    BYTE rgbReserved[32];
} PAINTSTRUCT, *PPAINTSTRUCT, *LPPAINTSTRUCT;

/* DrawText format flags */
#define DT_TOP        0x0000
#define DT_LEFT       0x0000
#define DT_CENTER     0x0001
#define DT_RIGHT      0x0002
#define DT_VCENTER    0x0004
#define DT_BOTTOM     0x0008
#define DT_WORDBREAK  0x0010
#define DT_SINGLELINE 0x0020
#define DT_NOCLIP     0x0100
#define DT_CALCRECT   0x0400

/* ExtTextOut options */
#define ETO_OPAQUE  0x0002
#define ETO_CLIPPED 0x0004

/* ---------------- gdi32 API (the 0057 subset) ---------------- */

/* Device contexts */
HDC  GetDC(HWND hwnd);
int  ReleaseDC(HWND hwnd, HDC hdc);
HDC  BeginPaint(HWND hwnd, PAINTSTRUCT *ps);
BOOL EndPaint(HWND hwnd, const PAINTSTRUCT *ps);
HDC  CreateCompatibleDC(HDC hdc);
BOOL DeleteDC(HDC hdc);
int  GetDeviceCaps(HDC hdc, int index);

/* Objects */
HPEN     CreatePen(int style, int width, COLORREF color);
HBRUSH   CreateSolidBrush(COLORREF color);
HBRUSH   CreateHatchBrush(int hatch, COLORREF color);
HFONT    CreateFont(int height, int width, int escapement, int orientation,
                    int weight, DWORD italic, DWORD underline, DWORD strikeout,
                    DWORD charset, DWORD outPrecision, DWORD clipPrecision,
                    DWORD quality, DWORD pitchAndFamily, LPCSTR faceName);
HFONT    CreateFontIndirect(const LOGFONT *lf);
HBITMAP  CreateBitmap(int w, int h, UINT planes, UINT bpp, const void *bits);
HBITMAP  CreateCompatibleBitmap(HDC hdc, int w, int h);
HGDIOBJ  GetStockObject(int which);
HGDIOBJ  SelectObject(HDC hdc, HGDIOBJ obj);
BOOL     DeleteObject(HGDIOBJ obj);
int      GetObject(HGDIOBJ obj, int size, void *out);

/* Attributes */
COLORREF SetTextColor(HDC hdc, COLORREF color);
COLORREF GetTextColor(HDC hdc);
COLORREF SetBkColor(HDC hdc, COLORREF color);
COLORREF GetBkColor(HDC hdc);
int      SetBkMode(HDC hdc, int mode);
int      GetBkMode(HDC hdc);
int      SetROP2(HDC hdc, int rop2);
int      GetROP2(HDC hdc);

/* Pixels */
COLORREF SetPixel(HDC hdc, int x, int y, COLORREF color);
BOOL     SetPixelV(HDC hdc, int x, int y, COLORREF color);
COLORREF GetPixel(HDC hdc, int x, int y);

/* Lines and shapes */
BOOL MoveToEx(HDC hdc, int x, int y, POINT *old);
BOOL LineTo(HDC hdc, int x, int y);
BOOL Polyline(HDC hdc, const POINT *pts, int n);
BOOL Polygon(HDC hdc, const POINT *pts, int n);
BOOL Rectangle(HDC hdc, int left, int top, int right, int bottom);
BOOL Ellipse(HDC hdc, int left, int top, int right, int bottom);
BOOL RoundRect(HDC hdc, int left, int top, int right, int bottom, int ew, int eh);
int  FillRect(HDC hdc, const RECT *r, HBRUSH brush);
int  FrameRect(HDC hdc, const RECT *r, HBRUSH brush);
BOOL InvertRect(HDC hdc, const RECT *r);

/* Text */
BOOL TextOut(HDC hdc, int x, int y, LPCSTR str, int len);
BOOL ExtTextOut(HDC hdc, int x, int y, UINT options, const RECT *r,
                LPCSTR str, UINT len, const INT *dx);
int  DrawText(HDC hdc, LPCSTR str, int len, RECT *r, UINT format);
BOOL GetTextExtentPoint32(HDC hdc, LPCSTR str, int len, SIZE *size);
BOOL GetTextMetrics(HDC hdc, TEXTMETRIC *tm);

/* Blits and DIBs */
BOOL BitBlt(HDC dst, int x, int y, int w, int h, HDC src, int sx, int sy, DWORD rop);
BOOL StretchBlt(HDC dst, int x, int y, int w, int h,
                HDC src, int sx, int sy, int sw, int sh, DWORD rop);
BOOL PatBlt(HDC hdc, int x, int y, int w, int h, DWORD rop);
int  GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT lines, void *bits,
               BITMAPINFO *bmi, UINT usage);
int  SetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT lines, const void *bits,
               const BITMAPINFO *bmi, UINT usage);

/* Clipping */
int IntersectClipRect(HDC hdc, int left, int top, int right, int bottom);
int SelectClipRgn(HDC hdc, HRGN rgn);   /* only rgn == NULL (reset) supported */
int GetClipBox(HDC hdc, RECT *r);

/* Rect helpers (user32 on Windows; pure arithmetic, provided here) */
BOOL SetRect(RECT *r, int left, int top, int right, int bottom);
BOOL SetRectEmpty(RECT *r);
BOOL IsRectEmpty(const RECT *r);
BOOL InflateRect(RECT *r, int dx, int dy);
BOOL OffsetRect(RECT *r, int dx, int dy);
BOOL IntersectRect(RECT *out, const RECT *a, const RECT *b);
BOOL PtInRect(const RECT *r, POINT p);
BOOL EqualRect(const RECT *a, const RECT *b);
BOOL CopyRect(RECT *dst, const RECT *src);

/* kernel32 crumbs painting code leans on (0059 owns the real thing) */
int MulDiv(int a, int b, int c);

/* ---------------- 0057 scaffolding (replaced by 0058 user32) ----------
 * Until CreateWindowEx exists, an HWND wraps an SDL window: create the
 * window with SDL_CreateWindow, bind it, then GetDC/BeginPaint draw into
 * its surface and ReleaseDC/EndPaint present (SDL_UpdateWindowSurface).
 * GetClientRect reads the live surface size, so resizes are seen. */
HWND __gdi_bind_hwnd(void *sdl_window);
BOOL GetClientRect(HWND hwnd, RECT *r);

/* GDI accounting (the 0057 leak-discipline probes; test-facing) */
int __gdi_object_count(void);
int __gdi_dc_count(void);

/* ---------------- A-suffix aliases (ANSI == the only entry for now) --- */
#define TextOutA              TextOut
#define ExtTextOutA           ExtTextOut
#define DrawTextA             DrawText
#define GetTextExtentPoint32A GetTextExtentPoint32
#define GetTextMetricsA       GetTextMetrics
#define CreateFontA           CreateFont
#define CreateFontIndirectA   CreateFontIndirect
#define GetObjectA            GetObject
#define LOGFONTA              LOGFONT
#define TEXTMETRICA           TEXTMETRIC
