/* windows.h — the Win32 veneer for this OS (todos/WIN32.md).
 *
 * 0057: the gdi32 drawing subset (CPU rasterizer into the shm surface —
 * the DWM redirection model: CPU draw -> shm -> GPU composite).
 * 0058: user32 — window classes, the HWND tree, the blocking message
 * loop (GetMessage parks in the host's __sdl_pump_wait), WM_PAINT
 * damage, input routing, the standard controls (BUTTON/STATIC/EDIT/
 * LISTBOX/SCROLLBAR), MessageBox, and the agent tree served on
 * /run/win32/agent.<pid>.sock (wm_agent.h) that makes widgets
 * `wmctl click "OK"`-drivable. kernel32 is 0059.
 *
 * 0060: the port-corpus surface — the A/W split (WIN32.md friction #2:
 * implement W, shim A). IMPLEMENTED entries are the ANSI generic names
 * (the veneer's own sources #undef UNICODE); W variants and the whole
 * declaration-only corpus surface live in the marked section below, and
 * under UNICODE the generic names #define onto W at the end of the
 * header. Unimplemented declarations are the point: tools/win32ports.js
 * compiles the vendored ports (winmine/notepad/calc) against this header
 * and logs every undefined symbol into os/win32/PORTS.md — the
 * authoritative 0059+ backlog. Grow declarations with the corpus;
 * implement strictly to that log. WCHAR is 2-byte UTF-16 (u"..."
 * literals), NOT this libc's 4-byte wchar_t. Single-threaded by design
 * (WIN32.md friction #1): one message loop per process, no CreateThread.
 *
 * 0068: the user32/resource tail (winmine playable) — the user32/gdi32 W
 * entry points are IMPLEMENTED (per-window A/W marking; text messages
 * translate at user32's send_msg choke), plus menus (a user32-drawn bar
 * in the top SM_CYMENU pixels of the surface; the client area offsets
 * under it), accelerators, DialogBox templates, SetTimer/WM_TIMER, and
 * resources from a SIDECAR pack: tools/win32rc.js compiles the app's .rc
 * into `<binary>.res` next to the wasm binary (the PE resource section
 * analog; WRES format spec in that tool, loader in user32.c res_*).
 * UNICODE GUI ports whose entry is wWinMain list os/win32/wwinmain.c in
 * their bin.json sources (the CRT entry shim). Icons/cursors are stub
 * handles; PlaySoundW is a success stub (winmm.c).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <string.h>   /* CopyMemory/ZeroMemory expand to mem* */

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
#define VOID void   /* the winnt.h way: (VOID) must read as (void) */
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
typedef HANDLE HMENU;
typedef HANDLE HICON;
typedef HANDLE HCURSOR;
typedef int LONG_PTR, *PLONG_PTR;           /* ILP32 wasm */
typedef unsigned int UINT_PTR, ULONG_PTR, DWORD_PTR;
typedef int INT_PTR, SSIZE_T;
typedef unsigned int SIZE_T;
typedef long long INT64;
typedef unsigned long long UINT64, ULONG64, DWORD64;
#define __int64 long long
#define MAX_PATH 260
typedef unsigned short ATOM;
typedef int HRESULT;
typedef HANDLE HGLOBAL, HLOCAL, HRSRC, HKL, HDROP, HACCEL, HTHEME;

/* Wide characters: WCHAR is UTF-16 (2 bytes) like Windows — NOT this
 * libc's 4-byte wchar_t. Wide literals in ported code must be u"..."
 * (the TEXT()/_T() machinery pastes the u prefix); a bare L"..." is a
 * 4-byte-element literal and will not typecheck against WCHAR. */
typedef unsigned short WCHAR;
typedef WCHAR *LPWSTR, *PWSTR, *PWCHAR;
typedef const WCHAR *LPCWSTR, *PCWSTR;
#ifdef UNICODE
typedef WCHAR TCHAR;
typedef LPWSTR LPTSTR, PTSTR;
typedef LPCWSTR LPCTSTR, PCTSTR;
#define __TEXT(q) u ## q
#else
typedef CHAR TCHAR;
typedef LPSTR LPTSTR, PTSTR;
typedef LPCSTR LPCTSTR, PCTSTR;
#define __TEXT(q) q
#endif
#define TEXT(q) __TEXT(q)

#define MAKEINTRESOURCEA(i) ((LPSTR)(ULONG_PTR)(WORD)(i))
#define MAKEINTRESOURCEW(i) ((LPWSTR)(ULONG_PTR)(WORD)(i))
#ifdef UNICODE
#define MAKEINTRESOURCE MAKEINTRESOURCEW
#else
#define MAKEINTRESOURCE MAKEINTRESOURCEA
#endif

#define LOWORD(l)   ((WORD)((DWORD)(l) & 0xFFFF))
#define HIWORD(l)   ((WORD)(((DWORD)(l) >> 16) & 0xFFFF))
#define MAKELONG(a, b) ((LONG)(((WORD)(a)) | (((DWORD)(WORD)(b)) << 16)))
#define MAKEWPARAM(l, h) ((WPARAM)MAKELONG(l, h))
#define MAKELPARAM(l, h) ((LPARAM)MAKELONG(l, h))
#define GET_X_LPARAM(lp) ((int)(short)LOWORD(lp))
#define GET_Y_LPARAM(lp) ((int)(short)HIWORD(lp))
#define GET_WHEEL_DELTA_WPARAM(wp) ((short)HIWORD(wp))
#define WHEEL_DELTA 120

#ifndef TRUE
#define TRUE  1
#define FALSE 0
#endif
#ifndef NULL
#define NULL ((void *)0)
#endif
#define CALLBACK
#define WINAPI
#define APIENTRY
#define CONST const
#define IN
#define OUT
#define OPTIONAL
#define UNREFERENCED_PARAMETER(p) ((void)(p))
#define UNICODE_NULL ((WCHAR)0)
#define MAXLONG  0x7fffffff
#define MAXWORD  0xffff
#define MAXDWORD 0xffffffffu
#define _UI64_MAX 0xffffffffffffffffULL
#define _I64_MAX  0x7fffffffffffffffLL
/* ReactOS DEFAULT_UNREACHABLE: an unreachable default: arm */
#define DEFAULT_UNREACHABLE default: break
#ifndef max
#define max(a, b) (((a) > (b)) ? (a) : (b))
#endif
#ifndef min
#define min(a, b) (((a) < (b)) ? (a) : (b))
#endif
/* msvcrt float classification over this libc's math.h macros */
#define _isnan(x)  isnan(x)
#define _finite(x) isfinite(x)
#define CopyMemory(d, s, n) memcpy((d), (s), (n))
#define MoveMemory(d, s, n) memmove((d), (s), (n))
#define FillMemory(d, n, v) memset((d), (v), (n))
#define ZeroMemory(d, n)    memset((d), 0, (n))
#define RtlCopyMemory CopyMemory
#define RtlZeroMemory ZeroMemory

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
#define PHYSICALWIDTH   110
#define PHYSICALHEIGHT  111
#define PHYSICALOFFSETX 112
#define PHYSICALOFFSETY 113
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
#define DT_NOPREFIX   0x0800

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

/* GDI accounting (the 0057 leak-discipline probes; test-facing) */
int __gdi_object_count(void);
int __gdi_dc_count(void);

/* ================================================================
 * user32 (todos/0058): classes, windows, messages, input, controls.
 * ================================================================ */

typedef LRESULT (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);
typedef BOOL (*WNDENUMPROC)(HWND, LPARAM);

typedef struct tagMSG {
    HWND   hwnd;
    UINT   message;
    WPARAM wParam;
    LPARAM lParam;
    DWORD  time;
    POINT  pt;
} MSG, *PMSG, *LPMSG;

typedef struct tagWNDCLASS {
    UINT      style;
    WNDPROC   lpfnWndProc;
    int       cbClsExtra;
    int       cbWndExtra;
    HINSTANCE hInstance;
    HICON     hIcon;
    HCURSOR   hCursor;
    HBRUSH    hbrBackground;
    LPCSTR    lpszMenuName;
    LPCSTR    lpszClassName;
} WNDCLASS, *PWNDCLASS, *LPWNDCLASS, WNDCLASSA;

typedef struct tagWNDCLASSEX {
    UINT      cbSize;
    UINT      style;
    WNDPROC   lpfnWndProc;
    int       cbClsExtra;
    int       cbWndExtra;
    HINSTANCE hInstance;
    HICON     hIcon;
    HCURSOR   hCursor;
    HBRUSH    hbrBackground;
    LPCSTR    lpszMenuName;
    LPCSTR    lpszClassName;
    HICON     hIconSm;
} WNDCLASSEX, *PWNDCLASSEX, *LPWNDCLASSEX, WNDCLASSEXA;

typedef struct tagCREATESTRUCT {
    LPVOID    lpCreateParams;
    HINSTANCE hInstance;
    HMENU     hMenu;
    HWND      hwndParent;
    int       cy, cx, y, x;
    LONG      style;
    LPCSTR    lpszName;
    LPCSTR    lpszClass;
    DWORD     dwExStyle;
} CREATESTRUCT, *LPCREATESTRUCT;

/* Class styles */
#define CS_VREDRAW  0x0001
#define CS_HREDRAW  0x0002
#define CS_DBLCLKS  0x0008

/* Window styles (the honored subset; others parse and are ignored) */
#define WS_OVERLAPPED   0x00000000u
#define WS_TILED        WS_OVERLAPPED
#define WS_MAXIMIZEBOX  0x00010000u
#define WS_MINIMIZEBOX  0x00020000u
#define WS_THICKFRAME   0x00040000u
#define WS_SIZEBOX      WS_THICKFRAME     /* -> SDL_WINDOW_RESIZABLE */
#define WS_SYSMENU      0x00080000u
#define WS_HSCROLL      0x00100000u
#define WS_VSCROLL      0x00200000u
#define WS_DLGFRAME     0x00400000u
#define WS_BORDER       0x00800000u
#define WS_CAPTION      0x00C00000u
#define WS_MAXIMIZE     0x01000000u
#define WS_CLIPCHILDREN 0x02000000u
#define WS_CLIPSIBLINGS 0x04000000u
#define WS_DISABLED     0x08000000u
#define WS_VISIBLE      0x10000000u
#define WS_MINIMIZE     0x20000000u
#define WS_CHILD        0x40000000u
#define WS_POPUP        0x80000000u
#define WS_OVERLAPPEDWINDOW (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | \
                             WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
#define WS_TILEDWINDOW  WS_OVERLAPPEDWINDOW
#define WS_CHILDWINDOW  WS_CHILD
#define WS_GROUP        0x00020000u       /* aliases MINIMIZEBOX (child ctx) */
#define WS_TABSTOP      0x00010000u       /* aliases MAXIMIZEBOX (child ctx) */
#define WS_EX_CLIENTEDGE 0x00000200u

#define CW_USEDEFAULT   ((int)0x80000000)

/* ShowWindow */
#define SW_HIDE          0
#define SW_SHOWNORMAL    1
#define SW_NORMAL        1
#define SW_SHOWMINIMIZED 2
#define SW_SHOWMAXIMIZED 3
#define SW_MAXIMIZE      3
#define SW_SHOWNOACTIVATE 4
#define SW_SHOW          5
#define SW_MINIMIZE      6
#define SW_SHOWMINNOACTIVE 7
#define SW_SHOWNA        8
#define SW_RESTORE       9
#define SW_SHOWDEFAULT   10

/* Messages */
#define WM_NULL          0x0000
#define WM_CREATE        0x0001
#define WM_DESTROY       0x0002
#define WM_MOVE          0x0003
#define WM_SIZE          0x0005
#define WM_SETFOCUS      0x0007
#define WM_KILLFOCUS     0x0008
#define WM_ENABLE        0x000A
#define WM_SETTEXT       0x000C
#define WM_GETTEXT       0x000D
#define WM_GETTEXTLENGTH 0x000E
#define WM_PAINT         0x000F
#define WM_CLOSE         0x0010
#define WM_QUIT          0x0012
#define WM_ERASEBKGND    0x0014
#define WM_SHOWWINDOW    0x0018
#define WM_SETCURSOR     0x0020
#define WM_QUERYENDSESSION 0x0011
#define WM_ENDSESSION    0x0016
#define WM_SETFONT       0x0030
#define WM_GETFONT       0x0031
#define WM_SETICON       0x0080
#define ICON_SMALL 0
#define ICON_BIG   1
#define WM_CTLCOLOREDIT   0x0133
#define WM_CTLCOLORLISTBOX 0x0134
#define WM_CTLCOLORBTN    0x0135
#define WM_CTLCOLORDLG    0x0136
#define WM_CTLCOLORSCROLLBAR 0x0137
#define WM_CTLCOLORSTATIC 0x0138
#define WM_CUT           0x0300
#define WM_COPY          0x0301
#define WM_PASTE         0x0302
#define WM_CLEAR         0x0303
#define WM_UNDO          0x0304
#define WM_GETDLGCODE    0x0087
#define WM_KEYDOWN       0x0100
#define WM_KEYUP         0x0101
#define WM_CHAR          0x0102
#define WM_COMMAND       0x0111
#define WM_SYSCOMMAND    0x0112
#define WM_TIMER         0x0113   /* declared; SetTimer is a 0060 growth item */
#define WM_INITMENU      0x0116
#define WM_INITMENUPOPUP 0x0117
#define WM_MENUSELECT    0x011F
#define WM_CONTEXTMENU   0x007B
#define WM_DRAWITEM      0x002B
#define WM_MEASUREITEM   0x002C
#define WM_HSCROLL       0x0114
#define WM_VSCROLL       0x0115
#define WM_MOUSEMOVE     0x0200
#define WM_LBUTTONDOWN   0x0201
#define WM_LBUTTONUP     0x0202
#define WM_LBUTTONDBLCLK 0x0203
#define WM_RBUTTONDOWN   0x0204
#define WM_RBUTTONUP     0x0205
#define WM_RBUTTONDBLCLK 0x0206
#define WM_MBUTTONDOWN   0x0207
#define WM_MBUTTONUP     0x0208
#define WM_MBUTTONDBLCLK 0x0209
#define WM_MOUSEWHEEL    0x020A
#define WM_USER          0x0400
#define WM_APP           0x8000

/* WM_SIZE wParam */
#define SIZE_RESTORED  0
#define SIZE_MINIMIZED 1
#define SIZE_MAXIMIZED 2

/* Mouse-message wParam masks */
#define MK_LBUTTON  0x0001
#define MK_RBUTTON  0x0002
#define MK_SHIFT    0x0004
#define MK_CONTROL  0x0008
#define MK_MBUTTON  0x0010

/* Virtual keys */
#define VK_BACK    0x08
#define VK_TAB     0x09
#define VK_RETURN  0x0D
#define VK_SHIFT   0x10
#define VK_CONTROL 0x11
#define VK_MENU    0x12
#define VK_ESCAPE  0x1B
#define VK_SPACE   0x20
#define VK_PRIOR   0x21
#define VK_NEXT    0x22
#define VK_END     0x23
#define VK_HOME    0x24
#define VK_LEFT    0x25
#define VK_UP      0x26
#define VK_RIGHT   0x27
#define VK_DOWN    0x28
#define VK_INSERT  0x2D
#define VK_DELETE  0x2E
#define VK_F1      0x70
#define VK_F2      0x71
#define VK_F3      0x72
#define VK_F4      0x73
#define VK_F5      0x74
#define VK_F6      0x75
#define VK_F7      0x76
#define VK_F8      0x77
#define VK_F9      0x78
#define VK_F10     0x79
#define VK_F11     0x7A
#define VK_F12     0x7B

/* PeekMessage */
#define PM_NOREMOVE 0
#define PM_REMOVE   1

/* GetWindowLongPtr indices */
#define GWL_WNDPROC   (-4)
#define GWLP_WNDPROC  (-4)
#define GWL_STYLE     (-16)
#define GWL_EXSTYLE   (-20)
#define GWL_ID        (-12)
#define GWLP_ID       (-12)
#define GWL_USERDATA  (-21)
#define GWLP_USERDATA (-21)

/* System colors (Win95 palette; GetSysColor/GetSysColorBrush).
 * (HBRUSH)(COLOR_x + 1) works as WNDCLASS.hbrBackground, like Windows. */
#define COLOR_SCROLLBAR      0
#define COLOR_BACKGROUND     1
#define COLOR_ACTIVECAPTION  2
#define COLOR_MENU           4
#define COLOR_WINDOW         5
#define COLOR_WINDOWFRAME    6
#define COLOR_MENUTEXT       7
#define COLOR_WINDOWTEXT     8
#define COLOR_HIGHLIGHT      13
#define COLOR_HIGHLIGHTTEXT  14
#define COLOR_BTNFACE        15
#define COLOR_3DFACE         COLOR_BTNFACE
#define COLOR_BTNSHADOW      16
#define COLOR_3DSHADOW       COLOR_BTNSHADOW
#define COLOR_GRAYTEXT       17
#define COLOR_BTNTEXT        18
#define COLOR_BTNHIGHLIGHT   20
#define COLOR_3DHIGHLIGHT    COLOR_BTNHIGHLIGHT
#define COLOR_3DDKSHADOW     21

/* Button styles (WNDCLASS "BUTTON") */
#define BS_PUSHBUTTON      0x0
#define BS_DEFPUSHBUTTON   0x1
#define BS_CHECKBOX        0x2
#define BS_AUTOCHECKBOX    0x3
#define BS_RADIOBUTTON     0x4
#define BS_AUTORADIOBUTTON 0x9
#define BS_GROUPBOX        0x7
#define BS_OWNERDRAW       0xB
/* Button messages / notifications */
#define BM_GETCHECK  0x00F0
#define BM_SETCHECK  0x00F1
#define BM_SETSTATE  0x00F3
#define BM_CLICK     0x00F5
#define BST_UNCHECKED 0
#define BST_CHECKED   1
#define BN_CLICKED    0
#define BN_DOUBLECLICKED 5
#define BN_DBLCLK     BN_DOUBLECLICKED

/* Static styles */
#define SS_LEFT   0x0
#define SS_CENTER 0x1
#define SS_RIGHT  0x2

/* Edit styles */
#define ES_LEFT        0x0000
#define ES_CENTER      0x0001
#define ES_RIGHT       0x0002
#define ES_MULTILINE   0x0004
#define ES_UPPERCASE   0x0008
#define ES_LOWERCASE   0x0010
#define ES_PASSWORD    0x0020
#define ES_AUTOVSCROLL 0x0040
#define ES_AUTOHSCROLL 0x0080
#define ES_NOHIDESEL   0x0100
#define ES_OEMCONVERT  0x0400
#define ES_WANTRETURN  0x1000
#define ES_READONLY    0x0800
/* Edit messages / notifications */
#define EM_GETSEL       0x00B0
#define EM_SETSEL       0x00B1
#define EM_SCROLLCARET  0x00B7
#define EM_GETMODIFY    0x00B8
#define EM_SETMODIFY    0x00B9
#define EM_GETLINECOUNT 0x00BA
#define EM_LINEINDEX    0x00BB
#define EM_SETHANDLE    0x00BC
#define EM_GETHANDLE    0x00BD
#define EM_GETLINE      0x00C4
#define EM_LIMITTEXT    0x00C5
#define EM_CANUNDO      0x00C6
#define EM_UNDO         0x00C7
#define EM_LINEFROMCHAR 0x00C9
#define EM_REPLACESEL   0x00C2
#define EM_EMPTYUNDOBUFFER 0x00CD
#define EM_GETFIRSTVISIBLELINE 0x00CE
#define EM_SETREADONLY  0x00CF
#define EN_SETFOCUS  0x0100
#define EN_KILLFOCUS 0x0200
#define EN_CHANGE  0x0300
#define EN_UPDATE  0x0400
#define EN_ERRSPACE 0x0500
#define EN_MAXTEXT  0x0501
#define EN_HSCROLL  0x0601
#define EN_VSCROLL  0x0602

/* Listbox messages / notifications */
#define LB_ADDSTRING    0x0180
#define LB_RESETCONTENT 0x0184
#define LB_SETCURSEL    0x0186
#define LB_GETCURSEL    0x0188
#define LB_GETTEXT      0x0189
#define LB_GETTEXTLEN   0x018A
#define LB_GETCOUNT     0x018B
#define LB_DELETESTRING 0x0182
#define LB_ERR          (-1)
#define LBN_SELCHANGE 1
#define LBN_DBLCLK    2

/* Scrollbar styles / codes */
#define SBS_HORZ 0x0
#define SBS_VERT 0x1
#define SB_HORZ 0
#define SB_VERT 1
#define SB_CTL  2
#define SB_LINEUP        0
#define SB_LINELEFT      0
#define SB_LINEDOWN      1
#define SB_LINERIGHT     1
#define SB_PAGEUP        2
#define SB_PAGELEFT      2
#define SB_PAGEDOWN      3
#define SB_PAGERIGHT     3
#define SB_THUMBPOSITION 4
#define SB_THUMBTRACK    5
#define SB_ENDSCROLL     8

/* MessageBox */
#define MB_OK           0x0000
#define MB_OKCANCEL     0x0001
#define MB_ABORTRETRYIGNORE 0x0002
#define MB_YESNOCANCEL  0x0003
#define MB_YESNO        0x0004
#define MB_RETRYCANCEL  0x0005
#define MB_ICONERROR    0x0010
#define MB_ICONHAND     0x0010
#define MB_ICONSTOP     0x0010
#define MB_ICONQUESTION 0x0020
#define MB_ICONWARNING  0x0030
#define MB_ICONEXCLAMATION 0x0030
#define MB_ICONINFORMATION 0x0040
#define MB_ICONASTERISK 0x0040
#define MB_ICONMASK     0x00F0
#define MB_DEFBUTTON1   0x0000
#define MB_DEFBUTTON2   0x0100
#define MB_DEFBUTTON3   0x0200
#define MB_APPLMODAL    0x0000
#define MB_TASKMODAL    0x2000
#define IDOK     1
#define IDCANCEL 2
#define IDABORT  3
#define IDRETRY  4
#define IDIGNORE 5
#define IDYES    6
#define IDNO     7
#define IDHELP   9

/* Combo box (declared for the corpus; the control is 0059+ demand) */
#define CBS_SIMPLE       0x0001
#define CBS_DROPDOWN     0x0002
#define CBS_DROPDOWNLIST 0x0003
#define CB_ADDSTRING    0x0143
#define CB_GETCOUNT     0x0146
#define CB_GETCURSEL    0x0147
#define CB_GETLBTEXT    0x0148
#define CB_GETLBTEXTLEN 0x0149
#define CB_RESETCONTENT 0x014B
#define CB_SETCURSEL    0x014E
#define CB_ERR          (-1)
#define CBN_SELCHANGE   1
#define CBN_DBLCLK      2

/* ---------------- user32 API ---------------- */

ATOM RegisterClass(const WNDCLASS *wc);
ATOM RegisterClassEx(const WNDCLASSEX *wc);
HWND CreateWindowEx(DWORD exStyle, LPCSTR className, LPCSTR windowName,
                    DWORD style, int x, int y, int w, int h,
                    HWND parent, HMENU menu, HINSTANCE inst, LPVOID param);
#define CreateWindow(cls, name, style, x, y, w, h, parent, menu, inst, param) \
    CreateWindowEx(0, cls, name, style, x, y, w, h, parent, menu, inst, param)
BOOL DestroyWindow(HWND hwnd);
LRESULT DefWindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
LRESULT CallWindowProc(WNDPROC proc, HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

BOOL GetMessage(MSG *msg, HWND hwnd, UINT filterMin, UINT filterMax);
BOOL PeekMessage(MSG *msg, HWND hwnd, UINT filterMin, UINT filterMax, UINT remove);
BOOL TranslateMessage(const MSG *msg);
LRESULT DispatchMessage(const MSG *msg);
LRESULT SendMessage(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
BOOL PostMessage(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
void PostQuitMessage(int exitCode);

BOOL ShowWindow(HWND hwnd, int cmd);
BOOL UpdateWindow(HWND hwnd);
BOOL InvalidateRect(HWND hwnd, const RECT *r, BOOL erase);
BOOL GetClientRect(HWND hwnd, RECT *r);
BOOL GetWindowRect(HWND hwnd, RECT *r);   /* top-level-client coords (no
                                             global screen space here) */
BOOL MoveWindow(HWND hwnd, int x, int y, int w, int h, BOOL repaint);
BOOL IsWindowVisible(HWND hwnd);
BOOL EnableWindow(HWND hwnd, BOOL enable);
BOOL IsWindowEnabled(HWND hwnd);
BOOL IsWindow(HWND hwnd);

HWND SetFocus(HWND hwnd);
HWND GetFocus(void);
HWND SetCapture(HWND hwnd);
BOOL ReleaseCapture(void);
HWND GetCapture(void);

HWND GetParent(HWND hwnd);
HWND GetDlgItem(HWND parent, int id);
int  GetDlgCtrlID(HWND hwnd);
BOOL EnumChildWindows(HWND parent, WNDENUMPROC fn, LPARAM lp);
int  GetWindowText(HWND hwnd, LPSTR buf, int max);
BOOL SetWindowText(HWND hwnd, LPCSTR text);
int  GetWindowTextLength(HWND hwnd);
LONG_PTR GetWindowLongPtr(HWND hwnd, int index);
LONG_PTR SetWindowLongPtr(HWND hwnd, int index, LONG_PTR value);
#define GetWindowLong  GetWindowLongPtr
#define SetWindowLong  SetWindowLongPtr

SHORT GetKeyState(int vk);

int  SetScrollPos(HWND hwnd, int bar, int pos, BOOL redraw);
int  GetScrollPos(HWND hwnd, int bar);
BOOL SetScrollRange(HWND hwnd, int bar, int min, int max, BOOL redraw);
BOOL GetScrollRange(HWND hwnd, int bar, LPINT min, LPINT max);

int MessageBox(HWND owner, LPCSTR text, LPCSTR caption, UINT type);

DWORD    GetSysColor(int index);
HBRUSH   GetSysColorBrush(int index);

/* ================================================================
 * The 0060 port-corpus surface (todos/0060, design todos/WIN32.md).
 *
 * Everything below is DECLARATION-ONLY unless os/win32/{gdi32,user32}.c
 * (or a later veneer slice) implements it: ported apps compile against
 * these types and prototypes, and every symbol still unimplemented
 * surfaces as a link error that tools/win32ports.js logs into
 * os/win32/PORTS.md — the authoritative 0059+ backlog. Grow this surface
 * with the corpus; implement strictly to that log's demand.
 *
 * Charset model (WIN32.md friction #2 — implement W, shim A): the
 * IMPLEMENTED functions are the ANSI generic names; W variants are
 * declared and, under UNICODE, the generic names #define to them at the
 * end of this header. The veneer's own sources #undef UNICODE.
 * ================================================================ */

/* ---------------- winerror crumbs ---------------- */

#define ERROR_SUCCESS              0
#define ERROR_FILE_NOT_FOUND       2
#define ERROR_PATH_NOT_FOUND       3
#define ERROR_TOO_MANY_OPEN_FILES  4
#define ERROR_ACCESS_DENIED        5
#define ERROR_INVALID_HANDLE       6
#define ERROR_NOT_ENOUGH_MEMORY    8
#define ERROR_NO_MORE_FILES        18
#define ERROR_WRITE_PROTECT        19
#define ERROR_SEEK                 25
#define ERROR_GEN_FAILURE          31
#define ERROR_HANDLE_EOF           38
#define ERROR_NOT_SUPPORTED        50
#define ERROR_INVALID_PARAMETER    87
#define ERROR_BROKEN_PIPE          109
#define ERROR_DISK_FULL            112
#define ERROR_CALL_NOT_IMPLEMENTED 120
#define ERROR_INSUFFICIENT_BUFFER  122
#define ERROR_INVALID_NAME         123
#define ERROR_PROC_NOT_FOUND       127
#define ERROR_NEGATIVE_SEEK        131
#define ERROR_DIR_NOT_EMPTY        145
#define ERROR_ALREADY_EXISTS       183
#define ERROR_FILENAME_EXCED_RANGE 206
#define ERROR_FILE_TOO_LARGE       223
#define ERROR_MORE_DATA            234
#define ERROR_NO_MORE_ITEMS        259
#define NO_ERROR                   0
#define S_OK                       ((HRESULT)0)
#define S_FALSE                    ((HRESULT)1)
#define E_FAIL                     ((HRESULT)0x80004005)
#define E_NOTIMPL                  ((HRESULT)0x80004001)
#define SUCCEEDED(hr) (((HRESULT)(hr)) >= 0)
#define FAILED(hr)    (((HRESULT)(hr)) < 0)

/* ---------------- W-variant structs ---------------- */

typedef struct tagLOGFONTW {
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
    WCHAR lfFaceName[LF_FACESIZE];
} LOGFONTW, *PLOGFONTW, *LPLOGFONTW;

typedef struct tagTEXTMETRICW {
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
    WCHAR tmFirstChar;
    WCHAR tmLastChar;
    WCHAR tmDefaultChar;
    WCHAR tmBreakChar;
    BYTE tmItalic;
    BYTE tmUnderlined;
    BYTE tmStruckOut;
    BYTE tmPitchAndFamily;
    BYTE tmCharSet;
} TEXTMETRICW, *PTEXTMETRICW, *LPTEXTMETRICW;

typedef struct tagWNDCLASSW {
    UINT      style;
    WNDPROC   lpfnWndProc;
    int       cbClsExtra;
    int       cbWndExtra;
    HINSTANCE hInstance;
    HICON     hIcon;
    HCURSOR   hCursor;
    HBRUSH    hbrBackground;
    LPCWSTR   lpszMenuName;
    LPCWSTR   lpszClassName;
} WNDCLASSW, *PWNDCLASSW, *LPWNDCLASSW;

typedef struct tagWNDCLASSEXW {
    UINT      cbSize;
    UINT      style;
    WNDPROC   lpfnWndProc;
    int       cbClsExtra;
    int       cbWndExtra;
    HINSTANCE hInstance;
    HICON     hIcon;
    HCURSOR   hCursor;
    HBRUSH    hbrBackground;
    LPCWSTR   lpszMenuName;
    LPCWSTR   lpszClassName;
    HICON     hIconSm;
} WNDCLASSEXW, *PWNDCLASSEXW, *LPWNDCLASSEXW;

typedef struct tagCREATESTRUCTW {
    LPVOID    lpCreateParams;
    HINSTANCE hInstance;
    HMENU     hMenu;
    HWND      hwndParent;
    int       cy, cx, y, x;
    LONG      style;
    LPCWSTR   lpszName;
    LPCWSTR   lpszClass;
    DWORD     dwExStyle;
} CREATESTRUCTW, *LPCREATESTRUCTW;

/* ---------------- W prototypes for the implemented ANSI set ---------- */

BOOL TextOutW(HDC hdc, int x, int y, LPCWSTR str, int len);
BOOL ExtTextOutW(HDC hdc, int x, int y, UINT options, const RECT *r,
                 LPCWSTR str, UINT len, const INT *dx);
int  DrawTextW(HDC hdc, LPCWSTR str, int len, RECT *r, UINT format);
BOOL GetTextExtentPoint32W(HDC hdc, LPCWSTR str, int len, SIZE *size);
BOOL GetTextMetricsW(HDC hdc, TEXTMETRICW *tm);
HFONT CreateFontW(int height, int width, int escapement, int orientation,
                  int weight, DWORD italic, DWORD underline, DWORD strikeout,
                  DWORD charset, DWORD outPrecision, DWORD clipPrecision,
                  DWORD quality, DWORD pitchAndFamily, LPCWSTR faceName);
HFONT CreateFontIndirectW(const LOGFONTW *lf);
int  GetObjectW(HGDIOBJ obj, int size, void *out);
ATOM RegisterClassW(const WNDCLASSW *wc);
ATOM RegisterClassExW(const WNDCLASSEXW *wc);
HWND CreateWindowExW(DWORD exStyle, LPCWSTR className, LPCWSTR windowName,
                     DWORD style, int x, int y, int w, int h,
                     HWND parent, HMENU menu, HINSTANCE inst, LPVOID param);
#define CreateWindowW(cls, name, style, x, y, w, h, parent, menu, inst, param) \
    CreateWindowExW(0, cls, name, style, x, y, w, h, parent, menu, inst, param)
LRESULT DefWindowProcW(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
BOOL GetMessageW(MSG *msg, HWND hwnd, UINT filterMin, UINT filterMax);
BOOL PeekMessageW(MSG *msg, HWND hwnd, UINT filterMin, UINT filterMax, UINT remove);
LRESULT DispatchMessageW(const MSG *msg);
LRESULT SendMessageW(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
BOOL PostMessageW(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
int  GetWindowTextW(HWND hwnd, LPWSTR buf, int max);
BOOL SetWindowTextW(HWND hwnd, LPCWSTR text);
int  GetWindowTextLengthW(HWND hwnd);
LONG_PTR GetWindowLongPtrW(HWND hwnd, int index);
LONG_PTR SetWindowLongPtrW(HWND hwnd, int index, LONG_PTR value);
int  MessageBoxW(HWND owner, LPCWSTR text, LPCWSTR caption, UINT type);
BOOL IsDialogMessageW(HWND hDlg, MSG *msg);

/* ---------------- kernel32 (implemented by kernel32.c, todos/0059) ----
 * kernel32 is W-NATIVE, unlike gdi32/user32: it arrived with the UNICODE
 * port corpus, so the W names are the implemented symbols and there are
 * no ANSI generic entries (they grow if an ANSI corpus app ever demands
 * one). The UNICODE generic->W maps sit right after each block. -------- */

typedef struct _SYSTEMTIME {
    WORD wYear;
    WORD wMonth;
    WORD wDayOfWeek;
    WORD wDay;
    WORD wHour;
    WORD wMinute;
    WORD wSecond;
    WORD wMilliseconds;
} SYSTEMTIME, *PSYSTEMTIME, *LPSYSTEMTIME;

typedef struct _OSVERSIONINFOW {
    DWORD dwOSVersionInfoSize;
    DWORD dwMajorVersion;
    DWORD dwMinorVersion;
    DWORD dwBuildNumber;
    DWORD dwPlatformId;
    WCHAR szCSDVersion[128];
} OSVERSIONINFOW, *POSVERSIONINFOW, *LPOSVERSIONINFOW;
#ifdef UNICODE
#define OSVERSIONINFO OSVERSIONINFOW
#define LPOSVERSIONINFO LPOSVERSIONINFOW
#endif

#define INVALID_HANDLE_VALUE ((HANDLE)(LONG_PTR)-1)
#define GENERIC_READ  0x80000000u
#define GENERIC_WRITE 0x40000000u
#define FILE_SHARE_READ  0x1
#define FILE_SHARE_WRITE 0x2
#define CREATE_NEW    1
#define CREATE_ALWAYS 2
#define OPEN_EXISTING 3
#define OPEN_ALWAYS   4
#define FILE_ATTRIBUTE_NORMAL 0x80
#define FILE_BEGIN   0
#define FILE_CURRENT 1
#define FILE_END     2
#define INVALID_FILE_SIZE 0xFFFFFFFFu
#define INVALID_SET_FILE_POINTER 0xFFFFFFFFu

#define GMEM_FIXED    0x0000
#define GMEM_MOVEABLE 0x0002
#define GMEM_ZEROINIT 0x0040
#define GMEM_DDESHARE 0x2000
#define GHND (GMEM_MOVEABLE | GMEM_ZEROINIT)
#define GPTR (GMEM_FIXED | GMEM_ZEROINIT)
#define LMEM_FIXED    0x0000
#define LMEM_MOVEABLE 0x0002
#define LMEM_ZEROINIT 0x0040
#define LPTR (LMEM_FIXED | LMEM_ZEROINIT)

#define CP_ACP  0
#define CP_OEMCP 1
#define CP_UTF8 65001
#define MB_PRECOMPOSED 0x0001

DWORD  GetLastError(void);
void   SetLastError(DWORD err);
HANDLE CreateFileW(LPCWSTR name, DWORD access, DWORD share, void *sa,
                   DWORD creation, DWORD flagsAttrs, HANDLE template_);
BOOL   ReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD read, void *ov);
BOOL   WriteFile(HANDLE h, LPCVOID buf, DWORD n, LPDWORD written, void *ov);
DWORD  SetFilePointer(HANDLE h, LONG dist, PLONG distHigh, DWORD method);
DWORD  GetFileSize(HANDLE h, LPDWORD sizeHigh);
BOOL   SetEndOfFile(HANDLE h);
BOOL   FlushFileBuffers(HANDLE h);
BOOL   CloseHandle(HANDLE h);
BOOL   DeleteFileW(LPCWSTR name);
DWORD  GetFileAttributesW(LPCWSTR name);
HGLOBAL GlobalAlloc(UINT flags, SIZE_T bytes);
LPVOID  GlobalLock(HGLOBAL h);
BOOL    GlobalUnlock(HGLOBAL h);
HGLOBAL GlobalFree(HGLOBAL h);
SIZE_T  GlobalSize(HGLOBAL h);
HLOCAL  LocalAlloc(UINT flags, SIZE_T bytes);
LPVOID  LocalLock(HLOCAL h);
BOOL    LocalUnlock(HLOCAL h);
HLOCAL  LocalFree(HLOCAL h);
HANDLE  GetProcessHeap(void);
LPVOID  HeapAlloc(HANDLE heap, DWORD flags, SIZE_T bytes);
LPVOID  HeapReAlloc(HANDLE heap, DWORD flags, LPVOID p, SIZE_T bytes);
BOOL    HeapFree(HANDLE heap, DWORD flags, LPVOID p);
#define HEAP_ZERO_MEMORY 0x8
void   ExitProcess(UINT code);
typedef DWORD (*LPTHREAD_START_ROUTINE)(LPVOID);
HANDLE CreateThread(void *sa, SIZE_T stack, LPTHREAD_START_ROUTINE fn,
                    LPVOID param, DWORD flags, LPDWORD tid);
UINT   GetProfileIntW(LPCWSTR app, LPCWSTR key, INT deflt);
BOOL   WriteProfileStringW(LPCWSTR app, LPCWSTR key, LPCWSTR value);
void   GetLocalTime(SYSTEMTIME *st);
void   GetSystemTime(SYSTEMTIME *st);
DWORD  GetTickCount(void);
void   Sleep(DWORD ms);
BOOL   GetVersionExW(OSVERSIONINFOW *vi);
HMODULE GetModuleHandleW(LPCWSTR name);
LPWSTR GetCommandLineW(void);
DWORD  GetModuleFileNameW(HMODULE mod, LPWSTR buf, DWORD n);
int    MultiByteToWideChar(UINT cp, DWORD flags, LPCSTR src, int srcLen,
                           LPWSTR dst, int dstLen);
int    WideCharToMultiByte(UINT cp, DWORD flags, LPCWSTR src, int srcLen,
                           LPSTR dst, int dstLen, LPCSTR defChar, LPBOOL used);
#define INVALID_FILE_ATTRIBUTES 0xFFFFFFFFu
#define VER_PLATFORM_WIN32s        0
#define VER_PLATFORM_WIN32_WINDOWS 1
#define VER_PLATFORM_WIN32_NT      2

/* File mapping (notepad reads files through a view) */
#define PAGE_READONLY  0x02
#define PAGE_READWRITE 0x04
#define FILE_MAP_READ  0x0004
#define FILE_MAP_WRITE 0x0002
HANDLE CreateFileMappingW(HANDLE file, void *sa, DWORD protect,
                          DWORD sizeHigh, DWORD sizeLow, LPCWSTR name);
LPVOID MapViewOfFile(HANDLE mapping, DWORD access, DWORD offHigh,
                     DWORD offLow, SIZE_T bytes);
BOOL   UnmapViewOfFile(LPCVOID base);

/* Dynamic loading (calc binds uxtheme/htmlhelp at runtime) */
typedef INT_PTR (*FARPROC)(void);
HMODULE LoadLibraryW(LPCWSTR name);
FARPROC GetProcAddress(HMODULE mod, LPCSTR name);
BOOL    FreeLibrary(HMODULE mod);

/* NLS crumbs (winnls.h territory; single-file here) */
typedef WORD LANGID;
typedef DWORD LCID, LCTYPE;
#define MAKELANGID(p, s) ((LANGID)((((WORD)(s)) << 10) | (WORD)(p)))
#define PRIMARYLANGID(l) ((WORD)(l) & 0x3ff)
#define SUBLANGID(l)     ((WORD)(l) >> 10)
#define LANG_NEUTRAL  0x00
#define LANG_CHINESE  0x04
#define LANG_ENGLISH  0x09
#define LANG_HEBREW   0x0d
#define LANG_ARABIC   0x01
#define LANG_JAPANESE 0x11
#define LANG_KOREAN   0x12
#define SUBLANG_NEUTRAL 0
#define SUBLANG_DEFAULT 1
#define LOCALE_USER_DEFAULT ((LCID)0x0400)
#define LOCALE_SDECIMAL  14
#define LOCALE_STHOUSAND 15
#define DATE_LONGDATE 0x0002
LANGID GetUserDefaultLangID(void);
LANGID GetUserDefaultUILanguage(void);
LCID   GetUserDefaultLCID(void);
DWORD  GetFullPathNameW(LPCWSTR name, DWORD n, LPWSTR buf, LPWSTR *filePart);
int    GetLocaleInfoW(LCID lcid, LCTYPE type, LPWSTR buf, int n);
int    GetDateFormatW(LCID lcid, DWORD flags, const SYSTEMTIME *st,
                      LPCWSTR fmt, LPWSTR buf, int n);
int    GetTimeFormatW(LCID lcid, DWORD flags, const SYSTEMTIME *st,
                      LPCWSTR fmt, LPWSTR buf, int n);
#define MB_ERR_INVALID_CHARS 0x0008
#define IS_TEXT_UNICODE_ASCII16             0x0001
#define IS_TEXT_UNICODE_STATISTICS          0x0002
#define IS_TEXT_UNICODE_SIGNATURE           0x0008
#define IS_TEXT_UNICODE_REVERSE_ASCII16     0x0010
#define IS_TEXT_UNICODE_REVERSE_STATISTICS  0x0020
#define IS_TEXT_UNICODE_REVERSE_SIGNATURE   0x0080
#define IS_TEXT_UNICODE_REVERSE_MASK        0x00F0
BOOL IsTextUnicode(LPCVOID buf, int len, LPINT result);

int    lstrlenW(LPCWSTR s);
int    lstrlenA(LPCSTR s);
LPWSTR lstrcpyW(LPWSTR dst, LPCWSTR src);
LPWSTR lstrcpynW(LPWSTR dst, LPCWSTR src, int n);
LPWSTR lstrcatW(LPWSTR dst, LPCWSTR src);
int    lstrcmpW(LPCWSTR a, LPCWSTR b);
int    lstrcmpiW(LPCWSTR a, LPCWSTR b);
DWORD  FormatMessageW(DWORD flags, LPCVOID src, DWORD msgId, DWORD langId,
                      LPWSTR buf, DWORD n, va_list *args);
#define FORMAT_MESSAGE_ALLOCATE_BUFFER 0x0100
#define FORMAT_MESSAGE_FROM_SYSTEM     0x1000
#define FORMAT_MESSAGE_IGNORE_INSERTS  0x0200
void   OutputDebugStringW(LPCWSTR s);
#ifdef UNICODE
#define CreateFile CreateFileW
#define DeleteFile DeleteFileW
#define GetFileAttributes GetFileAttributesW
#define GetVersionEx GetVersionExW
#define GetModuleHandle GetModuleHandleW
#define GetCommandLine GetCommandLineW
#define GetModuleFileName GetModuleFileNameW
#define lstrlen lstrlenW
#define lstrcpy lstrcpyW
#define lstrcpyn lstrcpynW
#define lstrcat lstrcatW
#define lstrcmp lstrcmpW
#define lstrcmpi lstrcmpiW
#define FormatMessage FormatMessageW
#define OutputDebugString OutputDebugStringW
#define LoadLibrary LoadLibraryW
#define GetLocaleInfo GetLocaleInfoW
#define GetDateFormat GetDateFormatW
#define GetTimeFormat GetTimeFormatW
#define CreateFileMapping CreateFileMappingW
#define GetProfileInt GetProfileIntW
#define WriteProfileString WriteProfileStringW
#define GetFullPathName GetFullPathNameW
#endif

/* ---------------- kernel32 growth: dirs/find/process/timing (0059) --- */

#define TRUNCATE_EXISTING 5
#define FILE_ATTRIBUTE_READONLY  0x00000001u
#define FILE_ATTRIBUTE_HIDDEN    0x00000002u
#define FILE_ATTRIBUTE_SYSTEM    0x00000004u
#define FILE_ATTRIBUTE_DIRECTORY 0x00000010u
#define FILE_ATTRIBUTE_ARCHIVE   0x00000020u

typedef struct _FILETIME {          /* 100ns ticks since 1601-01-01 */
    DWORD dwLowDateTime;
    DWORD dwHighDateTime;
} FILETIME, *PFILETIME, *LPFILETIME;

typedef union _LARGE_INTEGER {
    struct { DWORD LowPart; LONG HighPart; };
    LONGLONG QuadPart;
} LARGE_INTEGER, *PLARGE_INTEGER;

typedef struct _WIN32_FIND_DATAW {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    DWORD nFileSizeHigh, nFileSizeLow;
    DWORD dwReserved0, dwReserved1;
    WCHAR cFileName[MAX_PATH];
    WCHAR cAlternateFileName[14];
} WIN32_FIND_DATAW, *PWIN32_FIND_DATAW, *LPWIN32_FIND_DATAW;

HANDLE FindFirstFileW(LPCWSTR pattern, WIN32_FIND_DATAW *fd);
BOOL   FindNextFileW(HANDLE h, WIN32_FIND_DATAW *fd);
BOOL   FindClose(HANDLE h);
BOOL   CreateDirectoryW(LPCWSTR path, void *sa);
BOOL   RemoveDirectoryW(LPCWSTR path);
BOOL   MoveFileW(LPCWSTR from, LPCWSTR to);
BOOL   SetFileAttributesW(LPCWSTR path, DWORD attrs);
DWORD  GetCurrentDirectoryW(DWORD n, LPWSTR buf);
BOOL   SetCurrentDirectoryW(LPCWSTR path);

#define STD_INPUT_HANDLE  ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE  ((DWORD)-12)
HANDLE GetStdHandle(DWORD which);

/* CreateProcess -> the owner-brokered posix_spawn (WIN32.md: kernel32
 * over POSIX, no kernel change). lpEnvironment must be NULL (children
 * inherit); STARTF_USESTDHANDLES maps to spawn fd-actions. */
typedef struct _STARTUPINFOW {
    DWORD  cb;
    LPWSTR lpReserved, lpDesktop, lpTitle;
    DWORD  dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
    DWORD  dwFillAttribute, dwFlags;
    WORD   wShowWindow, cbReserved2;
    LPBYTE lpReserved2;
    HANDLE hStdInput, hStdOutput, hStdError;
} STARTUPINFOW, *LPSTARTUPINFOW;
typedef struct _PROCESS_INFORMATION {
    HANDLE hProcess, hThread;
    DWORD dwProcessId, dwThreadId;
} PROCESS_INFORMATION, *PPROCESS_INFORMATION, *LPPROCESS_INFORMATION;
#define STARTF_USESHOWWINDOW 0x00000001u
#define STARTF_USESTDHANDLES 0x00000100u
#define CREATE_NEW_CONSOLE    0x00000010u
#define CREATE_NO_WINDOW      0x08000000u
#define NORMAL_PRIORITY_CLASS 0x00000020u
BOOL CreateProcessW(LPCWSTR app, LPWSTR cmdLine, void *psa, void *tsa,
                    BOOL inheritHandles, DWORD flags, LPVOID env,
                    LPCWSTR cwd, STARTUPINFOW *si, PROCESS_INFORMATION *pi);
void GetStartupInfoW(STARTUPINFOW *si);
#define INFINITE      0xFFFFFFFFu
#define WAIT_OBJECT_0 0
#define WAIT_TIMEOUT  258
#define WAIT_FAILED   0xFFFFFFFFu
#define STILL_ACTIVE  259
DWORD  WaitForSingleObject(HANDLE h, DWORD ms);
BOOL   GetExitCodeProcess(HANDLE h, LPDWORD code);
BOOL   TerminateProcess(HANDLE h, UINT code);
HANDLE GetCurrentProcess(void);
DWORD  GetCurrentProcessId(void);

BOOL QueryPerformanceCounter(LARGE_INTEGER *out);
BOOL QueryPerformanceFrequency(LARGE_INTEGER *out);

#define MEM_COMMIT   0x1000
#define MEM_RESERVE  0x2000
#define MEM_DECOMMIT 0x4000
#define MEM_RELEASE  0x8000
LPVOID VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect);
BOOL   VirtualFree(LPVOID addr, SIZE_T size, DWORD type);

#ifdef UNICODE
#define WIN32_FIND_DATA WIN32_FIND_DATAW
#define LPWIN32_FIND_DATA LPWIN32_FIND_DATAW
#define FindFirstFile FindFirstFileW
#define FindNextFile FindNextFileW
#define CreateDirectory CreateDirectoryW
#define RemoveDirectory RemoveDirectoryW
#define MoveFile MoveFileW
#define SetFileAttributes SetFileAttributesW
#define GetCurrentDirectory GetCurrentDirectoryW
#define SetCurrentDirectory SetCurrentDirectoryW
#define STARTUPINFO STARTUPINFOW
#define LPSTARTUPINFO LPSTARTUPINFOW
#define CreateProcess CreateProcessW
#define GetStartupInfo GetStartupInfoW
#endif

/* ---------------- winreg (advapi32; implemented by advapi32.c, 0059) - */

typedef HANDLE HKEY;
typedef HKEY *PHKEY;
typedef DWORD REGSAM;
#define HKEY_CLASSES_ROOT  ((HKEY)(ULONG_PTR)0x80000000u)
#define HKEY_CURRENT_USER  ((HKEY)(ULONG_PTR)0x80000001u)
#define HKEY_LOCAL_MACHINE ((HKEY)(ULONG_PTR)0x80000002u)
#define HKEY_USERS         ((HKEY)(ULONG_PTR)0x80000003u)
#define KEY_QUERY_VALUE  0x0001
#define KEY_SET_VALUE    0x0002
#define KEY_READ         0x20019
#define KEY_WRITE        0x20006
#define KEY_ALL_ACCESS   0xF003F
#define REG_NONE      0
#define REG_SZ        1
#define REG_EXPAND_SZ 2
#define REG_BINARY    3
#define REG_DWORD     4
#define REG_OPTION_NON_VOLATILE 0
#define REG_CREATED_NEW_KEY     1
#define REG_OPENED_EXISTING_KEY 2

LONG RegOpenKeyW(HKEY key, LPCWSTR sub, PHKEY out);
LONG RegOpenKeyExW(HKEY key, LPCWSTR sub, DWORD options, REGSAM sam, PHKEY out);
LONG RegCreateKeyExW(HKEY key, LPCWSTR sub, DWORD reserved, LPWSTR cls,
                     DWORD options, REGSAM sam, void *sa, PHKEY out,
                     LPDWORD disposition);
LONG RegQueryValueExW(HKEY key, LPCWSTR name, LPDWORD reserved, LPDWORD type,
                      LPBYTE data, LPDWORD count);
LONG RegSetValueExW(HKEY key, LPCWSTR name, DWORD reserved, DWORD type,
                    const BYTE *data, DWORD count);
LONG RegDeleteValueW(HKEY key, LPCWSTR name);
LONG RegCloseKey(HKEY key);
#ifdef UNICODE
#define RegOpenKey RegOpenKeyW
#define RegOpenKeyEx RegOpenKeyExW
#define RegCreateKeyEx RegCreateKeyExW
#define RegQueryValueEx RegQueryValueExW
#define RegSetValueEx RegSetValueExW
#define RegDeleteValue RegDeleteValueW
#endif

/* ---------------- user32 growth: resources, menus, dialogs, misc ----- */

HICON   LoadIconW(HINSTANCE inst, LPCWSTR name);
HCURSOR LoadCursorW(HINSTANCE inst, LPCWSTR name);
HBITMAP LoadBitmapW(HINSTANCE inst, LPCWSTR name);
HANDLE  LoadImageW(HINSTANCE inst, LPCWSTR name, UINT type, int cx, int cy, UINT flags);
int     LoadStringW(HINSTANCE inst, UINT id, LPWSTR buf, int max);
HACCEL  LoadAcceleratorsW(HINSTANCE inst, LPCWSTR name);
int     TranslateAcceleratorW(HWND hwnd, HACCEL acc, MSG *msg);
BOOL    DestroyIcon(HICON icon);
BOOL    DestroyCursor(HCURSOR cur);
HCURSOR SetCursor(HCURSOR cur);
BOOL    DrawIcon(HDC hdc, int x, int y, HICON icon);
#define IDI_APPLICATION MAKEINTRESOURCE(32512)
#define IDI_WARNING     MAKEINTRESOURCE(32515)
#define IDI_ERROR       MAKEINTRESOURCE(32513)
#define IDC_ARROW       MAKEINTRESOURCE(32512)
#define IDC_IBEAM       MAKEINTRESOURCE(32513)
#define IDC_WAIT        MAKEINTRESOURCE(32514)
#define IDC_CROSS       MAKEINTRESOURCE(32515)
#define IMAGE_BITMAP 0
#define IMAGE_ICON   1
#define IMAGE_CURSOR 2
#define LR_DEFAULTCOLOR 0x0000
#define LR_LOADFROMFILE 0x0010
#define LR_DEFAULTSIZE  0x0040
#define LR_SHARED       0x8000

HMENU LoadMenuW(HINSTANCE inst, LPCWSTR name);
HMENU CreateMenu(void);
HMENU CreatePopupMenu(void);
BOOL  DestroyMenu(HMENU menu);
HMENU GetMenu(HWND hwnd);
BOOL  SetMenu(HWND hwnd, HMENU menu);
HMENU GetSubMenu(HMENU menu, int pos);
HMENU GetSystemMenu(HWND hwnd, BOOL revert);
BOOL  AppendMenuW(HMENU menu, UINT flags, UINT_PTR id, LPCWSTR text);
BOOL  InsertMenuW(HMENU menu, UINT pos, UINT flags, UINT_PTR id, LPCWSTR text);
BOOL  DeleteMenu(HMENU menu, UINT pos, UINT flags);
BOOL  RemoveMenu(HMENU menu, UINT pos, UINT flags);
DWORD CheckMenuItem(HMENU menu, UINT id, UINT check);
BOOL  CheckMenuRadioItem(HMENU menu, UINT first, UINT last, UINT check, UINT flags);
BOOL  EnableMenuItem(HMENU menu, UINT id, UINT enable);
UINT  GetMenuState(HMENU menu, UINT id, UINT flags);
BOOL  ModifyMenuW(HMENU menu, UINT pos, UINT flags, UINT_PTR id, LPCWSTR text);
BOOL  DrawMenuBar(HWND hwnd);
BOOL  TrackPopupMenu(HMENU menu, UINT flags, int x, int y, int reserved,
                     HWND hwnd, const RECT *r);
#define MF_BYCOMMAND   0x0000
#define MF_BYPOSITION  0x0400
#define MF_ENABLED     0x0000
#define MF_GRAYED      0x0001
#define MF_DISABLED    0x0002
#define MF_CHECKED     0x0008
#define MF_UNCHECKED   0x0000
#define MF_STRING      0x0000
#define MF_SEPARATOR   0x0800
#define MF_POPUP       0x0010
#define TPM_LEFTALIGN  0x0000
#define TPM_TOPALIGN   0x0000
#define TPM_RIGHTBUTTON 0x0002
#define TPM_RETURNCMD  0x0100
#define TPM_NONOTIFY   0x0080

typedef LRESULT (*DLGPROC)(HWND, UINT, WPARAM, LPARAM);
INT_PTR DialogBoxParamW(HINSTANCE inst, LPCWSTR tmpl, HWND owner,
                        DLGPROC proc, LPARAM param);
#define DialogBoxW(inst, tmpl, owner, proc) \
    DialogBoxParamW(inst, tmpl, owner, proc, 0)
HWND CreateDialogParamW(HINSTANCE inst, LPCWSTR tmpl, HWND owner,
                        DLGPROC proc, LPARAM param);
#define CreateDialogW(inst, tmpl, owner, proc) \
    CreateDialogParamW(inst, tmpl, owner, proc, 0)
BOOL EndDialog(HWND dlg, INT_PTR result);
UINT GetDlgItemTextW(HWND dlg, int id, LPWSTR buf, int max);
BOOL SetDlgItemTextW(HWND dlg, int id, LPCWSTR text);
BOOL SetDlgItemInt(HWND dlg, int id, UINT value, BOOL signed_);
UINT GetDlgItemInt(HWND dlg, int id, BOOL *translated, BOOL signed_);
LRESULT SendDlgItemMessageW(HWND dlg, int id, UINT msg, WPARAM wp, LPARAM lp);
BOOL CheckDlgButton(HWND dlg, int id, UINT check);
UINT IsDlgButtonChecked(HWND dlg, int id);
BOOL CheckRadioButton(HWND dlg, int first, int last, int check);
BOOL MapDialogRect(HWND dlg, RECT *r);
#define WM_INITDIALOG 0x0110
#define DWLP_MSGRESULT 0
#define DWLP_USER 8

UINT_PTR SetTimer(HWND hwnd, UINT_PTR id, UINT elapse, void *proc);
BOOL     KillTimer(HWND hwnd, UINT_PTR id);

BOOL OpenClipboard(HWND owner);
BOOL CloseClipboard(void);
BOOL EmptyClipboard(void);
HANDLE SetClipboardData(UINT format, HANDLE mem);
HANDLE GetClipboardData(UINT format);
BOOL IsClipboardFormatAvailable(UINT format);
#define CF_TEXT        1
#define CF_BITMAP      2
#define CF_UNICODETEXT 13

int  GetSystemMetrics(int index);
#define SM_CXSCREEN 0
#define SM_CYSCREEN 1
#define SM_CXVSCROLL 2
#define SM_CYHSCROLL 3
#define SM_CYCAPTION 4
#define SM_CXBORDER 5
#define SM_CYBORDER 6
#define SM_CYVSCROLL 20
#define SM_CXHSCROLL 21
#define SM_CXICON 11
#define SM_CYICON 12
#define SM_CXSMICON 49
#define SM_CYSMICON 50
#define SM_CYMENU 15
#define SM_CXFULLSCREEN 16
#define SM_CYFULLSCREEN 17

BOOL RedrawWindow(HWND hwnd, const RECT *r, HRGN rgn, UINT flags);
#define RDW_INVALIDATE  0x0001
#define RDW_ERASE       0x0004
#define RDW_UPDATENOW   0x0100
#define RDW_ERASENOW    0x0200
#define RDW_ALLCHILDREN 0x0080

/* Keyboard state (calc's keypad mapping) */
BOOL  GetKeyboardState(BYTE *state);
HKL   GetKeyboardLayout(DWORD thread);
UINT  MapVirtualKeyExW(UINT code, UINT type, HKL layout);
int   ToAsciiEx(UINT vk, UINT scan, const BYTE *state, LPWORD out, UINT flags, HKL layout);
int   GetClassNameW(HWND hwnd, LPWSTR buf, int max);
#ifdef UNICODE
#define MapVirtualKeyEx MapVirtualKeyExW
#define GetClassName GetClassNameW
#endif

BOOL MessageBeep(UINT type);
BOOL GetCursorPos(POINT *p);
BOOL SetCursorPos(int x, int y);
BOOL ScreenToClient(HWND hwnd, POINT *p);
BOOL ClientToScreen(HWND hwnd, POINT *p);
BOOL SetWindowPos(HWND hwnd, HWND after, int x, int y, int w, int h, UINT flags);
#define HWND_TOP       ((HWND)0)
#define HWND_BOTTOM    ((HWND)1)
#define HWND_TOPMOST   ((HWND)-1)
#define HWND_NOTOPMOST ((HWND)-2)
#define SWP_NOSIZE     0x0001
#define SWP_NOMOVE     0x0002
#define SWP_NOZORDER   0x0004
#define SWP_NOACTIVATE 0x0010
#define SWP_SHOWWINDOW 0x0040

#define WPF_SETMINPOSITION     1
#define WPF_RESTORETOMAXIMIZED 2
typedef struct tagWINDOWPLACEMENT {
    UINT length;
    UINT flags;
    UINT showCmd;
    POINT ptMinPosition;
    POINT ptMaxPosition;
    RECT rcNormalPosition;
} WINDOWPLACEMENT, *PWINDOWPLACEMENT, *LPWINDOWPLACEMENT;
BOOL GetWindowPlacement(HWND hwnd, WINDOWPLACEMENT *wp);
BOOL SetWindowPlacement(HWND hwnd, const WINDOWPLACEMENT *wp);

/* Frame-control / state drawing (calc's owner-drawn keypad) */
BOOL DrawFrameControl(HDC hdc, RECT *r, UINT type, UINT state);
#define DFC_CAPTION   1
#define DFC_MENU      2
#define DFC_SCROLL    3
#define DFC_BUTTON    4
#define DFCS_BUTTONPUSH 0x0010
#define DFCS_PUSHED     0x0200
#define DFCS_CHECKED    0x0400
#define DFCS_INACTIVE   0x0100
typedef BOOL (*DRAWSTATEPROC)(HDC, LPARAM, WPARAM, int, int);
BOOL DrawStateW(HDC hdc, HBRUSH brush, DRAWSTATEPROC cb, LPARAM ldata,
                WPARAM wdata, int x, int y, int cx, int cy, UINT flags);
#define DST_COMPLEX 0x0000
#define DST_TEXT    0x0001
#define DST_ICON    0x0003
#define DST_BITMAP  0x0004
#define DSS_NORMAL   0x0000
#define DSS_DISABLED 0x0020
#ifdef UNICODE
#define DrawState DrawStateW
#endif

/* Mouse tracking (calc's hover highlight) */
typedef struct tagTRACKMOUSEEVENT {
    DWORD cbSize;
    DWORD dwFlags;
    HWND  hwndTrack;
    DWORD dwHoverTime;
} TRACKMOUSEEVENT, *LPTRACKMOUSEEVENT;
#define TME_HOVER  0x0001
#define TME_LEAVE  0x0002
#define TME_QUERY  0x40000000u
#define TME_CANCEL 0x80000000u
#define HOVER_DEFAULT 0xFFFFFFFFu
#define WM_MOUSEHOVER 0x02A1
#define WM_MOUSELEAVE 0x02A3
#define WM_ENTERMENULOOP 0x0211
#define WM_EXITMENULOOP  0x0212
#define WM_WININICHANGE  0x001A
#define WM_SETTINGCHANGE WM_WININICHANGE
#define WM_FONTCHANGE    0x001D
#define WM_TIMECHANGE    0x001E
#define WM_THEMECHANGED  0x031A
BOOL TrackMouseEvent(TRACKMOUSEEVENT *tme);

/* RTL layout + accelerator teardown (notepad) */
#define LAYOUT_RTL 1
BOOL SetProcessDefaultLayout(DWORD layout);
BOOL DestroyAcceleratorTable(HACCEL acc);

/* Owner-draw records (calc's keypad buttons) */
typedef struct tagDRAWITEMSTRUCT {
    UINT CtlType;
    UINT CtlID;
    UINT itemID;
    UINT itemAction;
    UINT itemState;
    HWND hwndItem;
    HDC  hDC;
    RECT rcItem;
    ULONG_PTR itemData;
} DRAWITEMSTRUCT, *PDRAWITEMSTRUCT, *LPDRAWITEMSTRUCT;
#define ODT_BUTTON  4
#define ODA_DRAWENTIRE 1
#define ODA_SELECT     2
#define ODA_FOCUS      4
#define ODS_SELECTED   0x0001
#define ODS_FOCUS      0x0010
#define ODS_DISABLED   0x0004

/* Monitors (winmine clamps its saved position onto one) */
typedef HANDLE HMONITOR;
typedef struct tagMONITORINFO {
    DWORD cbSize;
    RECT  rcMonitor;
    RECT  rcWork;
    DWORD dwFlags;
} MONITORINFO, *LPMONITORINFO;
#define MONITOR_DEFAULTTONULL    0
#define MONITOR_DEFAULTTOPRIMARY 1
#define MONITOR_DEFAULTTONEAREST 2
HMONITOR MonitorFromRect(const RECT *r, DWORD flags);
HMONITOR MonitorFromWindow(HWND hwnd, DWORD flags);
HMONITOR MonitorFromPoint(POINT p, DWORD flags);
BOOL GetMonitorInfoW(HMONITOR mon, MONITORINFO *mi);
#ifdef UNICODE
#define GetMonitorInfo GetMonitorInfoW
#endif

/* WinHelp (legacy .hlp; notepad's Help menu) */
#define HELP_CONTEXT  1
#define HELP_QUIT     2
#define HELP_INDEX    3
#define HELP_CONTENTS 3
#define HELP_HELPONHELP 4
BOOL WinHelpW(HWND hwnd, LPCWSTR file, UINT cmd, ULONG_PTR data);
#ifdef UNICODE
#define WinHelp WinHelpW
#endif

HWND GetDesktopWindow(void);
HWND GetForegroundWindow(void);
HWND SetActiveWindow(HWND hwnd);
BOOL AdjustWindowRect(RECT *r, DWORD style, BOOL menu);
BOOL AdjustWindowRectEx(RECT *r, DWORD style, BOOL menu, DWORD exStyle);
BOOL CreateCaret(HWND hwnd, HBITMAP bmp, int w, int h);
BOOL DestroyCaret(void);
BOOL SetCaretPos(int x, int y);
BOOL ShowCaret(HWND hwnd);
BOOL HideCaret(HWND hwnd);
SHORT GetAsyncKeyState(int vk);
int  wsprintfW(LPWSTR buf, LPCWSTR fmt, ...);
int  wvsprintfW(LPWSTR buf, LPCWSTR fmt, va_list args);
int  wsprintfA(LPSTR buf, LPCSTR fmt, ...);
#ifdef UNICODE
#define wsprintf wsprintfW
#define wvsprintf wvsprintfW
#else
#define wsprintf wsprintfA
#endif

/* ---------------- wingdi growth: printing etc. (0059+) --------------- */

typedef struct _DOCINFOW {
    int cbSize;
    LPCWSTR lpszDocName;
    LPCWSTR lpszOutput;
    LPCWSTR lpszDatatype;
    DWORD fwType;
} DOCINFOW, *LPDOCINFOW;
int StartDocW(HDC hdc, const DOCINFOW *di);
int EndDoc(HDC hdc);
int StartPage(HDC hdc);
int EndPage(HDC hdc);
int AbortDoc(HDC hdc);
int SetAbortProc(HDC hdc, void *proc);
HDC CreateDCW(LPCWSTR driver, LPCWSTR device, LPCWSTR output, const void *initData);
BOOL SetViewportOrgEx(HDC hdc, int x, int y, POINT *old);
BOOL SetWindowExtEx(HDC hdc, int x, int y, SIZE *old);
BOOL SetViewportExtEx(HDC hdc, int x, int y, SIZE *old);
int  SetMapMode(HDC hdc, int mode);
#define MM_TEXT 1
#define MM_ANISOTROPIC 8
#ifdef UNICODE
#define DOCINFO DOCINFOW
#define StartDoc StartDocW
#define CreateDC CreateDCW
#endif

/* ---------------- UNICODE generic-name mapping ----------------------- */

#ifdef UNICODE
#define TextOut TextOutW
#define ExtTextOut ExtTextOutW
#define DrawText DrawTextW
#define GetTextExtentPoint32 GetTextExtentPoint32W
#define GetTextMetrics GetTextMetricsW
#define CreateFont CreateFontW
#define CreateFontIndirect CreateFontIndirectW
#define GetObject GetObjectW
#define LOGFONT LOGFONTW
#define PLOGFONT PLOGFONTW
#define LPLOGFONT LPLOGFONTW
#define TEXTMETRIC TEXTMETRICW
#define LPTEXTMETRIC LPTEXTMETRICW
#define WNDCLASS WNDCLASSW
#define WNDCLASSEX WNDCLASSEXW
#define CREATESTRUCT CREATESTRUCTW
#define LPCREATESTRUCT LPCREATESTRUCTW
#define RegisterClass RegisterClassW
#define RegisterClassEx RegisterClassExW
/* CreateWindow/CreateWindowEx: the generic macro forwards */
#undef CreateWindow
#define CreateWindow CreateWindowW
#define CreateWindowEx CreateWindowExW
#define DefWindowProc DefWindowProcW
#define GetMessage GetMessageW
#define PeekMessage PeekMessageW
#define DispatchMessage DispatchMessageW
#define SendMessage SendMessageW
#define PostMessage PostMessageW
#define GetWindowText GetWindowTextW
#define SetWindowText SetWindowTextW
#define GetWindowTextLength GetWindowTextLengthW
#define GetWindowLongPtr GetWindowLongPtrW
#define SetWindowLongPtr SetWindowLongPtrW
#undef GetWindowLong
#undef SetWindowLong
#define GetWindowLong GetWindowLongPtrW
#define SetWindowLong SetWindowLongPtrW
#define MessageBox MessageBoxW
#define IsDialogMessage IsDialogMessageW
#define LoadIcon LoadIconW
#define LoadCursor LoadCursorW
#define LoadBitmap LoadBitmapW
#define LoadImage LoadImageW
#define LoadString LoadStringW
#define LoadAccelerators LoadAcceleratorsW
#define TranslateAccelerator TranslateAcceleratorW
#define LoadMenu LoadMenuW
#define AppendMenu AppendMenuW
#define InsertMenu InsertMenuW
#define ModifyMenu ModifyMenuW
#define DialogBoxParam DialogBoxParamW
#define DialogBox DialogBoxW
#define CreateDialogParam CreateDialogParamW
#define CreateDialog CreateDialogW
#define GetDlgItemText GetDlgItemTextW
#define SetDlgItemText SetDlgItemTextW
#define SendDlgItemMessage SendDlgItemMessageW
#endif /* UNICODE */

/* ---------------- A-suffix aliases (the implemented ANSI entries) ---- */
#ifndef UNICODE
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
#define RegisterClassA        RegisterClass
#define RegisterClassExA      RegisterClassEx
#define CreateWindowExA       CreateWindowEx
#define CreateWindowA         CreateWindow
#define DefWindowProcA        DefWindowProc
#define GetMessageA           GetMessage
#define PeekMessageA          PeekMessage
#define DispatchMessageA      DispatchMessage
#define SendMessageA          SendMessage
#define PostMessageA          PostMessage
#define GetWindowTextA        GetWindowText
#define SetWindowTextA        SetWindowText
#define MessageBoxA           MessageBox
#endif /* !UNICODE */
