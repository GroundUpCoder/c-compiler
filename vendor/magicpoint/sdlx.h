/*
 * sdlx.h — the gucOS port's display backend (todos/0119).
 *
 * MagicPoint speaks a small Xlib vocabulary (drawables, GCs, XImages,
 * colors, events). This fork replaces the X11 headers and x11.c with this
 * one header + sdlx.c, which implement exactly that vocabulary over an
 * SDL window surface:
 *
 *   - A Drawable (Window or Pixmap) is an RGB canvas: 32-bit 0x00RRGGBB
 *     words, the same encoding X pixel values use here (truecolor only —
 *     no colormaps, XAllocColor is a bit-pack).
 *   - The ONE window's canvas converts to the SDL surface format and
 *     presents on XFlush/XSync.
 *   - XNextEvent-family calls pump SDL events into a small XEvent queue
 *     (SDL keycodes map to XK_* keysyms; window-close arrives as a
 *     synthetic XK_q press so the stock quit path runs).
 *   - imageToXImage/freeXImage/ximageToPixmap (xloadimage's send.c) are
 *     reimplemented truecolor-only in sdlx.c; send.c is not vendored.
 *
 * NOT an os/-level Xlib veneer: this file is part of the mgp fork and
 * implements only what mgp uses (the 0119 fork-vs-shim decision).
 */
#ifndef SDLX_H
#define SDLX_H

#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>

/* BSD scalar shorthands mgp uses throughout (not in this libc's types.h) */
#ifndef SDLX_BSD_TYPES
#define SDLX_BSD_TYPES
typedef unsigned char u_char;
typedef unsigned short u_short;
typedef unsigned int u_int;
typedef unsigned long u_long;
#endif

/* ---- scalar handle types ---- */
typedef struct sx_drawable {
	int w, h;
	uint32_t *px;      /* 0x00RRGGBB */
	int iswin;
} *Drawable, *Window, *Pixmap;

typedef struct sx_gc {
	unsigned long fore, back;
	int func;
} *GC;

typedef struct sx_display { int dummy; } Display;

typedef unsigned long Atom, Colormap, Cursor, KeySym, Time, Font, Pixel_xid;
typedef unsigned char KeyCode;
typedef int Bool, Status;
typedef struct { int class_; } Visual;

#define True  1
#define False 0
#define None  0L

/* ---- geometry / color / image structs ---- */
typedef struct { short x, y; } XPoint;

typedef struct {
	unsigned long pixel;
	unsigned short red, green, blue;
	char flags, pad;
} XColor;

#define DoRed   1
#define DoGreen 2
#define DoBlue  4

typedef struct XImage {
	int width, height;
	int format;
	char *data;              /* 32bpp rows, bytes_per_line apart */
	int byte_order, bitmap_unit, bitmap_bit_order, bitmap_pad;
	int depth;
	int bytes_per_line;
	int bits_per_pixel;
} XImage;

#define ZPixmap  2
#define XYBitmap 0

typedef struct { unsigned char byte1, byte2; } XChar2b;

typedef struct {
	Font fid;
	struct { short lbearing, rbearing, width, ascent, descent; } max_bounds;
} XFontStruct;

typedef struct {
	int x, y;
	int width, height;
	int border_width;
	int depth;
} XWindowAttributes;

#define AllPlanes (~0UL)

/* ---- events (subset; real X type codes) ---- */
#define KeyPress        2
#define KeyRelease      3
#define ButtonPress     4
#define ButtonRelease   5
#define MotionNotify    6
#define EnterNotify     7
#define LeaveNotify     8
#define Expose          12
#define ConfigureNotify 22
#define ClientMessage   33
#define LASTEvent       36

#define NoEventMask           0L
#define KeyPressMask          (1L<<0)
#define KeyReleaseMask        (1L<<1)
#define ButtonPressMask       (1L<<2)
#define ButtonReleaseMask     (1L<<3)
#define Button1MotionMask     (1L<<8)
#define ExposureMask          (1L<<15)
#define StructureNotifyMask   (1L<<17)

typedef struct { int type; Window window; } XAnyEvent;
typedef struct {
	int type; Window window;
	unsigned int keycode;    /* carries the mapped KeySym directly */
	unsigned int state;
	int x, y;
} XKeyEvent;
typedef XKeyEvent XKeyPressedEvent;
typedef struct {
	int type; Window window;
	unsigned int button;
	int x, y;
} XButtonEvent;
typedef XButtonEvent XButtonPressedEvent;
typedef struct { int type; Window window; int x, y; } XMotionEvent;
typedef struct { int type; Window window; int x, y, width, height, count; } XExposeEvent;
typedef struct { int type; Window window; int x, y, width, height; } XConfigureEvent;
typedef struct { int type; Window window; long l[5]; } XClientMessageEvent;

typedef union _XEvent {
	int type;
	XAnyEvent xany;
	XKeyEvent xkey;
	XButtonEvent xbutton;
	XMotionEvent xmotion;
	XExposeEvent xexpose;
	XConfigureEvent xconfigure;
	XClientMessageEvent xclient;
} XEvent;

/* ---- keysyms (ASCII ones equal their character) ---- */
#define XK_space     0x020
#define XK_0 '0'
#define XK_1 '1'
#define XK_2 '2'
#define XK_3 '3'
#define XK_4 '4'
#define XK_5 '5'
#define XK_6 '6'
#define XK_7 '7'
#define XK_8 '8'
#define XK_9 '9'
#define XK_a 'a'
#define XK_b 'b'
#define XK_c 'c'
#define XK_f 'f'
#define XK_g 'g'
#define XK_j 'j'
#define XK_k 'k'
#define XK_l 'l'
#define XK_n 'n'
#define XK_p 'p'
#define XK_q 'q'
#define XK_r 'r'
#define XK_t 't'
#define XK_w 'w'
#define XK_x 'x'
#define XK_BackSpace 0xff08
#define XK_Tab       0xff09
#define XK_Return    0xff0d
#define XK_Escape    0xff1b
#define XK_Delete    0xffff
#define XK_Home      0xff50
#define XK_Left      0xff51
#define XK_Up        0xff52
#define XK_Right     0xff53
#define XK_Down      0xff54
#define XK_Prior     0xff55
#define XK_Next      0xff56
#define XK_Shift_L   0xffe1
#define XK_Shift_R   0xffe2
#define XK_Control_L 0xffe3
#define XK_Control_R 0xffe4

/* ---- assorted constants mgp sources reference ---- */
#define GXcopy 0x3
#define Convex 2
#define CoordModeOrigin 0
#define CurrentTime 0L
#define XC_pencil 86
#define XC_watch  150

#define DefaultScreen(d)      0
#define DefaultDepth(d, s)    24
#define DefaultColormap(d, s) 0L
#define DefaultVisual(d, s)   ((Visual *)0)
#define RootWindow(d, s)      ((Window)0)
#define DefaultRootWindow(d)  ((Window)0)
#define BlackPixel(d, s)      0x000000UL
#define WhitePixel(d, s)      0xffffffUL
#define ConnectionNumber(d)   0

/* geometry-parse result bits (XParseGeometry) */
#define NoValue     0x0000
#define XValue      0x0001
#define YValue      0x0002
#define WidthValue  0x0004
#define HeightValue 0x0008
#define XNegative   0x0010
#define YNegative   0x0020

/* ---- drawing / window ops (implemented in sdlx.c) ---- */
void XFlush(Display *);
void XSync(Display *, Bool);
void XBell(Display *, int);
void XSetForeground(Display *, GC, unsigned long);
void XSetBackground(Display *, GC, unsigned long);
void XSetFunction(Display *, GC, int);
GC XCreateGC(Display *, Drawable, unsigned long, void *);
void XFreeGC(Display *, GC);
void XFillRectangle(Display *, Drawable, GC, int, int, unsigned int, unsigned int);
void XDrawRectangle(Display *, Drawable, GC, int, int, unsigned int, unsigned int);
void XDrawLine(Display *, Drawable, GC, int, int, int, int);
void XFillArc(Display *, Drawable, GC, int, int, unsigned int, unsigned int, int, int);
void XFillPolygon(Display *, Drawable, GC, XPoint *, int, int, int);
void XCopyArea(Display *, Drawable, Drawable, GC, int, int, unsigned int, unsigned int, int, int);
void XClearWindow(Display *, Window);
void XClearArea(Display *, Window, int, int, unsigned int, unsigned int, Bool);
void XSetWindowBackground(Display *, Window, unsigned long);
void XSetWindowBackgroundPixmap(Display *, Window, Pixmap);
Pixmap XCreatePixmap(Display *, Drawable, unsigned int, unsigned int, unsigned int);
void XFreePixmap(Display *, Pixmap);
void XStoreName(Display *, Window, const char *);
void XMoveResizeWindow(Display *, Window, int, int, unsigned int, unsigned int);
void XMapSubwindows(Display *, Window);
void XDestroyWindow(Display *, Window);
Status XGetWindowAttributes(Display *, Window, XWindowAttributes *);
Bool XTranslateCoordinates(Display *, Window, Window, int, int, int *, int *, Window *);
Window XCreateSimpleWindow(Display *, Window, int, int, unsigned int, unsigned int,
                           unsigned int, unsigned long, unsigned long);
void XMoveWindow(Display *, Window, int, int);
void XFree(void *);

/* ---- images ---- */
XImage *XCreateImage(Display *, Visual *, unsigned int, int, int, char *, unsigned int, unsigned int, int, int);
void XDestroyImage(XImage *);
unsigned long XGetPixel(XImage *, int, int);
void XPutPixel(XImage *, int, int, unsigned long);
void XAddPixel(XImage *, long);
void XPutImage(Display *, Drawable, GC, XImage *, int, int, int, int, unsigned int, unsigned int);
XImage *XGetImage(Display *, Drawable, int, int, unsigned int, unsigned int, unsigned long, int);

/* ---- colors ---- */
Status XAllocColor(Display *, Colormap, XColor *);
Status XAllocNamedColor(Display *, Colormap, const char *, XColor *, XColor *);
Status XParseColor(Display *, Colormap, const char *, XColor *);
void XQueryColor(Display *, Colormap, XColor *);
void XQueryColors(Display *, Colormap, XColor *, int);
void XFreeColors(Display *, Colormap, unsigned long *, int, unsigned long);
Colormap XCopyColormapAndFree(Display *, Colormap);

/* ---- events / input ---- */
int XEventsQueued(Display *, int);
#define QueuedAfterReading 1
void XNextEvent(Display *, XEvent *);
void XPeekEvent(Display *, XEvent *);
Bool XCheckMaskEvent(Display *, long, XEvent *);
void XPutBackEvent(Display *, XEvent *);
KeySym XLookupKeysym(XKeyEvent *, int);
KeyCode XKeysymToKeycode(Display *, KeySym);
void XSelectInput(Display *, Window, long);

/* ---- cursors (no-ops) ---- */
Cursor XCreateFontCursor(Display *, unsigned int);
void XDefineCursor(Display *, Window, Cursor);
void XUndefineCursor(Display *, Window);
void XRecolorCursor(Display *, Cursor, XColor *, XColor *);

/* ---- misc ---- */
int XParseGeometry(const char *, int *, int *, unsigned int *, unsigned int *);
void XDrawString16(Display *, Drawable, GC, int, int, XChar2b *, int);

/* ---- xloadimage send.c replacements (truecolor) ----
 * XImageInfo is declared in image/xloadimage.h; these are implemented in
 * sdlx.c over the 32bpp XImage above. */

/* ---- the SDL side (sdlx.c internals the fork calls directly) ---- */
void sdlx_frame_hook(void (*cb)(void));   /* __setAnimationFrameFunc wrap */
void sdlx_wait_event(int ms);             /* SDL_WaitEventTimeout peek (0161) */

#endif /* SDLX_H */
