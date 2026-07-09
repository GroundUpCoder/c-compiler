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
 * ANSI-only for now (todos/WIN32.md friction #2: implement W, shim A —
 * the A/W split arrives with the 0060 port corpus). The *A aliases below
 * keep ported sources compiling. Single-threaded by design (WIN32.md
 * friction #1): one message loop per process, no CreateThread.
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
typedef HANDLE HMENU;
typedef HANDLE HICON;
typedef HANDLE HCURSOR;
typedef int LONG_PTR, *PLONG_PTR;           /* ILP32 wasm */
typedef unsigned int UINT_PTR, ULONG_PTR, DWORD_PTR;
typedef unsigned short ATOM;

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
#define SW_SHOW          5
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
#define WM_GETDLGCODE    0x0087
#define WM_KEYDOWN       0x0100
#define WM_KEYUP         0x0101
#define WM_CHAR          0x0102
#define WM_COMMAND       0x0111
#define WM_SYSCOMMAND    0x0112
#define WM_TIMER         0x0113   /* declared; SetTimer is a 0060 growth item */
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
#define COLOR_WINDOW         5
#define COLOR_WINDOWFRAME    6
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
/* Button messages / notifications */
#define BM_GETCHECK  0x00F0
#define BM_SETCHECK  0x00F1
#define BM_SETSTATE  0x00F3
#define BM_CLICK     0x00F5
#define BST_UNCHECKED 0
#define BST_CHECKED   1
#define BN_CLICKED    0
#define BN_DOUBLECLICKED 5

/* Static styles */
#define SS_LEFT   0x0
#define SS_CENTER 0x1
#define SS_RIGHT  0x2

/* Edit styles */
#define ES_LEFT        0x0000
#define ES_MULTILINE   0x0004
#define ES_AUTOVSCROLL 0x0040
#define ES_AUTOHSCROLL 0x0080
#define ES_WANTRETURN  0x1000
#define ES_READONLY    0x0800
/* Edit messages / notifications */
#define EM_GETSEL       0x00B0
#define EM_SETSEL       0x00B1
#define EM_GETLINECOUNT 0x00BA
#define EM_SETREADONLY  0x00CF
#define EN_CHANGE  0x0300
#define EN_UPDATE  0x0400

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
#define MB_YESNO        0x0004
#define MB_ICONERROR    0x0010
#define MB_ICONQUESTION 0x0020
#define MB_ICONWARNING  0x0030
#define MB_ICONINFORMATION 0x0040
#define IDOK     1
#define IDCANCEL 2
#define IDYES    6
#define IDNO     7

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
