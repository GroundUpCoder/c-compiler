/* user32.c — windowing, the HWND tree, the message loop, input routing,
 * the standard controls, and the agent tree (todos/0058, design
 * todos/WIN32.md).
 *
 * The Windows 7 split (WIN32.md): user32 owns WINDOWING, gdi32 owns
 * DRAWING. A top-level HWND wraps an SDL window (one kernel surface);
 * child controls are drawn IN-PROCESS into the top-level's surface,
 * Wine-style — a child's DC is the surface span offset to its client
 * origin (win32_internal.h __gdi_dc_wrap), so gdi32 never learns about
 * the tree. Present = SDL_UpdateWindowSurface (shm mailbox flip).
 *
 * The message loop is the CLASSIC blocking shape — while (GetMessage)
 * { TranslateMessage; DispatchMessage; } — even though main() never
 * returns to the host's frame scheduler: GetMessage parks in the
 * kernel's unified WAIT (__wait, todos/0178) over the input ring, the
 * agent listen socket, and the next timer deadline — readiness-check
 * and park atomic kernel-side, wakes drained into the SDL event queue
 * at the import's return. Message priority is Windows': posted messages
 * first, WM_PAINT only when the queue is dry, WM_QUIT after everything.
 *
 * The agent tree (OS.md's agent-target pillar): the first CreateWindowEx
 * binds /run/win32/agent.<pid>.sock (wm_agent.h) and the GetMessage idle
 * loop serves it — AQ_TREE dumps the HWND tree, AQ_CLICK presses a
 * window resolved BY LABEL (BM_CLICK for buttons, a synthetic client-
 * center click otherwise), AQ_GETTEXT/AQ_SETTEXT read/write WM_GETTEXT
 * text. `wmctl click "OK"` needs no pixel coordinates, ever.
 *
 * 0068 (the user32/resource tail — winmine playable) grew: the W entry
 * points (the A/W split of WIN32.md friction #2 — windows/classes carry
 * an isW mark and WM_SETTEXT/WM_GETTEXT translate at the send_msg choke
 * point when caller charset != window charset; everything else converts
 * at the API boundary), resources (a sidecar `<argv0>.res` pack compiled
 * by tools/win32rc.js — the WRES format there is the MUST-MATCH spec for
 * res_* below; Load{String,Bitmap,Menu,Accelerators}W read it, icons/
 * cursors are stub handles), MENUS (an HMENU item tree; the menu BAR is
 * drawn by user32 into the top MENU_BAR_H pixels of the surface at every
 * present and the client area is offset under it — popups draw INSIDE
 * the surface and clip to it, since a surface cannot overflow its kernel
 * window; mouse-driven, agent-clickable via the tree, no keyboard nav),
 * accelerators (TranslateAccelerator on WM_KEYDOWN), DIALOG templates
 * (DialogBoxParamW instantiates a "#32770" top-level + child controls
 * from the RT_DIALOG record, dialog units scaled by the stock font, the
 * MessageBox modal-loop/owner-disable shape reused), SetTimer/WM_TIMER
 * (delivered queue-dry like WM_PAINT), RedrawWindow, AdjustWindowRect,
 * GetSystemMetrics + the synthetic single monitor, and top-level
 * MoveWindow -> SDL_SetWindowSize (kernel SURFACE_RESIZE; the new size
 * arrives as the usual RESIZED event, so apps see one resize path).
 *
 * Deliberate 0058 simplifications (grow under 0060's missing-symbol log):
 *   - single-threaded by design (WIN32.md friction #1) — one queue, no
 *     PostThreadMessage; SendMessage is a direct call
 *   - invalidation is whole-window (rcPaint = the client rect)
 *   - dialog keyboard navigation landed with 0104: IsDialogMessageW does
 *     Tab/Shift+Tab (WS_TABSTOP walk), Alt+mnemonic, Enter=default button,
 *     Esc=IDCANCEL, radio-group arrows, over WM_GETDLGCODE; wired into both
 *     modal loops. The clipboard landed with 0048 (file) and rides the
 *     kernel store since 0090
 *   - hidden top-levels: ShowWindow(SW_HIDE) on a top-level is a no-op
 *     (the kernel surface has no hide op; minimize is the WM's)
 *   - WM_CLOSE from the kernel (title-bar 'x' / wmctl close) is per-
 *     window when several top-levels are live (SDL_EVENT_WINDOW_
 *     CLOSE_REQUESTED, todos/0089); the only/last window gets the
 *     process-wide SDL_EVENT_QUIT routed to the first live top-level
 *   - VK mapping covers letters/digits/named keys; punctuation VKs are
 *     approximate (WM_CHAR carries the real character — SDL3 keysyms
 *     are modifier-applied, so TranslateMessage is a table-free map)
 * 0068 simplifications: menus are mouse/agent-driven (no Alt-mnemonics,
 * no arrow-key nav; ESC does close); a popup taller than the window
 * clips at the surface edge; the menu bar routes BEFORE mouse capture
 * (a captured drag into the bar is swallowed — Windows lets capture
 * win); PostMessageW must not carry text pointers
 * (posted messages are never charset-translated); GetSystemMetrics
 * screen numbers are synthetic constants (processes can't see the real
 * screen — only the WM can); the systray/UNICODE title path keeps
 * UTF-8 (SDL titles are UTF-8 anyway).
 */

/* The veneer is implemented ANSI (WIN32.md friction #2: implement W, shim
 * A). Ported apps build -DUNICODE (0060); the implementation must not. */
#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <mmsystem.h>
#include <SDL.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/un.h>

#include "win32_internal.h"
#include "../wm_agent.h"

/* Host import (host.js createSurfaceSDL, both flavors): drain the kernel
 * input ring into the SDL event queue; timeoutMs > 0 parks on the ring
 * until the kernel's push notifies. Returns 1 if a ring exists. */
__import int __sdl_pump_wait(int timeoutMs);

/* The unified multi-source wait (kernel FS_WAIT via host.js, todos/0178):
 * park until an fd in rfds is readable (1), the input ring has records —
 * already drained into the SDL queue at return (2), timeout_ms elapses
 * (0; < 0 waits forever), or a signal was posted (-1). -2 = no kernel
 * WAIT in this flavor (fall back to the chunked poll). GetMessage parks
 * here indefinitely instead of chunking at 25ms — an idle app's wake
 * counter goes flat while wmctl (agent socket) and WM_TIMER stay prompt. */
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

/* ============================================================ sys colors */

static const COLORREF SYSCOLORS[22] = {
    /* 0 SCROLLBAR   */ 0x00C0C0C0, /* 1 BACKGROUND    */ 0x00808000,
    /* 2 ACTIVECAP   */ 0x00800000, /* 3 INACTIVECAP   */ 0x00808080,
    /* 4 MENU        */ 0x00C0C0C0, /* 5 WINDOW        */ 0x00FFFFFF,
    /* 6 WINDOWFRAME */ 0x00000000, /* 7 MENUTEXT      */ 0x00000000,
    /* 8 WINDOWTEXT  */ 0x00000000, /* 9 CAPTIONTEXT   */ 0x00FFFFFF,
    /* 10 ACTIVEBRD  */ 0x00C0C0C0, /* 11 INACTIVEBRD  */ 0x00C0C0C0,
    /* 12 APPWORKSP  */ 0x00808080, /* 13 HIGHLIGHT    */ 0x00800000,
    /* 14 HILITETEXT */ 0x00FFFFFF, /* 15 BTNFACE      */ 0x00C0C0C0,
    /* 16 BTNSHADOW  */ 0x00808080, /* 17 GRAYTEXT     */ 0x00808080,
    /* 18 BTNTEXT    */ 0x00000000, /* 19 INACTCAPTEXT */ 0x00000000,
    /* 20 BTNHILITE  */ 0x00FFFFFF, /* 21 3DDKSHADOW   */ 0x00000000,
};

DWORD GetSysColor(int index) {
    if (index < 0 || index >= 22) return 0;
    return SYSCOLORS[index];
}

HBRUSH GetSysColorBrush(int index) {
    static HBRUSH cache[22];
    if (index < 0 || index >= 22) return NULL;
    if (!cache[index]) cache[index] = CreateSolidBrush(SYSCOLORS[index]);
    return cache[index];
}

/* WNDCLASS.hbrBackground supports the (HBRUSH)(COLOR_x + 1) convention. */
static HBRUSH resolve_brush(HBRUSH b) {
    if ((UINT_PTR)b >= 1 && (UINT_PTR)b <= 30) return GetSysColorBrush((int)(UINT_PTR)b - 1);
    return b;
}

/* ============================================================ W helpers
 * (kernel32.c owns the UTF-16<->UTF-8 boundary; these wrap its public
 * entry points — same lib.json library, ordinary calls) */

static char *w2a_dup(LPCWSTR w) {               /* malloc'd UTF-8, "" for NULL */
    if (!w) w = (LPCWSTR)u"";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *out = (char *)malloc(n > 0 ? (size_t)n : 1);
    if (!out) return NULL;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
    else out[0] = 0;
    return out;
}

static WCHAR *a2w_dup(const char *s) {          /* malloc'd UTF-16 */
    if (!s) s = "";
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    WCHAR *out = (WCHAR *)malloc((size_t)(n > 0 ? n : 1) * sizeof(WCHAR));
    if (!out) return NULL;
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, -1, out, n);
    else out[0] = 0;
    return out;
}

/* MAKEINTRESOURCE detection. Windows' test is `value < 0x10000` (the
 * first 64KB is never mapped there) — but in THIS wasm layout the low
 * pages ARE mapped: they are the C STACK (static data starts above it,
 * compiler.js staticDataStart = stackPages*64K). The stack grows DOWN,
 * so a stack string passed to us always sits ABOVE our own frame: a
 * low value at-or-below a fresh local's address cannot be a live
 * caller pointer and must be a resource id. */
static int is_intres(const void *p) {
    if (((UINT_PTR)p >> 16) != 0) return 0;
    char probe;
    return (UINT_PTR)p <= (UINT_PTR)&probe;
}

/* Truncating conversions into fixed caller buffers (the kernel32 entry
 * points return 0 on a short buffer instead of truncating — window text
 * APIs must truncate). Both return the unit count EXCLUDING the NUL. */
static int a2w_trunc(const char *s, LPWSTR out, int cap) {
    if (!out || cap < 1) return 0;
    int need = MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, NULL, 0);
    if (need <= 0) { out[0] = 0; return 0; }
    WCHAR *tmp = (WCHAR *)malloc((size_t)need * sizeof(WCHAR));
    if (!tmp) { out[0] = 0; return 0; }
    MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, tmp, need);
    int n = need - 1 < cap - 1 ? need - 1 : cap - 1;
    memcpy(out, tmp, (size_t)n * sizeof(WCHAR));
    out[n] = 0;
    free(tmp);
    return n;
}

static int w2a_trunc(LPCWSTR s, char *out, int cap) {
    if (!out || cap < 1) return 0;
    char *full = w2a_dup(s);
    if (!full) { out[0] = 0; return 0; }
    int len = (int)strlen(full);
    int n = len < cap - 1 ? len : cap - 1;
    while (n > 0 && ((unsigned char)full[n] & 0xC0) == 0x80) n--;   /* no split UTF-8 */
    memcpy(out, full, (size_t)n);
    out[n] = 0;
    free(full);
    return n;
}

/* ============================================================ classes */

#define MAX_CLASSES 64

typedef struct {
    char name[64];
    WNDPROC proc;
    UINT style;
    HBRUSH bg;
    int isW;                    /* registered via the W API: the wndproc
                                   speaks UTF-16 in text messages */
    int menuId;                 /* lpszMenuName MAKEINTRESOURCE id, or 0 */
    int used;
} Class;

static Class g_classes[MAX_CLASSES];

static int ci_eq(const char *a, const char *b) {
    while (*a && *b) {
        char ca = *a, cb = *b;
        if (ca >= 'a' && ca <= 'z') ca -= 32;
        if (cb >= 'a' && cb <= 'z') cb -= 32;
        if (ca != cb) return 0;
        a++; b++;
    }
    return *a == *b;
}

static Class *class_find(const char *name) {
    if (!name) return NULL;
    for (int i = 0; i < MAX_CLASSES; i++)
        if (g_classes[i].used && ci_eq(g_classes[i].name, name)) return &g_classes[i];
    return NULL;
}

static ATOM class_add2(const char *name, WNDPROC proc, UINT style, HBRUSH bg,
                       int isW, int menuId) {
    if (!name || !proc || class_find(name)) return 0;
    for (int i = 0; i < MAX_CLASSES; i++) {
        if (!g_classes[i].used) {
            Class *c = &g_classes[i];
            strncpy(c->name, name, sizeof c->name - 1);
            c->name[sizeof c->name - 1] = 0;
            c->proc = proc;
            c->style = style;
            c->bg = bg;
            c->isW = isW;
            c->menuId = menuId;
            c->used = 1;
            return (ATOM)(i + 1);
        }
    }
    return 0;
}

static ATOM class_add(const char *name, WNDPROC proc, UINT style, HBRUSH bg) {
    return class_add2(name, proc, style, bg, 0, 0);
}

static int menu_name_id(const void *menuName) {  /* A or W: only INTRESOURCE */
    return is_intres(menuName) ? (int)(UINT_PTR)menuName : 0;
}

ATOM RegisterClass(const WNDCLASS *wc) {
    if (!wc) return 0;
    return class_add2(wc->lpszClassName, wc->lpfnWndProc, wc->style,
                      wc->hbrBackground, 0, menu_name_id(wc->lpszMenuName));
}

ATOM RegisterClassEx(const WNDCLASSEX *wc) {
    if (!wc) return 0;
    return class_add2(wc->lpszClassName, wc->lpfnWndProc, wc->style,
                      wc->hbrBackground, 0, menu_name_id(wc->lpszMenuName));
}

ATOM RegisterClassW(const WNDCLASSW *wc) {
    if (!wc) return 0;
    char *name = is_intres(wc->lpszClassName) ? NULL : w2a_dup(wc->lpszClassName);
    ATOM a = class_add2(name, wc->lpfnWndProc, wc->style, wc->hbrBackground,
                        1, menu_name_id(wc->lpszMenuName));
    free(name);
    return a;
}

ATOM RegisterClassExW(const WNDCLASSEXW *wc) {
    if (!wc) return 0;
    char *name = is_intres(wc->lpszClassName) ? NULL : w2a_dup(wc->lpszClassName);
    ATOM a = class_add2(name, wc->lpfnWndProc, wc->style, wc->hbrBackground,
                        1, menu_name_id(wc->lpszMenuName));
    free(name);
    return a;
}

/* ============================================================ HWND tree */

struct __HWND {
    struct __HWND *parent;      /* NULL for top-level */
    struct __HWND *child;       /* first child, creation order */
    struct __HWND *next;        /* next sibling */
    struct __HWND *top;         /* topmost ancestor (self for top-level) */
    Class *cls;
    WNDPROC proc;               /* class proc, or subclassed (GWLP_WNDPROC) */
    DWORD style, exStyle;
    int id;                     /* child id (the hMenu parameter) */
    int serial;                 /* process-unique, for the agent tree dump */
    int x, y, w, h;             /* children: parent-client coords */
    char *text;
    SDL_Window *win;            /* top-level only */
    struct __HWND *focus;       /* top-level only: the keyboard-focus HWND */
    HMENU menu;                 /* top-level only: the menu bar (0068) */
    int isW;                    /* class registered via the W API */
    int visible, enabled;
    int needPaint;
    int inDestroy;
    LONG_PTR userdata;
    void *ctl;                  /* control state (edit/listbox/scrollbar/dialog) */
};

/* The menu bar (0068): user32-drawn at the TOP of the surface; the client
 * area sits under it. SM_CYMENU must agree. */
#define MENU_BAR_H 20

static int bar_h(HWND top) { return top->menu ? MENU_BAR_H : 0; }

static HWND g_tops[32];         /* creation order; NULL holes on destroy */
static int g_nTops;
static HWND g_capture;
static HWND g_activeTop;        /* top-level that last received input */
static int g_serial;
static int g_mod;               /* last SDL key modifier word (SDL_KMOD_*) */
static POINT g_lastPt;          /* last mouse position, top-level client */
static int g_quitPosted, g_quitCode;

static int is_top(HWND h) { return h && h->parent == NULL; }

BOOL IsWindow(HWND h) { return h != NULL && !h->inDestroy; }

/* Client origin of h in its top-level's client space. */
static void hwnd_origin(HWND h, int *ox, int *oy) {
    int x = 0, y = 0;
    for (HWND p = h; p && p->parent; p = p->parent) { x += p->x; y += p->y; }
    *ox = x;
    *oy = y;
}

static int hwnd_shown(HWND h) {         /* visible incl. ancestors */
    for (; h; h = h->parent) if (!h->visible) return 0;
    return 1;
}

static int hwnd_able(HWND h) {          /* enabled incl. ancestors */
    for (; h; h = h->parent) if (!h->enabled) return 0;
    return 1;
}

/* ============================================================ text */

static void text_set(HWND h, const char *s) {
    free(h->text);
    h->text = NULL;
    if (s) {
        size_t n = strlen(s);
        h->text = (char *)malloc(n + 1);
        if (h->text) memcpy(h->text, s, n + 1);
    }
}

static const char *text_get(HWND h) { return h->text ? h->text : ""; }

/* ============================================================ DCs
 * (the 0057 scaffold's GetDC/BeginPaint moved here; gdi32 wraps spans) */

static uint32_t g_scratchPx[1];  /* degenerate rects draw here, discarded */

HDC GetDC(HWND h) {
    if (!h) return NULL;                 /* no whole-screen DC in this OS */
    HWND top = h->top;
    SDL_Surface *s = SDL_GetWindowSurface(top->win);
    if (!s) return NULL;
    int ox, oy;
    hwnd_origin(h, &ox, &oy);
    oy += bar_h(top);                    /* client space starts under the bar */
    int cw = is_top(h) ? s->w : h->w;
    int ch = is_top(h) ? s->h - bar_h(top) : h->h;
    if (ox + cw > s->w) cw = s->w - ox;
    if (oy + ch > s->h) ch = s->h - oy;
    if (ox < 0 || oy < 0 || cw < 1 || ch < 1)
        return __gdi_dc_wrap(g_scratchPx, 1, 1, 1);
    int stride = s->pitch / 4;
    return __gdi_dc_wrap((uint32_t *)s->pixels + oy * stride + ox, cw, ch, stride);
}

static void menu_overlay_draw(HWND top);         /* bar + open popup (0068) */

static int menu_overlay_wanted(HWND top);        /* bar, or an open popup */

int ReleaseDC(HWND h, HDC dc) {
    if (!h || !dc) return 0;
    if (menu_overlay_wanted(h->top)) menu_overlay_draw(h->top);   /* rides every present */
    SDL_UpdateWindowSurface(h->top->win);        /* present: shm mailbox flip */
    __gdi_dc_unwrap(dc);
    return 1;
}

HDC BeginPaint(HWND h, PAINTSTRUCT *ps) {
    if (!h) return NULL;
    h->needPaint = 0;
    HDC dc = GetDC(h);
    if (!dc) return NULL;
    if (ps) {
        memset(ps, 0, sizeof *ps);
        ps->hdc = dc;
        GetClipBox(dc, &ps->rcPaint);
    }
    /* Erase via the class background (WM_ERASEBKGND -> DefWindowProc
     * fills; apps override by handling the message). */
    if (h->cls && h->cls->bg) {
        if (ps) ps->fErase = TRUE;
        SendMessage(h, WM_ERASEBKGND, (WPARAM)dc, 0);
    }
    return dc;
}

BOOL EndPaint(HWND h, const PAINTSTRUCT *ps) {
    if (!h || !ps || !ps->hdc) return FALSE;
    return ReleaseDC(h, ps->hdc) ? TRUE : FALSE;
}

BOOL GetClientRect(HWND h, RECT *r) {
    if (!h || !r) return FALSE;
    if (is_top(h)) {                     /* live surface size: resizes seen */
        SDL_Surface *s = SDL_GetWindowSurface(h->win);
        if (!s) return FALSE;
        int ch = s->h - bar_h(h);
        SetRect(r, 0, 0, s->w, ch < 0 ? 0 : ch);
        return TRUE;
    }
    SetRect(r, 0, 0, h->w, h->h);
    return TRUE;
}

BOOL GetWindowRect(HWND h, RECT *r) {
    if (!h || !r) return FALSE;
    if (is_top(h)) return GetClientRect(h, r);
    int ox, oy;
    hwnd_origin(h, &ox, &oy);
    SetRect(r, ox, oy, ox + h->w, oy + h->h);
    return TRUE;
}

/* ============================================================ queue */

#define QLEN 512

typedef struct { MSG m; int sym; } QMsg;   /* sym: SDL keysym for WM_CHAR */

static QMsg g_q[QLEN];
static int g_qh, g_qn;
static int g_lastSym;           /* keysym of the last retrieved key message */

static void q_push(HWND h, UINT msg, WPARAM wp, LPARAM lp, int sym) {
    if (g_qn >= QLEN) return;                    /* drop-newest on overflow */
    QMsg *e = &g_q[(g_qh + g_qn) % QLEN];
    e->m.hwnd = h;
    e->m.message = msg;
    e->m.wParam = wp;
    e->m.lParam = lp;
    e->m.time = (DWORD)SDL_GetTicks();
    e->m.pt = g_lastPt;
    e->sym = sym;
    g_qn++;
}

static int q_match(const QMsg *e, HWND hf, UINT mn, UINT mx) {
    if (!e->m.hwnd) return 0;                    /* window destroyed: skip */
    if (hf && e->m.hwnd != hf) return 0;
    if (mx && (e->m.message < mn || e->m.message > mx)) return 0;
    return 1;
}

static int q_get(MSG *out, HWND hf, UINT mn, UINT mx, int remove) {
    for (int i = 0; i < g_qn; i++) {
        QMsg *e = &g_q[(g_qh + i) % QLEN];
        if (!e->m.hwnd) {                        /* compact dead entries */
            if (i == 0) { g_qh = (g_qh + 1) % QLEN; g_qn--; i--; continue; }
            continue;
        }
        if (!q_match(e, hf, mn, mx)) continue;
        *out = e->m;
        if (remove) {
            g_lastSym = e->sym;
            e->m.hwnd = NULL;                    /* tombstone; compacted above */
            e->m.message = WM_NULL;
            if (i == 0) { g_qh = (g_qh + 1) % QLEN; g_qn--; }
        }
        return 1;
    }
    return 0;
}

static void q_purge(HWND h) {                    /* window destroyed */
    for (int i = 0; i < g_qn; i++) {
        QMsg *e = &g_q[(g_qh + i) % QLEN];
        if (e->m.hwnd == h) { e->m.hwnd = NULL; e->m.message = WM_NULL; }
    }
}

BOOL PostMessage(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (h && !IsWindow(h)) return FALSE;
    if (!h && msg != WM_NULL) {
        /* thread messages: NULL hwnd is this queue's tombstone marker, so
         * the message would silently vanish (0211) — fail loud instead */
        WIN32_UNSUPPORTED("PostMessage(NULL, 0x%04X) thread message", msg);
        return FALSE;
    }
    q_push(h, msg, wp, lp, 0);
    return TRUE;
}

void PostQuitMessage(int code) {
    g_quitPosted = 1;
    g_quitCode = code;
}

LRESULT CallWindowProc(WNDPROC proc, HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (!proc) return 0;
    return proc(h, msg, wp, lp);
}

/* The A/W translation choke point (0068, WIN32.md friction #2): text
 * messages convert when the CALLER's charset differs from the WINDOW's —
 * the same per-window marking Windows uses. Only WM_SETTEXT/WM_GETTEXT
 * carry translated text; everything else passes through (posted messages
 * never translate — don't post text pointers). */
static LRESULT send_msg(HWND h, UINT msg, WPARAM wp, LPARAM lp, int callerW) {
    if (!h) return 0;
    int winW = h->isW;
    if (msg == EM_REPLACESEL && lp && callerW != winW) {   /* text in lp (0048) */
        void *conv = callerW ? (void *)w2a_dup((LPCWSTR)lp)
                             : (void *)a2w_dup((const char *)lp);
        if (!conv) return FALSE;
        LRESULT r = CallWindowProc(h->proc, h, msg, wp, (LPARAM)conv);
        free(conv);
        return r;
    }
    if (msg == WM_SETTEXT && lp && callerW != winW) {
        void *conv = callerW ? (void *)w2a_dup((LPCWSTR)lp)
                             : (void *)a2w_dup((const char *)lp);
        if (!conv) return FALSE;
        LRESULT r = CallWindowProc(h->proc, h, msg, wp, (LPARAM)conv);
        free(conv);
        return r;
    }
    if (msg == WM_GETTEXT && lp && (int)wp > 0 && callerW != winW) {
        int cap = (int)wp;
        if (callerW) {                           /* W caller, A window */
            int acap = cap * 3 + 1;              /* UTF-8 worst case for cap chars */
            char *tmp = (char *)malloc((size_t)acap);
            if (!tmp) return 0;
            tmp[0] = 0;
            CallWindowProc(h->proc, h, msg, (WPARAM)acap, (LPARAM)tmp);
            int wn = a2w_trunc(tmp, (LPWSTR)lp, cap);
            free(tmp);
            return wn;
        } else {                                 /* A caller, W window */
            WCHAR *tmp = (WCHAR *)malloc((size_t)cap * sizeof(WCHAR));
            if (!tmp) return 0;
            tmp[0] = 0;
            CallWindowProc(h->proc, h, msg, (WPARAM)cap, (LPARAM)tmp);
            int an = w2a_trunc(tmp, (char *)lp, cap);
            free(tmp);
            return an;
        }
    }
    return CallWindowProc(h->proc, h, msg, wp, lp);
}

LRESULT SendMessage(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    return send_msg(h, msg, wp, lp, 0);
}

LRESULT SendMessageW(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    return send_msg(h, msg, wp, lp, 1);
}

BOOL PostMessageW(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    return PostMessage(h, msg, wp, lp);          /* no text translation: see top */
}

/* ============================================================ VK map */

static int vk_of(int sym, int sc) {
    if (sym >= 'a' && sym <= 'z') return sym - 32;
    if (sym >= 'A' && sym <= 'Z') return sym;
    if (sym >= '0' && sym <= '9') return sym;
    switch (sym) {
    case 8: return VK_BACK;
    case 9: return VK_TAB;
    case 13: return VK_RETURN;
    case 27: return VK_ESCAPE;
    case 32: return VK_SPACE;
    case 127: return VK_DELETE;
    case 1073741897: return VK_INSERT;
    case 1073741898: return VK_HOME;
    case 1073741899: return VK_PRIOR;   /* PageUp */
    case 1073741901: return VK_END;
    case 1073741902: return VK_NEXT;    /* PageDown */
    case 1073741903: return VK_RIGHT;
    case 1073741904: return VK_LEFT;
    case 1073741905: return VK_DOWN;
    case 1073741906: return VK_UP;
    case 1073742048: case 1073742052: return VK_CONTROL;
    case 1073742049: case 1073742053: return VK_SHIFT;
    case 1073742050: case 1073742054: return VK_MENU;
    }
    if (sym >= 1073741882 && sym <= 1073741893) return VK_F1 + (sym - 1073741882);
    /* Shifted digit-row symbols ('!', '@', ...): the scancode names the key. */
    if (sc >= 30 && sc <= 38) return '1' + (sc - 30);
    if (sc == 39) return '0';
    if (sc >= 4 && sc <= 29) return 'A' + (sc - 4);
    if (sym > 0 && sym < 256) return sym;        /* punctuation: approximate */
    return 0;
}

SHORT GetKeyState(int vk) {
    /* SDL_KMOD_SHIFT = 0x3, CTRL = 0xC0, ALT = 0x300 (host keymod word). */
    int down = 0;
    if (vk == VK_SHIFT) down = (g_mod & 0x0003) != 0;
    else if (vk == VK_CONTROL) down = (g_mod & 0x00C0) != 0;
    else if (vk == VK_MENU) down = (g_mod & 0x0300) != 0;
    return down ? (SHORT)0x8000 : 0;
}

SHORT GetAsyncKeyState(int vk) { return GetKeyState(vk); }

/* ---- keyboard state/translation (0048, calc's vk2ascii path). One
 * synthetic US layout: processes see SDL's modifier-applied keysyms, so
 * VK->char here only has to reproduce the shift pairs a US keyboard has —
 * enough for ToAsciiEx-driven key mapping (calc's key2code). ---- */

HKL GetKeyboardLayout(DWORD thread) {
    (void)thread;
    return (HKL)0x04090409;                      /* en-US, the only layout */
}

BOOL GetKeyboardState(BYTE *state) {
    if (!state) return FALSE;
    memset(state, 0, 256);
    if (g_mod & 0x0003) state[VK_SHIFT] = 0x80;
    if (g_mod & 0x00C0) state[VK_CONTROL] = 0x80;
    if (g_mod & 0x0300) state[VK_MENU] = 0x80;
    return TRUE;
}

UINT MapVirtualKeyExW(UINT code, UINT type, HKL layout) {
    (void)layout;
    switch (type) {
    case 0: return code;        /* VK -> "scan code": a synthetic identity —
                                   the only consumer feeds it to ToAsciiEx */
    case 1: return code;        /* scan -> VK: same identity */
    case 2:                     /* VK -> unshifted char */
        if ((code >= '0' && code <= '9') || (code >= 'A' && code <= 'Z'))
            return code;
        return code >= 32 && code < 127 ? code : 0;
    }
    return 0;
}

int ToAsciiEx(UINT vk, UINT scan, const BYTE *state, LPWORD out, UINT flags, HKL layout) {
    (void)scan; (void)flags; (void)layout;
    if (!out) return 0;
    int shift = state && (state[VK_SHIFT] & 0x80);
    int ctrl = state && (state[VK_CONTROL] & 0x80);
    int ch = 0;
    if (ctrl && vk >= 'A' && vk <= 'Z') ch = (int)vk - 'A' + 1;  /* ^A..^Z */
    else if (vk >= 'A' && vk <= 'Z') ch = shift ? (int)vk : (int)vk + 32;
    else if (vk >= '0' && vk <= '9') ch = shift ? ")!@#$%^&*("[vk - '0'] : (int)vk;
    else if (vk == VK_RETURN) ch = 13;
    else if (vk == VK_BACK) ch = 8;
    else if (vk == VK_ESCAPE) ch = 27;
    else if (vk == VK_SPACE) ch = 32;
    else if (vk >= 32 && vk < 127) ch = (int)vk;  /* punctuation VKs are the
                                                     modifier-applied keysym */
    if (!ch) return 0;
    *out = (WORD)ch;
    return 1;
}

/* ---- TrackMouseEvent (0048, calc's hot-button highlight). One tracked
 * window (Windows tracks per-thread). HOVER is delivered at once — the
 * caller is already under the pointer (the WM_MOUSEMOVE that asked);
 * LEAVE auto-cancels once fired, Windows-style (route_mouse below). ---- */

static struct { HWND hwnd; UINT flags; } g_tme;

BOOL TrackMouseEvent(TRACKMOUSEEVENT *tme) {
    if (!tme || tme->cbSize != sizeof *tme) return FALSE;
    if (tme->dwFlags & TME_QUERY) {
        tme->dwFlags = g_tme.hwnd ? g_tme.flags : 0;
        tme->hwndTrack = g_tme.hwnd;
        tme->dwHoverTime = 0;
        return TRUE;
    }
    if (tme->dwFlags & TME_CANCEL) {
        if (g_tme.hwnd == tme->hwndTrack) g_tme.hwnd = NULL;
        return TRUE;
    }
    if (!tme->hwndTrack) return FALSE;
    g_tme.hwnd = tme->hwndTrack;
    g_tme.flags = tme->dwFlags & (TME_HOVER | TME_LEAVE);
    if (g_tme.flags & TME_HOVER)
        PostMessage(tme->hwndTrack, WM_MOUSEHOVER, 0, 0);
    return TRUE;
}

/* ============================================================ resources
 * The sidecar pack (0068): `<argv0>.res`, compiled by tools/win32rc.js —
 * the WRES layout THERE is the spec; this loader re-declares it (MUST
 * MATCH). Lazy: first Load* maps the whole pack into memory; a missing
 * pack just means every lookup fails (resource-less apps never notice). */

#define RT_BITMAP_K 2
#define RT_MENU_K 4
#define RT_DIALOG_K 5
#define RT_STRING_K 6
#define RT_ACCEL_K 9

static uint8_t *g_res;
static uint32_t g_resSize;
static int g_resState;          /* 0 untried, 1 loaded, -1 absent */

static uint32_t rd16(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8); }
static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void res_try(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 12 || n > 16 * 1024 * 1024) { fclose(f); return; }
    uint8_t *buf = (uint8_t *)malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return; }
    fclose(f);
    if (memcmp(buf, "WRES", 4) != 0 || rd32(buf + 4) != 2) { free(buf); return; }
    g_res = buf;
    g_resSize = (uint32_t)n;
    g_resState = 1;
}

static void res_ensure(void) {
    if (g_resState) return;
    g_resState = -1;
    WCHAR wpath[512];
    if (!GetModuleFileNameW(NULL, wpath, 512)) return;
    char *p8 = w2a_dup(wpath);
    if (!p8) return;
    char path[600];
    snprintf(path, sizeof path, "%s.res", p8);
    res_try(path);
    if (g_resState != 1) {                       /* PATH-spawned bare name */
        const char *base = strrchr(p8, '/');
        snprintf(path, sizeof path, "/bin/%s.res", base ? base + 1 : p8);
        res_try(path);
    }
    free(p8);
}

static const uint8_t *res_find(int type, int id, uint32_t *size) {
    res_ensure();
    if (g_resState != 1) return NULL;
    uint32_t count = rd32(g_res + 8);
    for (uint32_t i = 0; i < count && 12 + i * 12 + 12 <= g_resSize; i++) {
        const uint8_t *e = g_res + 12 + i * 12;
        if ((int)rd16(e) != type || (int)rd16(e + 2) != id) continue;
        uint32_t off = rd32(e + 4), sz = rd32(e + 8);
        if (off > g_resSize || sz > g_resSize - off) return NULL;
        if (size) *size = sz;
        return g_res + off;
    }
    return NULL;
}

int LoadStringW(HINSTANCE inst, UINT id, LPWSTR buf, int max) {
    (void)inst;
    if (!buf || max < 1) return 0;
    buf[0] = 0;
    uint32_t sz;
    const uint8_t *d = res_find(RT_STRING_K, (int)id, &sz);
    if (!d) return 0;
    char tmp[512];
    if (sz > sizeof tmp - 1) sz = sizeof tmp - 1;
    memcpy(tmp, d, sz);
    tmp[sz] = 0;
    return a2w_trunc(tmp, buf, max);
}

/* Uncompressed BI_RGB .bmp (1/4/8/24/32bpp) -> 32bpp RGBA HBITMAP (the
 * gdi32 pixel word: R | G<<8 | B<<16 | FF<<24). Bottom-up unless h < 0. */
static HBITMAP bmp_decode(const uint8_t *d, uint32_t n) {
    if (n < 54 || d[0] != 'B' || d[1] != 'M') return NULL;
    uint32_t dataOff = rd32(d + 10), hdrSize = rd32(d + 14);
    int w = (int)rd32(d + 18), h = (int)rd32(d + 22);
    int bpp = (int)rd16(d + 28);
    uint32_t comp = rd32(d + 30), clrUsed = rd32(d + 46);
    int topdown = h < 0, ah = topdown ? -h : h;
    if (hdrSize < 40 || comp != 0 || w < 1 || ah < 1 || w > 8192 || ah > 8192) return NULL;
    if (bpp != 1 && bpp != 4 && bpp != 8 && bpp != 24 && bpp != 32) return NULL;
    int palN = bpp <= 8 ? (int)(clrUsed ? clrUsed : (1u << bpp)) : 0;
    const uint8_t *pal = d + 14 + hdrSize;                  /* BGRA quads */
    if (14 + hdrSize + (uint32_t)palN * 4 > n) return NULL;
    uint32_t stride = (((uint32_t)w * bpp + 31) / 32) * 4;
    if (dataOff > n || stride * (uint32_t)ah > n - dataOff) return NULL;
    uint32_t *px = (uint32_t *)malloc((size_t)w * ah * 4);
    if (!px) return NULL;
    for (int row = 0; row < ah; row++) {
        const uint8_t *src = d + dataOff + (size_t)stride * (topdown ? row : ah - 1 - row);
        uint32_t *dst = px + (size_t)row * w;
        for (int col = 0; col < w; col++) {
            uint32_t r, g, b;
            if (bpp == 24 || bpp == 32) {
                const uint8_t *p = src + (size_t)col * (bpp / 8);
                b = p[0]; g = p[1]; r = p[2];
            } else {
                int idx;
                if (bpp == 8) idx = src[col];
                else if (bpp == 4) idx = (src[col / 2] >> (col & 1 ? 0 : 4)) & 0xF;
                else idx = (src[col / 8] >> (7 - (col & 7))) & 1;
                if (idx >= palN) idx = 0;
                const uint8_t *p = pal + (size_t)idx * 4;
                b = p[0]; g = p[1]; r = p[2];
            }
            dst[col] = r | (g << 8) | (b << 16) | 0xFF000000u;
        }
    }
    HBITMAP bm = CreateBitmap(w, ah, 1, 32, px);
    free(px);
    return bm;
}

HBITMAP LoadBitmapW(HINSTANCE inst, LPCWSTR name) {
    (void)inst;
    if (!is_intres(name)) return NULL;           /* named resources: none */
    uint32_t sz;
    const uint8_t *d = res_find(RT_BITMAP_K, (int)(UINT_PTR)name, &sz);
    return d ? bmp_decode(d, sz) : NULL;
}

/* Icons and cursors are STUB HANDLES: the kernel chrome owns window
 * decoration and there is no free cursor (the page pointer is the
 * pointer), so apps get distinct non-NULL tokens and DrawIcon no-ops.
 * The .ico/.cur assets are deliberately not vendored (0068). */
static int g_iconStub;

HICON LoadIconW(HINSTANCE inst, LPCWSTR name) {
    (void)inst; (void)name;
    return (HICON)&g_iconStub;
}

/* System cursor shapes (todos/0105): an HCURSOR token carries its
 * SDL_SystemCursor shape so SetCursor can push it to the surface via the SDL
 * cursor path (the kernel then shows it over this window's client, and
 * overlays chrome resize cursors on the frame itself). System shapes only —
 * the .cur assets stay unvendored (0068). g_cursorShape[i] == i, so its
 * address IS a shape-tagged handle; g_sdlCursor caches the SDL objects so a
 * per-move SetCursor doesn't leak one each call. */
static unsigned char g_cursorShape[SDL_SYSTEM_CURSOR_COUNT];
static SDL_Cursor *g_sdlCursor[SDL_SYSTEM_CURSOR_COUNT];
static int g_cursorInit;

static HCURSOR cursor_token(int shape) {
    if (!g_cursorInit) {
        for (int i = 0; i < SDL_SYSTEM_CURSOR_COUNT; i++)
            g_cursorShape[i] = (unsigned char)i;
        g_cursorInit = 1;
    }
    if (shape < 0 || shape >= SDL_SYSTEM_CURSOR_COUNT) shape = SDL_SYSTEM_CURSOR_DEFAULT;
    return (HCURSOR)&g_cursorShape[shape];
}

HCURSOR LoadCursorW(HINSTANCE inst, LPCWSTR name) {
    (void)inst;
    /* IDC_* are MAKEINTRESOURCE(id) — compare the ordinal value (the veneer
     * builds ANSI, so IDC_* are LPSTR; compare as integers to sidestep the
     * pointer-type mismatch). Map the shapes the CSS cursor set can render;
     * the rest fall to arrow. */
    ULONG_PTR id = (ULONG_PTR)name;
    int shape = SDL_SYSTEM_CURSOR_DEFAULT;
    if (id == 32513)      shape = SDL_SYSTEM_CURSOR_TEXT;       /* IDC_IBEAM */
    else if (id == 32514) shape = SDL_SYSTEM_CURSOR_WAIT;       /* IDC_WAIT */
    else if (id == 32515) shape = SDL_SYSTEM_CURSOR_CROSSHAIR;  /* IDC_CROSS */
    return cursor_token(shape);
}

HANDLE LoadImageW(HINSTANCE inst, LPCWSTR name, UINT type, int cx, int cy, UINT flags) {
    (void)cx; (void)cy;
    if (flags & LR_LOADFROMFILE) return NULL;    /* pack-only */
    if (type == IMAGE_BITMAP) return (HANDLE)LoadBitmapW(inst, name);
    if (type == IMAGE_ICON) return (HANDLE)LoadIconW(inst, name);
    if (type == IMAGE_CURSOR) return (HANDLE)LoadCursorW(inst, name);
    return NULL;
}

BOOL DestroyIcon(HICON icon) { (void)icon; return TRUE; }
BOOL DestroyCursor(HCURSOR cur) { (void)cur; return TRUE; }
BOOL DrawIcon(HDC hdc, int x, int y, HICON icon) { (void)hdc; (void)x; (void)y; (void)icon; return TRUE; }

static HCURSOR g_curCursor;

HCURSOR SetCursor(HCURSOR cur) {
    HCURSOR old = g_curCursor;
    if (cur == g_curCursor) return old;         /* debounce redundant sets */
    g_curCursor = cur;
    /* Route to the surface (todos/0105). A cursor token is &g_cursorShape[shape]
     * (system cursors) — read the shape back and push the cached SDL cursor;
     * NULL hides (Win32 SetCursor(NULL)). Foreign tokens fall to the arrow. */
    if (!cur) { SDL_HideCursor(); return old; }
    int shape = SDL_SYSTEM_CURSOR_DEFAULT;
    if (cur >= (HCURSOR)&g_cursorShape[0] &&
        cur < (HCURSOR)&g_cursorShape[SDL_SYSTEM_CURSOR_COUNT])
        shape = *(unsigned char *)cur;
    if (!g_sdlCursor[shape]) g_sdlCursor[shape] = SDL_CreateSystemCursor(shape);
    SDL_ShowCursor();
    SDL_SetCursor(g_sdlCursor[shape]);
    return old;
}

/* ============================================================ accelerators
 * WRES type 9: u16 n, then n x { u8 fFlags, u16 key, u16 cmd } — fFlags is
 * the Windows ACCEL word (FVIRTKEY 1, FNOINVERT 2, FSHIFT 4, FCONTROL 8,
 * FALT 16). */

typedef struct {
    int n;
    struct { uint8_t flags; uint16_t key, cmd; } e[64];
} AccelTbl;

HACCEL LoadAcceleratorsW(HINSTANCE inst, LPCWSTR name) {
    (void)inst;
    if (!is_intres(name)) return NULL;
    uint32_t sz;
    const uint8_t *d = res_find(RT_ACCEL_K, (int)(UINT_PTR)name, &sz);
    if (!d || sz < 2) return NULL;
    int n = (int)rd16(d);
    if (n < 0 || n > 64 || sz < 2 + (uint32_t)n * 5) return NULL;
    AccelTbl *t = (AccelTbl *)calloc(1, sizeof(AccelTbl));
    if (!t) return NULL;
    t->n = n;
    for (int i = 0; i < n; i++) {
        const uint8_t *p = d + 2 + i * 5;
        t->e[i].flags = p[0];
        t->e[i].key = (uint16_t)rd16(p + 1);
        t->e[i].cmd = (uint16_t)rd16(p + 3);
    }
    return (HACCEL)t;
}

BOOL DestroyAcceleratorTable(HACCEL acc) {
    free(acc);
    return acc != NULL;
}

/* Runtime tables (0092): the same AccelTbl as LoadAccelerators, built from
 * an ACCEL array instead of a .res — fileman's F2/Del/^C/^X/^V. */
HACCEL CreateAcceleratorTableA(ACCEL *entries, int n) {
    if (!entries || n <= 0 || n > 64) return NULL;
    AccelTbl *t = (AccelTbl *)calloc(1, sizeof(AccelTbl));
    if (!t) return NULL;
    t->n = n;
    for (int i = 0; i < n; i++) {
        t->e[i].flags = entries[i].fVirt;
        t->e[i].key = entries[i].key;
        t->e[i].cmd = entries[i].cmd;
    }
    return (HACCEL)t;
}

int TranslateAcceleratorW(HWND hwnd, HACCEL acc, MSG *msg) {
    if (!hwnd || !acc || !msg || msg->message != WM_KEYDOWN) return 0;
    AccelTbl *t = (AccelTbl *)acc;
    int shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
    int ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    int alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
    for (int i = 0; i < t->n; i++) {
        if (!(t->e[i].flags & 0x01)) continue;   /* VIRTKEY entries only */
        if ((int)msg->wParam != t->e[i].key) continue;
        if (((t->e[i].flags & 0x04) != 0) != shift) continue;
        if (((t->e[i].flags & 0x08) != 0) != ctrl) continue;
        if (((t->e[i].flags & 0x10) != 0) != alt) continue;
        SendMessage(hwnd, WM_COMMAND, MAKEWPARAM(t->e[i].cmd, 1), 0);
        return 1;
    }
    return 0;
}

/* ============================================================ menus
 * The HMENU model (0068): an item tree. The BAR renders into the top
 * MENU_BAR_H pixels of the top-level surface at every present
 * (menu_overlay_draw from ReleaseDC); an open popup renders below its bar
 * title, INSIDE the surface (a surface cannot overflow its kernel
 * window — tall popups clip). Mouse-driven + ESC; items are also agent
 * targets (the tree dump lists them; AQ_CLICK posts WM_COMMAND). */

typedef struct __MENUITEM {
    int kind;                   /* 0 item, 1 popup, 2 separator */
    int id;
    UINT state;                 /* MF_CHECKED | MF_GRAYED | MF_DISABLED */
    char *text;                 /* UTF-8; '&' mnemonic kept, '\t' splits accel */
    HMENU sub;
} MenuItem;

typedef struct {
    int n, cap;
    MenuItem *items;
} MenuTbl;

#define MENU_T(m) ((MenuTbl *)(m))
#define MENU_ITEM_H 18
#define MENU_SEP_H 8
#define MENU_GUTTER 16

static void strip_amp(const char *in, char *out, int cap);   /* agent section */

HMENU CreateMenu(void) { return (HMENU)calloc(1, sizeof(MenuTbl)); }
HMENU CreatePopupMenu(void) { return CreateMenu(); }

static MenuItem *menu_append(MenuTbl *m, int kind, int id, const char *text, HMENU sub) {
    if (!m) return NULL;
    if (m->n >= m->cap) {
        int nc = m->cap ? m->cap * 2 : 8;
        MenuItem *ni = (MenuItem *)realloc(m->items, (size_t)nc * sizeof(MenuItem));
        if (!ni) return NULL;
        m->items = ni;
        m->cap = nc;
    }
    MenuItem *it = &m->items[m->n++];
    memset(it, 0, sizeof *it);
    it->kind = kind;
    it->id = id;
    it->sub = sub;
    if (text) {
        size_t len = strlen(text);
        it->text = (char *)malloc(len + 1);
        if (it->text) memcpy(it->text, text, len + 1);
    }
    return it;
}

BOOL DestroyMenu(HMENU menu) {
    MenuTbl *m = MENU_T(menu);
    if (!m) return FALSE;
    for (int i = 0; i < m->n; i++) {
        free(m->items[i].text);
        if (m->items[i].sub) DestroyMenu(m->items[i].sub);
    }
    free(m->items);
    free(m);
    return TRUE;
}

BOOL AppendMenuW(HMENU menu, UINT flags, UINT_PTR id, LPCWSTR text) {
    if (!menu) return FALSE;
    char *t = (text && !is_intres(text)) ? w2a_dup(text) : NULL;
    MenuItem *it;
    if (flags & MF_SEPARATOR) it = menu_append(MENU_T(menu), 2, 0, NULL, NULL);
    else if (flags & MF_POPUP) it = menu_append(MENU_T(menu), 1, 0, t ? t : "", (HMENU)id);
    else it = menu_append(MENU_T(menu), 0, (int)id, t ? t : "", NULL);
    free(t);
    if (it) it->state = flags & (MF_CHECKED | MF_GRAYED | MF_DISABLED);
    return it != NULL;
}

/* ANSI twin (0092: fileman's runtime context menu; text is UTF-8, the
 * internal MenuItem encoding already). */
BOOL AppendMenuA(HMENU menu, UINT flags, UINT_PTR id, LPCSTR text) {
    if (!menu) return FALSE;
    MenuItem *it;
    if (flags & MF_SEPARATOR) it = menu_append(MENU_T(menu), 2, 0, NULL, NULL);
    else if (flags & MF_POPUP) it = menu_append(MENU_T(menu), 1, 0, text ? text : "", (HMENU)id);
    else it = menu_append(MENU_T(menu), 0, (int)id, text ? text : "", NULL);
    if (it) it->state = flags & (MF_CHECKED | MF_GRAYED | MF_DISABLED);
    return it != NULL;
}

/* WRES type 4 (recursive): u16 n, then items — see tools/win32rc.js. */
static const uint8_t *menu_parse(const uint8_t *p, const uint8_t *end, MenuTbl *m) {
    if (!p || p + 2 > end) return NULL;
    int n = (int)rd16(p);
    p += 2;
    for (int i = 0; i < n; i++) {
        if (p >= end) return NULL;
        int kind = *p++;
        if (kind == 2) { menu_append(m, 2, 0, NULL, NULL); continue; }
        int id = 0;
        if (kind == 0) {
            if (p + 2 > end) return NULL;
            id = (int)rd16(p);
            p += 2;
        }
        if (p + 2 > end) return NULL;
        int tl = (int)rd16(p);
        p += 2;
        if (p + tl > end) return NULL;
        char *t = (char *)malloc((size_t)tl + 1);
        if (!t) return NULL;
        memcpy(t, p, (size_t)tl);
        t[tl] = 0;
        p += tl;
        if (kind == 1) {
            HMENU sub = CreateMenu();
            menu_append(m, 1, 0, t, sub);
            p = menu_parse(p, end, MENU_T(sub));
            if (!p) { free(t); return NULL; }
        } else {
            menu_append(m, 0, id, t, NULL);
        }
        free(t);
    }
    return p;
}

HMENU LoadMenuW(HINSTANCE inst, LPCWSTR name) {
    (void)inst;
    if (!is_intres(name)) return NULL;
    uint32_t sz;
    const uint8_t *d = res_find(RT_MENU_K, (int)(UINT_PTR)name, &sz);
    if (!d) return NULL;
    HMENU m = CreateMenu();
    if (!m) return NULL;
    if (!menu_parse(d, d + sz, MENU_T(m))) { DestroyMenu(m); return NULL; }
    return m;
}

HMENU GetMenu(HWND h) { return h ? h->top->menu : NULL; }

BOOL SetMenu(HWND h, HMENU menu) {
    if (!h || !is_top(h)) return FALSE;
    h->menu = menu;
    InvalidateRect(h, NULL, TRUE);
    return TRUE;
}

HMENU GetSubMenu(HMENU menu, int pos) {
    MenuTbl *m = MENU_T(menu);
    if (!m || pos < 0 || pos >= m->n) return NULL;
    return m->items[pos].sub;
}

/* Label lookup for the agent (0068): '&' stripped, accel tab cut. */
static MenuItem *menu_find_label(MenuTbl *m, const char *label) {
    if (!m) return NULL;
    for (int i = 0; i < m->n; i++) {
        MenuItem *it = &m->items[i];
        if (it->kind == 0 && it->text) {
            char stripped[128];
            strip_amp(it->text, stripped, sizeof stripped);
            char *tab = strchr(stripped, '\t');
            if (tab) *tab = 0;
            if (strcmp(stripped, label) == 0) return it;
        }
        if (it->sub) {
            MenuItem *f = menu_find_label(MENU_T(it->sub), label);
            if (f) return f;
        }
    }
    return NULL;
}

static MenuItem *menu_find_cmd(MenuTbl *m, int id) {
    if (!m) return NULL;
    for (int i = 0; i < m->n; i++) {
        if (m->items[i].kind == 0 && m->items[i].id == id) return &m->items[i];
        if (m->items[i].sub) {
            MenuItem *f = menu_find_cmd(MENU_T(m->items[i].sub), id);
            if (f) return f;
        }
    }
    return NULL;
}

static MenuItem *menu_item_of(HMENU menu, UINT id, UINT flags) {
    MenuTbl *m = MENU_T(menu);
    if (!m) return NULL;
    if (flags & MF_BYPOSITION)
        return (int)id < m->n ? &m->items[id] : NULL;
    return menu_find_cmd(m, (int)id);
}

DWORD CheckMenuItem(HMENU menu, UINT id, UINT check) {
    MenuItem *it = menu_item_of(menu, id, check);
    if (!it) return (DWORD)-1;
    DWORD prev = it->state & MF_CHECKED;
    if (check & MF_CHECKED) it->state |= MF_CHECKED;
    else it->state &= ~MF_CHECKED;
    return prev;
}

BOOL EnableMenuItem(HMENU menu, UINT id, UINT enable) {
    MenuItem *it = menu_item_of(menu, id, enable);
    if (!it) return -1;
    UINT prev = it->state & (MF_GRAYED | MF_DISABLED);
    it->state &= ~(MF_GRAYED | MF_DISABLED);
    it->state |= enable & (MF_GRAYED | MF_DISABLED);
    return (BOOL)prev;
}

BOOL DrawMenuBar(HWND h) {
    if (!h) return FALSE;
    InvalidateRect(h->top, NULL, TRUE);
    return TRUE;
}

/* ---- menu geometry + drawing (bar and popup share the measuring DC) ---- */

static struct {
    HWND top;
    int open;                   /* a popup is showing */
    int barIdx;                 /* which bar item's popup; -1 = standalone */
    int hot;                    /* hot popup row, -1 none */
    MenuTbl *pop;               /* the open popup's items (bar sub or standalone) */
    MenuTbl *sub;               /* open cascade of pop's row subRow (0211) */
    int subRow, subHot;         /*   one nested level, the paint Tools case */
    int sx, sy;                 /* standalone (TrackPopupMenu) anchor, surface coords */
    HWND owner;                 /* standalone: WM_COMMAND target */
    UINT tpmFlags;              /* standalone: TPM_* word */
    int retcmd;                 /* standalone TPM_RETURNCMD result */
} g_menu;

static int menu_standalone(void) { return g_menu.open && g_menu.barIdx < 0; }

static int menu_overlay_wanted(HWND top) {
    return top->menu != NULL || (g_menu.open && g_menu.top == top);
}

static HDC menu_mdc(void) {
    static HDC dc;
    if (!dc) dc = CreateCompatibleDC(NULL);
    return dc;
}

static int menu_text_w(const char *text) {      /* up to the accel tab */
    char label[128];
    strip_amp(text ? text : "", label, sizeof label);
    char *tab = strchr(label, '\t');
    if (tab) *tab = 0;
    SIZE sz;
    GetTextExtentPoint32(menu_mdc(), label, (int)strlen(label), &sz);
    return sz.cx;
}

/* Bar item i's rect in SURFACE coords; returns 0 past the end. */
static int menu_bar_rect(HWND top, int i, RECT *r) {
    MenuTbl *m = MENU_T(top->menu);
    if (!m || i < 0 || i >= m->n) return 0;
    int x = 2;
    for (int k = 0; k < i; k++) x += menu_text_w(m->items[k].text) + 16;
    SetRect(r, x, 0, x + menu_text_w(m->items[i].text) + 16, MENU_BAR_H);
    return 1;
}

static int menu_bar_at(HWND top, int x, int y) {
    if (y < 0 || y >= MENU_BAR_H) return -1;
    MenuTbl *m = MENU_T(top->menu);
    for (int i = 0; m && i < m->n; i++) {
        RECT r;
        if (menu_bar_rect(top, i, &r) && x >= r.left && x < r.right) return i;
    }
    return -1;
}

static int menu_row_h(const MenuItem *it) {
    return it->kind == 2 ? MENU_SEP_H : MENU_ITEM_H;
}

/* Measured size of a popup table (0211: shared by root + cascade). */
static void menu_tbl_size(MenuTbl *m, int *wOut, int *hOut) {
    int w = 60, h = 2;
    for (int i = 0; m && i < m->n; i++) {
        const MenuItem *it = &m->items[i];
        h += menu_row_h(it);
        if (it->kind != 2) {
            int tw = menu_text_w(it->text) + MENU_GUTTER + 20;
            const char *tab = it->text ? strchr(it->text, '\t') : NULL;
            if (tab) {
                SIZE az;
                GetTextExtentPoint32(menu_mdc(), tab + 1, (int)strlen(tab + 1), &az);
                tw += az.cx + 12;
            }
            if (tw > w) w = tw;
        }
    }
    *wOut = w;
    *hOut = h + 2;
}

/* Popup rect for the open popup (bar item or standalone), clamped inside
 * the surface. */
static void menu_popup_rect(HWND top, RECT *out) {
    SDL_Surface *s = SDL_GetWindowSurface(top->win);
    int w, h;
    menu_tbl_size(g_menu.pop, &w, &h);
    int x, y;
    if (menu_standalone()) {
        x = g_menu.sx;
        y = g_menu.sy;
        if (s && y + h > s->h) y = s->h - h;     /* flip up against the edge */
        if (y < 0) y = 0;
    } else {
        RECT br;
        menu_bar_rect(top, g_menu.barIdx, &br);
        x = br.left;
        y = MENU_BAR_H;
    }
    if (s && x + w > s->w) x = s->w - w;
    if (x < 0) x = 0;
    int maxH = s ? s->h - y : h;
    SetRect(out, x, y, x + w, y + (h > maxH ? maxH : h));
}

/* The open cascade's rect (0211): hung off its anchor row's right edge,
 * flipped left when it would overflow the surface. */
static void menu_sub_rect(HWND top, RECT *out) {
    RECT pr;
    menu_popup_rect(top, &pr);
    int y = pr.top + 1;
    for (int i = 0; i < g_menu.subRow && i < g_menu.pop->n; i++)
        y += menu_row_h(&g_menu.pop->items[i]);
    SDL_Surface *s = SDL_GetWindowSurface(top->win);
    int w, h;
    menu_tbl_size(g_menu.sub, &w, &h);
    int x = pr.right - 3;
    if (s && x + w > s->w) x = pr.left - w + 3;
    if (x < 0) x = 0;
    if (s && y + h > s->h) y = s->h - h;
    if (y < 0) y = 0;
    int maxH = s ? s->h - y : h;
    SetRect(out, x, y, x + w, y + (h > maxH ? maxH : h));
}

/* Row index of table m (drawn at pr) at surface (x, y); -1 outside. */
static int menu_tbl_at(MenuTbl *m, const RECT *pr, int x, int y) {
    POINT p = { x, y };
    if (!m || !PtInRect(pr, p)) return -1;
    int ry = pr->top + 1;
    for (int i = 0; i < m->n; i++) {
        int rh = menu_row_h(&m->items[i]);
        if (y >= ry && y < ry + rh) return i;
        ry += rh;
    }
    return -1;
}

/* Popup row index at surface (x, y); -1 outside/none. */
static int menu_popup_at(HWND top, int x, int y) {
    if (!g_menu.open) return -1;
    RECT pr;
    menu_popup_rect(top, &pr);
    return menu_tbl_at(g_menu.pop, &pr, x, y);
}

static int menu_sub_at(HWND top, int x, int y) {
    if (!g_menu.open || !g_menu.sub) return -1;
    RECT sr;
    menu_sub_rect(top, &sr);
    return menu_tbl_at(g_menu.sub, &sr, x, y);
}

static void draw_raised(HDC dc, RECT r, int sunken);         /* controls section */

static void menu_draw_bar_into(HWND top, HDC dc, int surfW) {
    RECT bar;
    SetRect(&bar, 0, 0, surfW, MENU_BAR_H);
    FillRect(dc, &bar, GetSysColorBrush(COLOR_BTNFACE));
    RECT edge;
    SetRect(&edge, 0, MENU_BAR_H - 1, surfW, MENU_BAR_H);
    FillRect(dc, &edge, GetSysColorBrush(COLOR_BTNSHADOW));
    SetBkMode(dc, TRANSPARENT);
    MenuTbl *m = MENU_T(top->menu);
    for (int i = 0; m && i < m->n; i++) {
        RECT r;
        if (!menu_bar_rect(top, i, &r)) break;
        int open = g_menu.open && g_menu.top == top && g_menu.barIdx == i;
        if (open) FillRect(dc, &r, GetSysColorBrush(COLOR_HIGHLIGHT));
        SetTextColor(dc, GetSysColor(open ? COLOR_HIGHLIGHTTEXT : COLOR_BTNTEXT));
        char label[128];
        strip_amp(m->items[i].text ? m->items[i].text : "", label, sizeof label);
        TextOut(dc, r.left + 8, 2, label, (int)strlen(label));
    }
}

static void menu_draw_tbl(HDC dc, MenuTbl *m, const RECT *prp, int hotRow) {
    RECT pr = *prp;
    FillRect(dc, &pr, GetSysColorBrush(COLOR_MENU));
    draw_raised(dc, pr, 0);
    SetBkMode(dc, TRANSPARENT);
    int y = pr.top + 1;
    for (int i = 0; m && i < m->n; i++) {
        const MenuItem *it = &m->items[i];
        int rh = menu_row_h(it);
        if (y + rh > pr.bottom) break;                       /* clipped tail */
        if (it->kind == 2) {
            RECT s1;
            SetRect(&s1, pr.left + 2, y + rh / 2 - 1, pr.right - 2, y + rh / 2);
            FillRect(dc, &s1, GetSysColorBrush(COLOR_BTNSHADOW));
            SetRect(&s1, pr.left + 2, y + rh / 2, pr.right - 2, y + rh / 2 + 1);
            FillRect(dc, &s1, GetSysColorBrush(COLOR_BTNHIGHLIGHT));
        } else {
            int grayed = (it->state & (MF_GRAYED | MF_DISABLED)) != 0;
            int hot = hotRow == i && !grayed;
            if (hot) {
                RECT hr;
                SetRect(&hr, pr.left + 1, y, pr.right - 1, y + rh);
                FillRect(dc, &hr, GetSysColorBrush(COLOR_HIGHLIGHT));
            }
            SetTextColor(dc, GetSysColor(grayed ? COLOR_GRAYTEXT
                                                : hot ? COLOR_HIGHLIGHTTEXT : COLOR_MENUTEXT));
            char label[128];
            strip_amp(it->text ? it->text : "", label, sizeof label);
            char *tab = strchr(label, '\t');
            if (tab) *tab = 0;
            TextOut(dc, pr.left + MENU_GUTTER, y + 2, label, (int)strlen(label));
            if (tab)                                          /* accel column */
                TextOut(dc, pr.right - 8 - menu_text_w(tab + 1) - 0, y + 2,
                        tab + 1, (int)strlen(tab + 1));
            if (it->kind == 1) {                              /* cascade ► (0211) */
                POINT tri[3];
                int cx = pr.right - 8, cy = y + rh / 2;
                tri[0].x = cx + 3; tri[0].y = cy;
                tri[1].x = cx - 2; tri[1].y = cy - 4;
                tri[2].x = cx - 2; tri[2].y = cy + 4;
                HBRUSH tb = CreateSolidBrush(
                    GetSysColor(hot ? COLOR_HIGHLIGHTTEXT : COLOR_MENUTEXT));
                HGDIOBJ ob = SelectObject(dc, (HGDIOBJ)tb);
                HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
                Polygon(dc, tri, 3);
                SelectObject(dc, op);
                SelectObject(dc, ob);
                DeleteObject((HGDIOBJ)tb);
            }
            if (it->state & MF_CHECKED) {                     /* check mark */
                HPEN p = CreatePen(PS_SOLID, 1,
                                   GetSysColor(hot ? COLOR_HIGHLIGHTTEXT : COLOR_MENUTEXT));
                HGDIOBJ op = SelectObject(dc, (HGDIOBJ)p);
                for (int k = 0; k < 2; k++) {
                    MoveToEx(dc, pr.left + 4, y + 8 + k, NULL);
                    LineTo(dc, pr.left + 6, y + 10 + k);
                    LineTo(dc, pr.left + 11, y + 5 + k);
                }
                SelectObject(dc, op);
                DeleteObject((HGDIOBJ)p);
            }
        }
        y += rh;
    }
}

static void menu_draw_popup_into(HWND top, HDC dc) {
    RECT pr;
    menu_popup_rect(top, &pr);
    menu_draw_tbl(dc, g_menu.pop, &pr, g_menu.hot);
    if (g_menu.sub) {                            /* the open cascade (0211) */
        RECT sr;
        menu_sub_rect(top, &sr);
        menu_draw_tbl(dc, g_menu.sub, &sr, g_menu.subHot);
    }
}

static void menu_overlay_draw(HWND top) {
    SDL_Surface *s = SDL_GetWindowSurface(top->win);
    if (!s) return;
    HDC dc = __gdi_dc_wrap(s->pixels, s->w, s->h, s->pitch / 4);
    if (!dc) return;
    if (top->menu) menu_draw_bar_into(top, dc, s->w);
    if (g_menu.open && g_menu.top == top) menu_draw_popup_into(top, dc);
    __gdi_dc_unwrap(dc);                        /* present is the caller's */
}

static void menu_present(HWND top) {            /* overlay-only refresh */
    menu_overlay_draw(top);
    SDL_UpdateWindowSurface(top->win);
}

static void menu_close(void) {
    if (!g_menu.open) return;
    HWND t = g_menu.top;
    int standalone = menu_standalone();
    g_menu.open = 0;
    g_menu.top = NULL;
    g_menu.pop = NULL;
    g_menu.sub = NULL;
    g_menu.subHot = -1;
    /* the popup overwrote client pixels: have the app repaint them */
    if (t) {
        /* wParam TRUE for a TrackPopupMenu loop, like Windows (0211) */
        SendMessage(t, WM_EXITMENULOOP, standalone ? TRUE : FALSE, 0);
        InvalidateRect(t, NULL, TRUE);
        PostMessage(t, WM_NULL, 0, 0);           /* wake a modal popup pump */
    }
}

/* Cascade open/close (0211): ONE nested level — the corpus (paint's
 * Tools ▸ Width) needs exactly one; a sub-sub popup reports unsupported. */
static void menu_sub_close(HWND top) {
    if (!g_menu.sub) return;
    g_menu.sub = NULL;
    g_menu.subHot = -1;
    InvalidateRect(top, NULL, TRUE);             /* cascade pixels differ */
    menu_present(top);
}

static void menu_sub_open(HWND top, int row) {
    MenuTbl *m = g_menu.pop;
    if (!m || row < 0 || row >= m->n) return;
    MenuItem *it = &m->items[row];
    if (it->kind != 1 || !it->sub || (it->state & (MF_GRAYED | MF_DISABLED)))
        return;
    if (g_menu.sub && g_menu.subRow == row) return;          /* already open */
    for (int i = 0; i < MENU_T(it->sub)->n; i++)
        if (MENU_T(it->sub)->items[i].kind == 1)
            WIN32_UNSUPPORTED("menu cascade deeper than one level");
    g_menu.sub = MENU_T(it->sub);
    g_menu.subRow = row;
    g_menu.subHot = -1;
    SendMessage(top, WM_INITMENUPOPUP, (WPARAM)it->sub, MAKELPARAM(row, FALSE));
    InvalidateRect(top, NULL, TRUE);
    menu_present(top);
}

static void menu_open_popup(HWND top, int idx) {
    MenuTbl *m = MENU_T(top->menu);
    if (!m || idx < 0 || idx >= m->n) return;
    if (m->items[idx].kind != 1 || !m->items[idx].sub) return;   /* bar popups only */
    if (!g_menu.open) {                          /* the Windows notification pair */
        SendMessage(top, WM_ENTERMENULOOP, 0, 0);
        SendMessage(top, WM_INITMENU, (WPARAM)top->menu, 0);
    }
    g_menu.top = top;
    g_menu.open = 1;
    g_menu.barIdx = idx;
    g_menu.pop = MENU_T(m->items[idx].sub);
    g_menu.hot = -1;
    g_menu.sub = NULL;
    g_menu.subHot = -1;
    SendMessage(top, WM_INITMENUPOPUP, (WPARAM)m->items[idx].sub,
                MAKELPARAM(idx, FALSE));
    menu_present(top);
}

static void menu_fire_in(HWND top, MenuTbl *m, int row) {
    if (!m || row < 0 || row >= m->n) return;
    MenuItem *it = &m->items[row];
    if (it->kind != 0 || (it->state & (MF_GRAYED | MF_DISABLED))) return;
    int standalone = menu_standalone();
    HWND owner = g_menu.owner;
    UINT tpm = g_menu.tpmFlags;
    menu_close();
    if (standalone) {
        if (tpm & TPM_RETURNCMD) g_menu.retcmd = it->id;
        else if (!(tpm & TPM_NONOTIFY) && owner)
            PostMessage(owner, WM_COMMAND, MAKEWPARAM(it->id, 0), 0);
    } else {
        PostMessage(top, WM_COMMAND, MAKEWPARAM(it->id, 0), 0);
    }
}

/* Mouse in SURFACE coords. Returns 1 if the menu consumed the event. */
static int menu_route_mouse(HWND top, UINT msg, int x, int y) {
    if (!top->menu && !(g_menu.open && g_menu.top == top)) return 0;
    if (g_menu.open && g_menu.top == top) {
        int row = menu_popup_at(top, x, y);
        int srow = menu_sub_at(top, x, y);       /* cascade rows (0211) */
        int bi = menu_standalone() ? -1 : menu_bar_at(top, x, y);
        switch (msg) {
        case WM_MOUSEMOVE:
            if (srow >= 0) {                     /* inside the cascade */
                if (srow != g_menu.subHot) {
                    g_menu.subHot = srow;
                    menu_present(top);
                }
                return 1;
            }
            if (bi >= 0 && bi != g_menu.barIdx &&
                MENU_T(top->menu)->items[bi].kind == 1) {
                g_menu.barIdx = bi;              /* hover-switch, Windows-style */
                g_menu.pop = MENU_T(MENU_T(top->menu)->items[bi].sub);
                g_menu.hot = -1;
                g_menu.sub = NULL;
                g_menu.subHot = -1;
                SendMessage(top, WM_INITMENUPOPUP,
                            (WPARAM)MENU_T(top->menu)->items[bi].sub,
                            MAKELPARAM(bi, FALSE));
                InvalidateRect(top, NULL, TRUE); /* old popup pixels differ */
                menu_present(top);
            } else if (row >= 0 && row != g_menu.hot) {
                g_menu.hot = row;
                if (g_menu.pop->items[row].kind == 1)
                    menu_sub_open(top, row);     /* hover opens the cascade */
                else if (g_menu.sub)
                    menu_sub_close(top);
                menu_present(top);
            } else if (row != g_menu.hot && !g_menu.sub) {
                g_menu.hot = row;                /* left the popup: unhot */
                menu_present(top);
            }
            return 1;
        case WM_LBUTTONDOWN:
        case WM_LBUTTONDBLCLK:
            if (srow >= 0) { menu_fire_in(top, g_menu.sub, srow); return 1; }
            if (row >= 0) {
                if (g_menu.pop->items[row].kind == 1) {
                    g_menu.hot = row;
                    menu_sub_open(top, row);     /* click opens the cascade */
                } else {
                    menu_fire_in(top, g_menu.pop, row);
                }
                return 1;
            }
            if (bi >= 0) {
                if (bi == g_menu.barIdx) menu_close();
                else menu_open_popup(top, bi);
                return 1;
            }
            menu_close();                        /* click outside swallowed */
            return 1;
        case WM_LBUTTONUP:
            if (srow >= 0) menu_fire_in(top, g_menu.sub, srow);
            else if (row >= 0) menu_fire_in(top, g_menu.pop, row);
            return 1;                            /* press-drag-release */
        case WM_RBUTTONDOWN:
            if (row < 0 && srow < 0 && bi < 0)
                menu_close();                    /* outside closes (0091) */
            return 1;
        default:
            return 1;                            /* modal while open */
        }
    }
    if (top->menu && y >= 0 && y < MENU_BAR_H) {
        if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONDBLCLK)
            menu_open_popup(top, menu_bar_at(top, x, y));
        return 1;                                /* the bar is user32's */
    }
    return 0;
}

/* TrackPopupMenu (0048): a STANDALONE popup at (x, y) — the same overlay
 * machinery as the bar popups (barIdx == -1 marks it) plus its own modal
 * pump. Coords are the owner top-level's SURFACE coords: processes can't
 * see the screen, so the surface IS "the screen" here — WM_CONTEXTMENU
 * (DefWindowProc below) hands out the same space, so the usual
 * pass-the-lParam-through pattern round-trips. */
BOOL TrackPopupMenu(HMENU menu, UINT flags, int x, int y, int reserved,
                    HWND hwnd, const RECT *r) {
    (void)reserved; (void)r;
    if (!menu || !hwnd) return FALSE;
    if (g_menu.open) menu_close();
    HWND top = hwnd->top;
    SendMessage(top, WM_ENTERMENULOOP, TRUE, 0);
    g_menu.top = top;
    g_menu.open = 1;
    g_menu.barIdx = -1;
    g_menu.pop = MENU_T(menu);
    g_menu.hot = -1;
    g_menu.sx = x;
    g_menu.sy = y;
    g_menu.owner = hwnd;
    g_menu.tpmFlags = flags;
    g_menu.retcmd = 0;
    /* fSystemMenu FALSE: an app popup, not the system menu (0211 — apps
     * gate their enable/check logic on HIWORD(lParam)==0, the real rule) */
    SendMessage(top, WM_INITMENUPOPUP, (WPARAM)menu, MAKELPARAM(0, FALSE));
    menu_present(top);
    MSG m;
    memset(&m, 0, sizeof m);
    while (g_menu.open && GetMessage(&m, NULL, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (m.message == WM_QUIT) {                  /* raced: re-post for the outer loop */
        PostQuitMessage((int)m.wParam);
        if (g_menu.open) menu_close();
    }
    return (flags & TPM_RETURNCMD) ? (BOOL)g_menu.retcmd : TRUE;
}

/* Keyboard while a popup is open (todos/0091): Up/Down walk the enabled
 * rows of the DEEPEST level, Enter fires the hot one, Right opens a hot
 * cascade / Left closes it (0211), Esc closes the deepest level — and
 * everything else is swallowed, because an open menu is modal for the
 * keyboard (Windows semantics; the mouse routing above already is). */
static void menu_route_key(int key) {
    HWND top = g_menu.top;
    MenuTbl *m = g_menu.sub ? g_menu.sub : g_menu.pop;
    int *hot = g_menu.sub ? &g_menu.subHot : &g_menu.hot;
    if (key == 27) {                                       /* Esc */
        if (g_menu.sub) menu_sub_close(top);
        else menu_close();
        return;
    }
    if (!m || m->n == 0) return;
    if (key == 1073741905 || key == 1073741906) {          /* Down / Up */
        int dir = key == 1073741905 ? 1 : -1;
        int i = *hot;
        for (int k = 0; k < m->n; k++) {
            i = i < 0 ? (dir > 0 ? 0 : m->n - 1) : (i + dir + m->n) % m->n;
            MenuItem *it = &m->items[i];
            if (it->kind != 2 && !(it->state & (MF_GRAYED | MF_DISABLED)))
                break;
        }
        *hot = i;
        menu_present(top);
        return;
    }
    if (key == 1073741903) {                               /* Right: cascade */
        if (!g_menu.sub && g_menu.hot >= 0 &&
            g_menu.pop->items[g_menu.hot].kind == 1) {
            menu_sub_open(top, g_menu.hot);
            menu_route_key(1073741905);                    /* hot first row */
        }
        return;
    }
    if (key == 1073741904) {                               /* Left: back out */
        if (g_menu.sub) menu_sub_close(top);
        return;
    }
    if (key == 13 || key == 1073741912) {                  /* Return / KP */
        if (*hot >= 0) {
            MenuItem *it = &m->items[*hot];
            if (it->kind == 1 && !g_menu.sub)
                menu_sub_open(top, *hot);                  /* Enter opens too */
            else
                menu_fire_in(top, m, *hot);
        } else {
            menu_close();
        }
        return;
    }
}

/* ============================================================ timers
 * (0068). Delivered like WM_PAINT: only when the queue is dry — the
 * GetMessage/PeekMessage scan below. TIMERPROC callbacks are not
 * supported (corpus passes NULL); GetMessage's unified WAIT (0178) uses
 * the next eligible deadline as its park timeout, so expiry is prompt. */

#define MAX_TIMERS 16

static struct {
    HWND hwnd;
    UINT_PTR id;
    UINT interval;
    DWORD next;
    int used;
} g_timers[MAX_TIMERS];

UINT_PTR SetTimer(HWND hwnd, UINT_PTR id, UINT elapse, void *proc) {
    if (proc) return 0;                          /* fail loud: no TIMERPROC */
    if (!hwnd && !id) return 0;
    if (elapse < 10) elapse = 10;
    int slot = -1;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (g_timers[i].used && g_timers[i].hwnd == hwnd && g_timers[i].id == id) { slot = i; break; }
        if (!g_timers[i].used && slot < 0) slot = i;
    }
    if (slot < 0) return 0;
    g_timers[slot].hwnd = hwnd;
    g_timers[slot].id = id;
    g_timers[slot].interval = elapse;
    g_timers[slot].next = (DWORD)SDL_GetTicks() + elapse;
    g_timers[slot].used = 1;
    return id ? id : (UINT_PTR)(slot + 1);
}

BOOL KillTimer(HWND hwnd, UINT_PTR id) {
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (g_timers[i].used && g_timers[i].hwnd == hwnd && g_timers[i].id == id) {
            g_timers[i].used = 0;
            return TRUE;
        }
    }
    return FALSE;
}

static void timer_purge(HWND hwnd) {
    for (int i = 0; i < MAX_TIMERS; i++)
        if (g_timers[i].used && g_timers[i].hwnd == hwnd) g_timers[i].used = 0;
}

/* Milliseconds until the next armed timer is due (0 = due now), or -1 if
 * none — GetMessage's unified-WAIT deadline (todos/0178). MUST apply the
 * same hwnd/range eligibility as timer_scan below: a due-but-filtered
 * timer would otherwise pin the deadline at 0 and spin the park. */
static int timer_next_ms(HWND hf, UINT mn, UINT mx) {
    if (mx && (WM_TIMER < mn || WM_TIMER > mx)) return -1;
    DWORD now = (DWORD)SDL_GetTicks();
    int best = -1;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (!g_timers[i].used) continue;
        if (hf && g_timers[i].hwnd != hf) continue;
        int d = (int)(g_timers[i].next - now);
        if (d < 0) d = 0;
        if (best < 0 || d < best) best = d;
    }
    return best;
}

static int timer_scan(MSG *out, HWND hf, UINT mn, UINT mx) {
    if (mx && (WM_TIMER < mn || WM_TIMER > mx)) return 0;
    DWORD now = (DWORD)SDL_GetTicks();
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (!g_timers[i].used) continue;
        if (hf && g_timers[i].hwnd != hf) continue;
        if ((int)(now - g_timers[i].next) < 0) continue;
        g_timers[i].next = now + g_timers[i].interval;   /* skip missed beats */
        memset(out, 0, sizeof *out);
        out->hwnd = g_timers[i].hwnd;
        out->message = WM_TIMER;
        out->wParam = (WPARAM)g_timers[i].id;
        out->time = now;
        out->pt = g_lastPt;
        return 1;
    }
    return 0;
}

/* ============================================================ hit test */

/* Later-created siblings are on top; STATIC/GROUPBOX are transparent. */
static HWND hit_child_list(HWND first, int x, int y);

static HWND hit_test(HWND h, int x, int y) {     /* x,y in h's client space */
    HWND c = hit_child_list(h->child, x, y);
    return c ? c : h;
}

static int class_transparent(HWND h);

static HWND hit_child_list(HWND first, int x, int y) {
    if (!first) return NULL;
    HWND deeper = hit_child_list(first->next, x, y);   /* later siblings first */
    if (deeper) return deeper;
    if (!first->visible) return NULL;
    if (x < first->x || x >= first->x + first->w ||
        y < first->y || y >= first->y + first->h) return NULL;
    if (class_transparent(first)) return NULL;
    return hit_test(first, x - first->x, y - first->y);
}

/* ============================================================ SDL pump */

static HWND top_by_windowid(Uint32 id) {
    for (int i = 0; i < g_nTops; i++)
        if (g_tops[i] && g_tops[i]->win &&
            SDL_GetWindowID(g_tops[i]->win) == (SDL_WindowID)id) return g_tops[i];
    return NULL;
}

static HWND first_live_top(void) {
    for (int i = 0; i < g_nTops; i++)
        if (g_tops[i] && g_tops[i]->visible) return g_tops[i];
    return NULL;
}

static WPARAM mk_of_state(Uint32 sdlState) {
    WPARAM mk = 0;
    if (sdlState & 1) mk |= MK_LBUTTON;
    if (sdlState & 2) mk |= MK_MBUTTON;
    if (sdlState & 4) mk |= MK_RBUTTON;
    if (g_mod & 0x0003) mk |= MK_SHIFT;
    if (g_mod & 0x00C0) mk |= MK_CONTROL;
    return mk;
}

/* Per-surface cursor on hover (todos/0105): the EDIT client wants the I-beam,
 * every other class the arrow. Only the client area speaks here — the kernel
 * overlays chrome resize cursors on the frame. SetCursor debounces, so the
 * per-move calls only reach the kernel on an actual shape change. */
static void update_cursor(HWND target) {
    /* cursor_token() directly (not LoadCursorW): the veneer builds ANSI
     * (#undef UNICODE), so IDC_* are LPSTR and would mistype LoadCursorW. */
    int ibeam = target && target->cls && hwnd_able(target) &&
                ci_eq(target->cls->name, "EDIT");
    SetCursor(cursor_token(ibeam ? SDL_SYSTEM_CURSOR_TEXT : SDL_SYSTEM_CURSOR_DEFAULT));
}

static void route_mouse(HWND top, UINT downMsg, int btnIdx, float fx, float fy,
                        int clicks, Uint32 state) {
    int x = (int)fx, y = (int)fy;
    if (top->menu || (g_menu.open && g_menu.top == top)) {
        /* the bar owns its strip; an open popup (bar or TrackPopupMenu) is
         * modal for the surface (0068) */
        if (menu_route_mouse(top, downMsg, x, y)) return;
    }
    if (top->menu) {
        y -= MENU_BAR_H;                         /* below: client space */
        if (y < 0) return;
    }
    g_lastPt.x = x;
    g_lastPt.y = y;
    g_activeTop = top;
    HWND target = g_capture ? g_capture : hit_test(top, x, y);
    if (downMsg == WM_MOUSEMOVE && g_tme.hwnd && g_tme.hwnd != target) {
        HWND was = g_tme.hwnd;                   /* left the tracked window: */
        UINT f = g_tme.flags;                    /* fire LEAVE + auto-cancel */
        g_tme.hwnd = NULL;
        if (f & TME_LEAVE) PostMessage(was, WM_MOUSELEAVE, 0, 0);
    }
    if (downMsg == WM_MOUSEMOVE) update_cursor(target);   /* I-beam over EDIT (0105) */
    if (!hwnd_able(target)) return;              /* disabled subtree: drop */
    UINT msg = downMsg;
    if (downMsg == WM_LBUTTONDOWN || downMsg == WM_RBUTTONDOWN ||
        downMsg == WM_MBUTTONDOWN) {
        if (clicks >= 2 && (clicks & 1) == 0 && target->cls &&
            (target->cls->style & CS_DBLCLKS))
            msg = downMsg + 2;                   /* *DBLCLK follows *DOWN + 2 */
    }
    (void)btnIdx;
    int ox, oy;
    hwnd_origin(target, &ox, &oy);
    q_push(target, msg, mk_of_state(state), MAKELPARAM(x - ox, y - oy), 0);
}

static void pump_sdl(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        switch (e.type) {
        case SDL_EVENT_KEY_DOWN:
        case SDL_EVENT_KEY_UP: {
            HWND top = top_by_windowid(e.key.windowID);
            if (!top) top = g_activeTop;
            if (!top) break;
            g_activeTop = top;
            g_mod = (int)e.key.mod;
            if (g_menu.open && e.type == SDL_EVENT_KEY_DOWN) {
                menu_route_key((int)e.key.key);  /* modal: Esc/arrows/Enter,
                                                    the rest swallowed (0091) */
                break;
            }
            HWND target = top->focus ? top->focus : top;
            if (!hwnd_able(target)) break;
            int vk = vk_of((int)e.key.key, (int)e.key.scancode);
            LPARAM lp = 1 | ((e.key.scancode & 0xFF) << 16);
            if (e.type == SDL_EVENT_KEY_UP) lp |= (1 << 30) | (1u << 31);
            else if (e.key.repeat) lp |= (1 << 30);
            q_push(target, e.type == SDL_EVENT_KEY_DOWN ? WM_KEYDOWN : WM_KEYUP,
                   (WPARAM)vk, lp, (int)e.key.key);
            break;
        }
        case SDL_EVENT_MOUSE_MOTION: {
            HWND top = top_by_windowid(e.motion.windowID);
            if (!top) break;
            route_mouse(top, WM_MOUSEMOVE, 0, e.motion.x, e.motion.y, 0,
                        e.motion.state);
            break;
        }
        /* NB (0211 audit, still open): the pointer leaving the SURFACE
         * delivers no SDL event in this world (the kernel routes input
         * per-window and simply goes quiet), so a TME_LEAVE armed window
         * only gets WM_MOUSELEAVE via intra-surface movement — calc's
         * hot button stays lit until re-entry. Needs a kernel leave
         * event; recorded in WIN32.md. */
        case SDL_EVENT_MOUSE_BUTTON_DOWN:
        case SDL_EVENT_MOUSE_BUTTON_UP: {
            HWND top = top_by_windowid(e.button.windowID);
            if (!top) break;
            static const UINT downOf[4] = { 0, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
                                            WM_RBUTTONDOWN };
            int b = e.button.button;
            if (b < 1 || b > 3) break;
            UINT msg = downOf[b] + (e.type == SDL_EVENT_MOUSE_BUTTON_UP ? 1 : 0);
            Uint32 state = e.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                               ? (Uint32)(1u << (b - 1)) : 0;
            route_mouse(top, msg, b, e.button.x, e.button.y,
                        e.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? e.button.clicks : 0,
                        state);
            break;
        }
        case SDL_EVENT_MOUSE_WHEEL: {
            HWND top = top_by_windowid(e.wheel.windowID);
            if (!top) break;
            int x = (int)e.wheel.mouse_x, y = (int)e.wheel.mouse_y;
            if (top->menu) {                     /* bar strip: not the app's */
                y -= MENU_BAR_H;
                if (y < 0) break;
            }
            HWND target = hit_test(top, x, y);
            if (!hwnd_able(target)) break;
            int ox, oy;
            hwnd_origin(target, &ox, &oy);
            q_push(target, WM_MOUSEWHEEL,
                   MAKEWPARAM(mk_of_state(0), (int)(e.wheel.y * WHEEL_DELTA)),
                   MAKELPARAM(x - ox, y - oy), 0);
            break;
        }
        case SDL_EVENT_WINDOW_RESIZED: {
            HWND top = top_by_windowid(e.window.windowID);
            if (!top) break;
            top->w = e.window.data1;
            top->h = e.window.data2;
            if (g_menu.open && g_menu.top == top) menu_close();
            q_push(top, WM_SIZE, SIZE_RESTORED,   /* client size: bar excluded */
                   MAKELPARAM(e.window.data1, e.window.data2 - bar_h(top)), 0);
            InvalidateRect(top, NULL, TRUE);
            break;
        }
        case SDL_EVENT_WINDOW_CLOSE_REQUESTED: {
            /* Per-window close (todos/0089): with several top-levels live
             * the kernel's close request names the window — WM_CLOSE goes
             * to exactly that one (an applet closes, the hub survives). */
            HWND top = top_by_windowid(e.window.windowID);
            if (top) q_push(top, WM_CLOSE, 0, 0, 0);
            break;
        }
        case SDL_EVENT_QUIT: {
            /* Only/last-window close: route WM_CLOSE to the first live
             * top-level (the single-window shape, unchanged since 0058). */
            HWND top = first_live_top();
            if (top) q_push(top, WM_CLOSE, 0, 0, 0);
            break;
        }
        }
    }
}

/* ============================================================ paint scan */

static HWND paint_find(HWND h, HWND hf) {
    if (!h || !h->visible) return NULL;
    if (h->needPaint && (!hf || h == hf)) return h;
    for (HWND c = h->child; c; c = c->next) {
        HWND f = paint_find(c, hf);
        if (f) return f;
    }
    return NULL;
}

static int paint_scan(MSG *out, HWND hf, UINT mn, UINT mx) {
    if (mx && (WM_PAINT < mn || WM_PAINT > mx)) return 0;
    for (int i = 0; i < g_nTops; i++) {
        HWND f = g_tops[i] ? paint_find(g_tops[i], hf) : NULL;
        if (f) {
            memset(out, 0, sizeof *out);
            out->hwnd = f;
            out->message = WM_PAINT;
            out->time = (DWORD)SDL_GetTicks();
            out->pt = g_lastPt;
            return 1;
        }
    }
    return 0;
}

/* ============================================================ clipboard
 * (0048, re-based by 0090): ONE system clipboard held by the KERNEL —
 * SDL_SetClipboardText/SDL_GetClipboardText over the CLIP_SET/CLIP_GET
 * RPCs — so copy/paste crosses processes (term, /bin/clip, every win32
 * app) and the contents survive this process exiting (Win95 semantics).
 * CF_TEXT and CF_UNICODETEXT are two views of the one UTF-8 text; other
 * formats don't exist yet (the kernel slot is format-tagged for 0092's
 * file lists). Handles returned by GetClipboardData are clipboard-owned
 * (Windows semantics): cached here, freed at the next Get/Empty/Set. */

static HGLOBAL g_clipGot;                        /* last GetClipboardData result */

static void clip_drop_cache(void) {
    if (g_clipGot) { GlobalFree(g_clipGot); g_clipGot = NULL; }
}

BOOL OpenClipboard(HWND owner) { (void)owner; return TRUE; }
BOOL CloseClipboard(void) { return TRUE; }

BOOL EmptyClipboard(void) {
    SDL_ClearClipboardData();
    clip_drop_cache();
    return TRUE;
}

/* Store/load the clipboard text — shared by the API surface below and
 * the EDIT control's WM_CUT/COPY/PASTE (0048). */
static int clip_store(const char *bytes, size_t n) {
    char *tmp = (char *)malloc(n + 1);
    if (!tmp) return 0;
    memcpy(tmp, bytes, n);
    tmp[n] = 0;
    int ok = SDL_SetClipboardText(tmp) ? 1 : 0;
    free(tmp);
    clip_drop_cache();
    return ok;
}

static char *clip_load(void) {                   /* malloc'd UTF-8, NULL if none */
    char *t = SDL_GetClipboardText();            /* SDL_free == free here, so */
    if (!t) return NULL;                         /* callers plain-free() it */
    if (!t[0]) { SDL_free(t); return NULL; }     /* "" = empty clipboard */
    return t;
}

HANDLE SetClipboardData(UINT format, HANDLE mem) {
    if (!mem || (format != CF_TEXT && format != CF_UNICODETEXT)) return NULL;
    void *p = GlobalLock((HGLOBAL)mem);
    if (!p) return NULL;
    char *utf8 = format == CF_UNICODETEXT ? w2a_dup((LPCWSTR)p) : NULL;
    const char *bytes = utf8 ? utf8 : (const char *)p;
    int ok = clip_store(bytes, strlen(bytes));
    free(utf8);
    GlobalUnlock((HGLOBAL)mem);
    /* the handle is the clipboard's now (Windows ownership) — the real
     * store is the kernel slot, so the handle itself is simply kept alive
     * for the caller's residual use and never read again */
    return ok ? mem : NULL;
}

HANDLE GetClipboardData(UINT format) {
    if (format != CF_TEXT && format != CF_UNICODETEXT) return NULL;
    char *buf = clip_load();
    if (!buf) return NULL;
    size_t n = strlen(buf);
    clip_drop_cache();
    if (format == CF_TEXT) {
        g_clipGot = GlobalAlloc(0, (SIZE_T)n + 1);
        if (g_clipGot) memcpy(GlobalLock(g_clipGot), buf, (size_t)n + 1);
    } else {
        WCHAR *w = a2w_dup(buf);
        if (w) {
            SIZE_T wb = 0;
            while (w[wb]) wb++;
            g_clipGot = GlobalAlloc(0, (wb + 1) * sizeof(WCHAR));
            if (g_clipGot) memcpy(GlobalLock(g_clipGot), w, (wb + 1) * sizeof(WCHAR));
            free(w);
        }
    }
    free(buf);
    if (g_clipGot) GlobalUnlock(g_clipGot);
    return (HANDLE)g_clipGot;
}

BOOL IsClipboardFormatAvailable(UINT format) {
    if (format != CF_TEXT && format != CF_UNICODETEXT) return FALSE;
    return SDL_HasClipboardText() ? TRUE : FALSE;
}

/* ============================================================ agent tree
 * (wm_agent.h; served from the GetMessage/PeekMessage idle loop) */

static int g_agentFd = -1;
static char g_agentPath[64];

static void agent_cleanup(void) {
    if (g_agentPath[0]) unlink(g_agentPath);
}

static void agent_ensure(void) {
    static int tried;
    if (tried) return;
    tried = 1;
    mkdir(WM_AGENT_DIR, 0777);                   /* EEXIST is fine */
    snprintf(g_agentPath, sizeof g_agentPath, WM_AGENT_SOCK_FMT, (int)getpid());
    unlink(g_agentPath);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strncpy(sa.sun_path, g_agentPath, sizeof sa.sun_path - 1);
    if (bind(fd, (struct sockaddr *)&sa, sizeof sa) != 0 || listen(fd, 4) != 0) {
        close(fd);
        g_agentPath[0] = 0;
        return;
    }
    g_agentFd = fd;
    atexit(agent_cleanup);
}

/* Tree dump: one line per window, two-space indent per depth. Format is
 * test-facing (tests/kernel/test_user32_e2e.js greps it). */
typedef struct { char *buf; int len, cap; } StrBuf;

static void sb_add(StrBuf *sb, const char *s) {
    int n = (int)strlen(s);
    if (sb->len + n + 1 > sb->cap) {
        int nc = sb->cap ? sb->cap * 2 : 1024;
        while (nc < sb->len + n + 1) nc *= 2;
        char *nb = (char *)realloc(sb->buf, (size_t)nc);
        if (!nb) return;
        sb->buf = nb;
        sb->cap = nc;
    }
    memcpy(sb->buf + sb->len, s, (size_t)n + 1);
    sb->len += n;
}

/* Menu lines in the dump (0068): items are agent targets like windows —
 * `wmctl click "New"` posts the WM_COMMAND with no pixels. Labels strip
 * '&' and cut at the accel tab. */
static void menu_label(const MenuItem *it, char *out, int cap) {
    strip_amp(it->text ? it->text : "", out, cap);
    char *tab = strchr(out, '\t');
    if (tab) *tab = 0;
}

static void menu_dump(MenuTbl *m, int depth, StrBuf *sb) {
    char line[256], label[128];
    for (int i = 0; m && i < m->n; i++) {
        const MenuItem *it = &m->items[i];
        if (it->kind == 2) continue;
        menu_label(it, label, sizeof label);
        if (it->kind == 1) {
            snprintf(line, sizeof line, "%*smenu popup text='%s'\n", depth * 2, "", label);
            sb_add(sb, line);
            menu_dump(MENU_T(it->sub), depth + 1, sb);
        } else {
            snprintf(line, sizeof line, "%*smenuitem id=%d text='%s'%s%s\n",
                     depth * 2, "", it->id, label,
                     (it->state & MF_CHECKED) ? " checked" : "",
                     (it->state & (MF_GRAYED | MF_DISABLED)) ? " grayed" : "");
            sb_add(sb, line);
        }
    }
}

static void tree_dump(HWND h, int depth, StrBuf *sb) {
    char line[512], text[160], shown[200];
    int ox, oy;
    hwnd_origin(h, &ox, &oy);
    RECT cr;
    GetClientRect(h, &cr);
    /* Live text (WM_GETTEXT — an edit's content, not its creation text),
     * newline-escaped so the dump stays one line per window. */
    int n = (int)SendMessage(h, WM_GETTEXT, sizeof text, (LPARAM)text);
    int m = 0;
    for (int i = 0; i < n && m < (int)sizeof shown - 3; i++) {
        if (text[i] == '\n') { shown[m++] = '\\'; shown[m++] = 'n'; }
        else shown[m++] = text[i];
    }
    shown[m] = 0;
    snprintf(line, sizeof line,
             "%*swin %d class=%s id=%d rect=%d,%d %dx%d vis=%d en=%d%s text='%s'\n",
             depth * 2, "", h->serial, h->cls ? h->cls->name : "?", h->id,
             ox, oy, is_top(h) ? cr.right : h->w, is_top(h) ? cr.bottom : h->h,
             hwnd_shown(h), hwnd_able(h),
             (h->top->focus == h) ? " focus" : "", shown);
    sb_add(sb, line);
    if (is_top(h) && h->menu) menu_dump(MENU_T(h->menu), depth + 1, sb);
    for (HWND c = h->child; c; c = c->next) tree_dump(c, depth + 1, sb);
}

/* Label resolution (OS.md agent-target pillar): window text with '&'
 * mnemonics stripped, exact match — BUTTONs first, then anything.
 * "CLASS:n" addresses the nth window of that class in tree order. */
static void strip_amp(const char *in, char *out, int cap) {
    int n = 0;
    for (; *in && n < cap - 1; in++)
        if (*in != '&') out[n++] = *in;
    out[n] = 0;
}

typedef struct { const char *label; const char *cls; int idx, count; HWND found; int wantButton; int wantEnabled; } Find;

static void find_walk(HWND h, Find *f) {
    if (f->found) return;
    if (f->cls) {
        if (h->cls && ci_eq(h->cls->name, f->cls)) {
            if (f->count == f->idx) { f->found = h; return; }
            f->count++;
        }
    } else if (hwnd_shown(h) && !(f->wantEnabled && !hwnd_able(h))) {
        /* wantEnabled skips a disabled match (a click no-ops on it anyway),
         * so a modal-over-modal enabled button wins over a same-labelled
         * button in the disabled owner — the AQ_CLICK path sets it. */
        int isBtn = h->cls && ci_eq(h->cls->name, "BUTTON");
        if (!f->wantButton || isBtn) {
            char stripped[256];
            strip_amp(text_get(h), stripped, sizeof stripped);
            if (strcmp(stripped, f->label) == 0) { f->found = h; return; }
        }
    }
    for (HWND c = h->child; c; c = c->next) find_walk(c, f);
}

static HWND agent_find_ex(const char *label, int wantEnabled) {
    Find f;
    memset(&f, 0, sizeof f);
    f.wantEnabled = wantEnabled;
    /* CLASS:n syntax for text-less/content-text controls. */
    const char *colon = strrchr(label, ':');
    char clsName[64];
    if (colon && colon != label && colon[1]) {
        int digits = 1;
        for (const char *p = colon + 1; *p; p++)
            if (*p < '0' || *p > '9') { digits = 0; break; }
        if (digits && (size_t)(colon - label) < sizeof clsName) {
            memcpy(clsName, label, (size_t)(colon - label));
            clsName[colon - label] = 0;
            if (class_find(clsName)) {
                f.cls = clsName;
                f.idx = atoi(colon + 1);
                for (int i = 0; i < g_nTops; i++)
                    if (g_tops[i]) find_walk(g_tops[i], &f);
                return f.found;
            }
        }
    }
    f.label = label;
    f.wantButton = 1;                            /* pass 1: buttons only */
    for (int i = 0; i < g_nTops; i++)
        if (g_tops[i]) find_walk(g_tops[i], &f);
    if (f.found) return f.found;
    f.wantButton = 0;                            /* pass 2: any window */
    for (int i = 0; i < g_nTops; i++)
        if (g_tops[i]) find_walk(g_tops[i], &f);
    return f.found;
}

static HWND agent_find(const char *label) { return agent_find_ex(label, 0); }

static void agent_serve(int cfd) {
    uint32_t type, plen;
    if (aq_next(cfd, &type, &plen) != 0 || plen > 65536) return;
    char *payload = (char *)malloc(plen + 1);
    if (!payload) return;
    if (plen && aq_read_all(cfd, payload, (int)plen) != 0) { free(payload); return; }
    payload[plen] = 0;
    switch (type) {
    case AQ_TREE: {
        StrBuf sb = { NULL, 0, 0 };
        for (int i = 0; i < g_nTops; i++)
            if (g_tops[i]) tree_dump(g_tops[i], 0, &sb);
        if (menu_standalone()) {                 /* TrackPopupMenu items (0048) */
            sb_add(&sb, "popupmenu\n");
            menu_dump(g_menu.pop, 1, &sb);
        }
        aq_send(cfd, AQ_R_TEXT, sb.buf ? sb.buf : "", (uint32_t)sb.len);
        free(sb.buf);
        break;
    }
    case AQ_CLICK: {
        HWND h = agent_find_ex(payload, 1);      /* prefer an ENABLED match */
        if (!h && menu_standalone()) {           /* open TrackPopupMenu (0048) */
            MenuItem *it = menu_find_label(g_menu.pop, payload);
            if (it && it->kind == 0 && !(it->state & (MF_GRAYED | MF_DISABLED))) {
                /* the item may live one cascade down (0211) */
                MenuTbl *m = g_menu.pop;
                int fired = 0;
                for (int row = 0; row < m->n && !fired; row++) {
                    if (&m->items[row] == it) {
                        menu_fire_in(g_menu.top, m, row);
                        fired = 1;
                    } else if (m->items[row].kind == 1 && m->items[row].sub) {
                        MenuTbl *sm = MENU_T(m->items[row].sub);
                        for (int r2 = 0; r2 < sm->n; r2++)
                            if (&sm->items[r2] == it) {
                                menu_fire_in(g_menu.top, sm, r2);
                                fired = 1;
                                break;
                            }
                    }
                }
                aq_send(cfd, AQ_R_OK, NULL, 0);
                goto click_done;
            }
        }
        if (!h) {                                /* menu items are targets too */
            for (int i = 0; i < g_nTops; i++) {
                HWND t = g_tops[i];
                MenuItem *it = t && t->menu ? menu_find_label(MENU_T(t->menu), payload) : NULL;
                if (it && !(it->state & (MF_GRAYED | MF_DISABLED))) {
                    PostMessage(t, WM_COMMAND, MAKEWPARAM(it->id, 0), 0);
                    aq_send(cfd, AQ_R_OK, NULL, 0);
                    goto click_done;
                }
            }
        }
        if (!h || !hwnd_shown(h) || !hwnd_able(h)) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
        if (h->cls && ci_eq(h->cls->name, "BUTTON")) {
            PostMessage(h, BM_CLICK, 0, 0);
        } else {
            LPARAM at = MAKELPARAM(h->w / 2, h->h / 2);
            PostMessage(h, WM_LBUTTONDOWN, MK_LBUTTON, at);
            PostMessage(h, WM_LBUTTONUP, 0, at);
        }
        aq_send(cfd, AQ_R_OK, NULL, 0);
    click_done:
        break;
    }
    case AQ_GETTEXT: {
        HWND h = agent_find(payload);
        if (!h) {
            /* Items of the OPEN menu resolve here too (0171): AQ_CLICK
             * could always press them, but GETTEXT — which backs `wmctl
             * wait label`/`text` — only walked HWNDs, so every wait on a
             * popup item silently ran out its full timeout (a fixed sleep
             * in disguise) and `wait nolabel` on one passed instantly.
             * OPEN only (TrackPopupMenu or a dropped bar submenu) — a
             * CLOSED bar's items must stay unresolvable or `wait label
             * Save` (a dialog button) would match File>Save forever. */
            MenuItem *it = g_menu.open
                ? menu_find_label(g_menu.pop, payload) : NULL;
            if (it && it->text) {
                char stripped[128];
                strip_amp(it->text, stripped, sizeof stripped);
                char *tab = strchr(stripped, '\t');
                if (tab) *tab = 0;
                aq_send(cfd, AQ_R_TEXT, stripped, (uint32_t)strlen(stripped));
                break;
            }
            aq_send(cfd, AQ_R_ERR, NULL, 0);
            break;
        }
        int cap = 65536;
        char *buf = (char *)malloc((size_t)cap);
        if (!buf) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
        int n = (int)SendMessage(h, WM_GETTEXT, (WPARAM)cap, (LPARAM)buf);
        aq_send(cfd, AQ_R_TEXT, buf, (uint32_t)(n < 0 ? 0 : n));
        free(buf);
        break;
    }
    case AQ_SETTEXT: {
        /* payload: label \0 text */
        size_t ll = strlen(payload);
        if (ll + 1 > plen) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
        HWND h = agent_find(payload);
        if (!h) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
        SendMessage(h, WM_SETTEXT, 0, (LPARAM)(payload + ll + 1));
        aq_send(cfd, AQ_R_OK, NULL, 0);
        break;
    }
    default:
        aq_send(cfd, AQ_R_ERR, NULL, 0);
    }
    free(payload);
}

static int agent_poll(void) {
    if (g_agentFd < 0) return 0;
    fd_set rf;
    struct timeval tv = { 0, 0 };
    FD_ZERO(&rf);
    FD_SET(g_agentFd, &rf);
    if (select(g_agentFd + 1, &rf, NULL, NULL, &tv) <= 0) return 0;
    int cfd = accept(g_agentFd, NULL, NULL);
    if (cfd < 0) return 0;
    agent_serve(cfd);                            /* one request per connection */
    close(cfd);
    return 1;
}

/* ============================================================ the loop */

static void sleep_ms(int ms) {                   /* kernel-timed park */
    struct timeval tv = { ms / 1000, (ms % 1000) * 1000 };
    select(0, NULL, NULL, NULL, &tv);
}

BOOL GetMessage(MSG *out, HWND hf, UINT mn, UINT mx) {
    if (!out) return FALSE;
    for (;;) {
        int have_ring = __sdl_pump_wait(0);      /* ring -> SDL event queue */
        pump_sdl();                              /* SDL queue -> message queue */
        agent_poll();
        if (q_get(out, hf, mn, mx, 1))
            return out->message != WM_QUIT ? TRUE : FALSE;
        if (paint_scan(out, hf, mn, mx)) return TRUE;
        if (timer_scan(out, hf, mn, mx)) return TRUE;   /* queue-dry, like paint */
        if (g_quitPosted) {
            memset(out, 0, sizeof *out);
            out->message = WM_QUIT;
            out->wParam = (WPARAM)g_quitCode;
            g_quitPosted = 0;
            return FALSE;
        }
        /* Unified park (todos/0178): ONE kernel WAIT over the agent listen
         * socket ⊕ the input ring ⊕ the next eligible timer deadline —
         * the 25ms chunk poll is gone, an idle app parks until something
         * real happens. Signals complete the park promptly (-1; the
         * handler ran at the import's return). With NO wake source at all
         * (pre-window, no agent socket, no timer) pace coarsely instead
         * of parking forever; -2 = no kernel WAIT in this flavor, keep
         * the old chunked poll. */
        int fds[1];
        int nfd = 0;
        if (g_agentFd >= 0) fds[nfd++] = g_agentFd;
        int t = timer_next_ms(hf, mn, mx);
        if (!have_ring && nfd == 0 && t < 0) t = 50;
        if (__wait(fds, nfd, 1, t) == -2) {
            if (!__sdl_pump_wait(25)) sleep_ms(10);
        }
    }
}

BOOL PeekMessage(MSG *out, HWND hf, UINT mn, UINT mx, UINT remove) {
    if (!out) return FALSE;
    __sdl_pump_wait(0);
    pump_sdl();
    agent_poll();
    if (q_get(out, hf, mn, mx, remove & PM_REMOVE)) return TRUE;
    if (paint_scan(out, hf, mn, mx)) {
        if (!(remove & PM_REMOVE)) return TRUE;
        return TRUE;                             /* WM_PAINT clears at BeginPaint */
    }
    if (timer_scan(out, hf, mn, mx)) return TRUE;
    if (g_quitPosted && (remove & PM_REMOVE)) {
        memset(out, 0, sizeof *out);
        out->message = WM_QUIT;
        out->wParam = (WPARAM)g_quitCode;
        g_quitPosted = 0;
        return TRUE;
    }
    return FALSE;
}

BOOL TranslateMessage(const MSG *m) {
    if (!m || m->message != WM_KEYDOWN) return FALSE;
    int sym = g_lastSym, ch = 0;
    if (g_mod & 0x00C0) {                        /* Ctrl+letter -> control char */
        if (sym >= 'a' && sym <= 'z') ch = sym - 96;
        else if (sym >= 'A' && sym <= 'Z') ch = sym - 64;
    } else if (sym == 13 || sym == 8 || sym == 9 || sym == 27) {
        ch = sym;
    } else if (sym >= 32 && sym <= 126) {
        ch = sym;                                /* SDL3 keysyms are modifier-
                                                    applied: Shift+a == 'A' */
    }
    if (!ch) return FALSE;
    q_push(m->hwnd, WM_CHAR, (WPARAM)ch, m->lParam, 0);
    return TRUE;
}

LRESULT DispatchMessage(const MSG *m) {
    if (!m || !m->hwnd) return 0;
    return SendMessage(m->hwnd, m->message, m->wParam, m->lParam);
}

/* ============================================================ create/destroy */

static void ensure_builtin_classes(void);

/* The one create path (0068 refactor): both charsets funnel here with
 * UTF-8 internals; csName/csClass override the CREATESTRUCT string
 * pointers for W-class windows (same struct layout — only the pointee
 * width differs, and only the app's wndproc reads them). */
static HWND create_window_impl(DWORD exStyle, LPCSTR className, LPCSTR windowName,
                               DWORD style, int x, int y, int w, int h,
                               HWND parent, HMENU menu, HINSTANCE inst, LPVOID param,
                               const void *csName, const void *csClass) {
    ensure_builtin_classes();
    Class *cls = class_find(className);
    if (!cls) {
        WIN32_UNSUPPORTED("window class \"%s\" (not registered/implemented)",
                          className ? className : "?");
        return NULL;
    }
    if ((style & WS_CHILD) && !parent) return NULL;
    if (w == CW_USEDEFAULT) w = 400;
    if (h == CW_USEDEFAULT) h = 300;
    if (x == CW_USEDEFAULT) x = 0;
    if (y == CW_USEDEFAULT) y = 0;
    if (w < 1) w = 1;
    if (h < 1) h = 1;

    HWND hw = (HWND)calloc(1, sizeof(struct __HWND));
    if (!hw) return NULL;
    hw->cls = cls;
    hw->proc = cls->proc;
    hw->isW = cls->isW;
    hw->style = style;
    hw->exStyle = exStyle;
    hw->x = x;
    hw->y = y;
    hw->w = w;
    hw->h = h;
    hw->enabled = !(style & WS_DISABLED);
    hw->serial = ++g_serial;
    text_set(hw, windowName);

    if (style & WS_CHILD) {
        hw->parent = parent;
        hw->top = parent->top;
        hw->id = (int)(UINT_PTR)menu;
        HWND *slot = &parent->child;             /* append: creation order */
        while (*slot) slot = &(*slot)->next;
        *slot = hw;
        hw->visible = (style & WS_VISIBLE) ? 1 : 0;
    } else {
        static int sdlInited;
        if (!sdlInited) { SDL_Init(SDL_INIT_VIDEO); sdlInited = 1; }
        hw->top = hw;
        hw->win = SDL_CreateWindow(windowName ? windowName : "",
                                   w, h, (style & WS_THICKFRAME) ? SDL_WINDOW_RESIZABLE : 0);
        if (!hw->win) { free(hw->text); free(hw); return NULL; }
        int placed = 0;
        for (int i = 0; i < g_nTops; i++)
            if (!g_tops[i]) { g_tops[i] = hw; placed = 1; break; }
        if (!placed && g_nTops < (int)(sizeof g_tops / sizeof g_tops[0]))
            g_tops[g_nTops++] = hw;
        if (!g_activeTop) g_activeTop = hw;
        hw->visible = 1;                         /* a kernel surface is visible */
        /* menus attach BEFORE WM_CREATE — apps call GetMenu there (0068);
         * an explicit hMenu wins over the class menu, Windows-style */
        if (menu) hw->menu = menu;
        else if (cls->menuId) hw->menu = LoadMenuW(NULL, MAKEINTRESOURCEW(cls->menuId));
        agent_ensure();
    }

    CREATESTRUCT cs;
    memset(&cs, 0, sizeof cs);
    cs.lpCreateParams = param;
    cs.hInstance = inst;
    cs.hMenu = menu;
    cs.hwndParent = parent;
    cs.cx = w; cs.cy = h; cs.x = x; cs.y = y;
    cs.style = (LONG)style;
    cs.lpszName = csName ? (LPCSTR)csName : windowName;
    cs.lpszClass = csClass ? (LPCSTR)csClass : className;
    cs.dwExStyle = exStyle;
    if ((int)SendMessage(hw, WM_CREATE, 0, (LPARAM)&cs) == -1) {
        DestroyWindow(hw);
        return NULL;
    }
    SendMessage(hw, WM_SIZE, SIZE_RESTORED,
                MAKELPARAM(w, is_top(hw) ? h - bar_h(hw) : h));
    SendMessage(hw, WM_MOVE, 0, MAKELPARAM(x, y));
    if (hw->visible) InvalidateRect(hw, NULL, TRUE);
    return hw;
}

HWND CreateWindowEx(DWORD exStyle, LPCSTR className, LPCSTR windowName,
                    DWORD style, int x, int y, int w, int h,
                    HWND parent, HMENU menu, HINSTANCE inst, LPVOID param) {
    return create_window_impl(exStyle, className, windowName, style, x, y, w, h,
                              parent, menu, inst, param, NULL, NULL);
}

HWND CreateWindowExW(DWORD exStyle, LPCWSTR className, LPCWSTR windowName,
                     DWORD style, int x, int y, int w, int h,
                     HWND parent, HMENU menu, HINSTANCE inst, LPVOID param) {
    char *cls8 = is_intres(className) ? NULL : w2a_dup(className);
    char *name8 = windowName ? w2a_dup(windowName) : NULL;
    HWND hw = create_window_impl(exStyle, cls8, name8, style, x, y, w, h,
                                 parent, menu, inst, param,
                                 windowName, className);
    free(cls8);
    free(name8);
    return hw;
}

static void unlink_child(HWND h) {
    if (!h->parent) return;
    HWND *slot = &h->parent->child;
    while (*slot && *slot != h) slot = &(*slot)->next;
    if (*slot) *slot = h->next;
}

BOOL DestroyWindow(HWND h) {
    if (!h || h->inDestroy) return FALSE;
    h->inDestroy = 1;
    /* WM_DESTROY parent-first, then children (Windows order). */
    CallWindowProc(h->proc, h, WM_DESTROY, 0, 0);
    while (h->child) {
        HWND c = h->child;
        h->child = c->next;
        c->parent = NULL;                        /* already unlinked */
        c->inDestroy = 0;                        /* recurse cleanly */
        DestroyWindow(c);
    }
    q_purge(h);
    timer_purge(h);
    if (g_menu.top == h) { g_menu.open = 0; g_menu.top = NULL; g_menu.pop = NULL; }
    if (g_menu.owner == h) g_menu.owner = NULL;
    if (g_tme.hwnd == h) g_tme.hwnd = NULL;
    if (is_top(h) && h->menu) { DestroyMenu(h->menu); h->menu = NULL; }
    if (g_capture == h) g_capture = NULL;
    if (h->top && h->top->focus == h) h->top->focus = NULL;
    if (g_activeTop == h) g_activeTop = NULL;
    unlink_child(h);
    if (is_top(h) && h->win) {
        for (int i = 0; i < g_nTops; i++)
            if (g_tops[i] == h) g_tops[i] = NULL;
        SDL_DestroyWindow(h->win);
    } else if (h->parent) {
        InvalidateRect(h->parent, NULL, TRUE);   /* child area gone stale */
    }
    free(h->ctl);
    free(h->text);
    free(h);
    if (!g_activeTop) g_activeTop = first_live_top();
    return TRUE;
}

LRESULT DefWindowProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (!h) return 0;
    /* Fail-loud (0211): a control-contract message (EM_/BM_/LB_/CB_/SBM_
     * ranges) that falls all the way through to DefWindowProc is an
     * UNIMPLEMENTED control feature, not a benign unknown — a silent 0
     * reads as fake success (e.g. LB_ERR never surfacing). Report once
     * per message number, keep returning 0. */
    if ((msg >= 0x00B0 && msg <= 0x00EF) ||      /* EM_* / SBM_* */
        (msg >= 0x0140 && msg <= 0x0165) ||      /* CB_* */
        (msg >= 0x0180 && msg <= 0x01B0) ||      /* LB_* */
        (msg >= 0x00F0 && msg <= 0x00FF)) {      /* BM_* */
        static unsigned reported[32];
        static int nRep;
        int seen = 0;
        for (int i = 0; i < nRep; i++)
            if (reported[i] == msg) { seen = 1; break; }
        if (!seen) {
            if (nRep < 32) reported[nRep++] = msg;
            __win32_unsupported("control message 0x%04X on class %s",
                                msg, h->cls ? h->cls->name : "?");
        }
    }
    switch (msg) {
    case WM_CLOSE:
        DestroyWindow(h);
        return 0;
    case WM_RBUTTONUP: {
        /* Windows synthesizes WM_CONTEXTMENU here; coords are the top-
         * level's SURFACE space (the TrackPopupMenu convention above). */
        int ox, oy;
        hwnd_origin(h, &ox, &oy);
        SendMessage(h, WM_CONTEXTMENU, (WPARAM)h,
                    MAKELPARAM(GET_X_LPARAM(lp) + ox,
                               GET_Y_LPARAM(lp) + oy + bar_h(h->top)));
        return 0;
    }
    case WM_CONTEXTMENU:
        if (h->parent)                           /* bubble, Windows-style */
            return SendMessage(h->parent, WM_CONTEXTMENU, wp, lp);
        return 0;
    case WM_ERASEBKGND: {
        HBRUSH b = h->cls ? resolve_brush(h->cls->bg) : NULL;
        if (!b) return 0;
        HDC dc = (HDC)wp;
        RECT r;
        GetClipBox(dc, &r);
        FillRect(dc, &r, b);
        return 1;
    }
    case WM_PAINT: {                             /* validate, at minimum */
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (dc) EndPaint(h, &ps);
        return 0;
    }
    case WM_SETTEXT:
        text_set(h, (const char *)lp);
        if (is_top(h) && h->win) SDL_SetWindowTitle(h->win, text_get(h));
        return TRUE;
    case WM_GETTEXT: {
        char *out = (char *)lp;
        int cap = (int)wp;
        if (!out || cap < 1) return 0;
        const char *t = text_get(h);
        int n = (int)strlen(t);
        if (n > cap - 1) n = cap - 1;
        memcpy(out, t, (size_t)n);
        out[n] = 0;
        return n;
    }
    case WM_GETTEXTLENGTH:
        return (LRESULT)strlen(text_get(h));
    }
    return 0;
}

/* DefWindowProc for W-class windows: text messages carry UTF-16 (the
 * window IS W — callers were translated toward it by send_msg), internal
 * storage stays UTF-8. Everything else is charset-free. */
LRESULT DefWindowProcW(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (!h) return 0;
    if (msg == WM_SETTEXT && lp) {
        char *a = w2a_dup((LPCWSTR)lp);
        LRESULT r = DefWindowProc(h, msg, wp, (LPARAM)a);
        free(a);
        return r;
    }
    if (msg == WM_GETTEXT && lp && (int)wp > 0)
        return a2w_trunc(text_get(h), (LPWSTR)lp, (int)wp);
    if (msg == WM_GETTEXTLENGTH) {
        int wn = MultiByteToWideChar(CP_UTF8, 0, text_get(h), -1, NULL, 0);
        return wn > 0 ? wn - 1 : 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ============================================================ show/paint */

BOOL ShowWindow(HWND h, int cmd) {
    if (!h) return FALSE;
    BOOL was = h->visible;
    if (cmd == SW_MINIMIZE || cmd == SW_SHOWMINIMIZED ||
        cmd == SW_SHOWMAXIMIZED)
        WIN32_UNSUPPORTED("ShowWindow(SW_%d) minimize/maximize (the WM owns "
                          "window state; shown normal)", cmd);
    if (cmd == SW_HIDE) {
        if (is_top(h)) return was;               /* no kernel surface hide */
        h->visible = 0;
        SendMessage(h, WM_SHOWWINDOW, FALSE, 0);
        if (h->parent) InvalidateRect(h->parent, NULL, TRUE);
    } else {
        h->visible = 1;
        SendMessage(h, WM_SHOWWINDOW, TRUE, 0);
        InvalidateRect(h, NULL, TRUE);
    }
    return was;
}

BOOL UpdateWindow(HWND h) {
    if (!h) return FALSE;
    if (h->needPaint && hwnd_shown(h)) SendMessage(h, WM_PAINT, 0, 0);
    for (HWND c = h ? h->child : NULL; c; c = c->next) UpdateWindow(c);
    return TRUE;
}

static void invalidate_tree(HWND h) {
    h->needPaint = 1;
    for (HWND c = h->child; c; c = c->next) invalidate_tree(c);
}

BOOL InvalidateRect(HWND h, const RECT *r, BOOL erase) {
    (void)r; (void)erase;                        /* whole-window granularity */
    if (!h) {                                    /* NULL: everything */
        for (int i = 0; i < g_nTops; i++)
            if (g_tops[i]) invalidate_tree(g_tops[i]);
        return TRUE;
    }
    invalidate_tree(h);
    return TRUE;
}

BOOL MoveWindow(HWND h, int x, int y, int w, int h2, BOOL repaint) {
    if (!h) return FALSE;
    if (is_top(h)) {
        /* Top-level: POSITION stays the WM's (x,y echo back via WM_MOVE so
         * saved-geometry round-trips), SIZE is the app's — an owner-
         * initiated kernel resize (0068, SDL_SetWindowSize -> SURFACE_
         * RESIZE). The new size lands asynchronously as the usual RESIZED
         * event -> WM_SIZE; same-size calls are a no-op kernel-side. */
        if (w < 1) w = 1;
        if (h2 < 1) h2 = 1;
        SDL_SetWindowSize(h->win, w, h2);
        SendMessage(h, WM_MOVE, 0, MAKELPARAM(x, y));
        (void)repaint;
        return TRUE;
    }
    h->x = x;
    h->y = y;
    if (w < 1) w = 1;
    if (h2 < 1) h2 = 1;
    int resized = (w != h->w || h2 != h->h);
    h->w = w;
    h->h = h2;
    if (resized) SendMessage(h, WM_SIZE, SIZE_RESTORED, MAKELPARAM(w, h2));
    SendMessage(h, WM_MOVE, 0, MAKELPARAM(x, y));
    if (repaint && h->parent) InvalidateRect(h->parent, NULL, TRUE);
    return TRUE;
}

BOOL IsWindowVisible(HWND h) { return h ? hwnd_shown(h) : FALSE; }

BOOL EnableWindow(HWND h, BOOL enable) {
    if (!h) return FALSE;
    BOOL wasDisabled = !h->enabled;
    if (h->enabled != (enable ? 1 : 0)) {
        h->enabled = enable ? 1 : 0;
        SendMessage(h, WM_ENABLE, (WPARAM)enable, 0);
        InvalidateRect(h, NULL, TRUE);
    }
    return wasDisabled;
}

BOOL IsWindowEnabled(HWND h) { return h ? hwnd_able(h) : FALSE; }

/* ============================================================ focus/capture */

HWND SetFocus(HWND h) {
    if (!h) {                                    /* clear focus (0211) */
        HWND top = g_activeTop ? g_activeTop : first_live_top();
        HWND old = top ? top->focus : NULL;
        if (old) {
            SendMessage(old, WM_KILLFOCUS, 0, 0);
            top->focus = NULL;
        }
        return old;
    }
    HWND top = h->top;
    HWND old = top->focus;
    if (old == h) return old;
    if (old) SendMessage(old, WM_KILLFOCUS, (WPARAM)h, 0);
    top->focus = h;
    SendMessage(h, WM_SETFOCUS, (WPARAM)old, 0);
    return old;
}

HWND GetFocus(void) {
    HWND top = g_activeTop ? g_activeTop : first_live_top();
    return top ? (top->focus ? top->focus : top) : NULL;
}

HWND SetCapture(HWND h) {
    HWND old = g_capture;
    g_capture = h;
    return old;
}

BOOL ReleaseCapture(void) {
    g_capture = NULL;
    return TRUE;
}

HWND GetCapture(void) { return g_capture; }

/* ============================================================ tree queries */

HWND GetParent(HWND h) { return h ? h->parent : NULL; }

HWND GetDlgItem(HWND parent, int id) {
    if (!parent) return NULL;
    for (HWND c = parent->child; c; c = c->next)
        if (c->id == id) return c;
    return NULL;
}

int GetDlgCtrlID(HWND h) { return h ? h->id : 0; }

/* Dialog navigation (0104): the controls in creation (Z) order, depth
 * first — GetNextDlgTabItem walks WS_TABSTOP members, GetNextDlgGroupItem
 * the WS_GROUP-bounded run around a control (radio arrows). */
static int dlg_collect(HWND h, HWND *arr, int cap, int n) {
    for (HWND c = h->child; c && n < cap; c = c->next) {
        arr[n++] = c;
        n = dlg_collect(c, arr, cap, n);
    }
    return n;
}

HWND GetNextDlgTabItem(HWND dlg, HWND ctl, BOOL prev) {
    if (!dlg) return NULL;
    HWND arr[128];
    int n = dlg_collect(dlg, arr, 128, 0);
    if (!n) return NULL;
    int idx = -1;
    for (int i = 0; i < n; i++) if (arr[i] == ctl) { idx = i; break; }
    for (int step = 1; step <= n; step++) {
        int i = idx < 0 ? (prev ? n - step : step - 1)
                        : ((idx + (prev ? -step : step)) % n + n) % n;
        HWND c = arr[i];
        if ((c->style & WS_TABSTOP) && hwnd_shown(c) && hwnd_able(c)) return c;
    }
    return NULL;
}

HWND GetNextDlgGroupItem(HWND dlg, HWND ctl, BOOL prev) {
    if (!dlg || !ctl) return ctl;
    HWND arr[128];
    int n = dlg_collect(dlg, arr, 128, 0);
    int idx = -1;
    for (int i = 0; i < n; i++) if (arr[i] == ctl) { idx = i; break; }
    if (idx < 0) return ctl;
    int lo = idx;                                /* group is [lo, hi) */
    while (lo > 0 && !(arr[lo]->style & WS_GROUP)) lo--;
    int hi = idx + 1;
    while (hi < n && !(arr[hi]->style & WS_GROUP)) hi++;
    int span = hi - lo;
    for (int step = 1; step <= span; step++) {
        int rel = (((idx - lo) + (prev ? -step : step)) % span + span) % span;
        HWND c = arr[lo + rel];
        if (hwnd_shown(c) && hwnd_able(c)) return c;
    }
    return ctl;
}

static BOOL enum_walk(HWND h, WNDENUMPROC fn, LPARAM lp) {
    for (HWND c = h->child; c; c = c->next) {
        if (!fn(c, lp)) return FALSE;
        if (!enum_walk(c, fn, lp)) return FALSE;
    }
    return TRUE;
}

BOOL EnumChildWindows(HWND parent, WNDENUMPROC fn, LPARAM lp) {
    if (!parent || !fn) return FALSE;
    return enum_walk(parent, fn, lp);
}

int GetWindowText(HWND h, LPSTR buf, int max) {
    if (!h || !buf || max < 1) return 0;
    return (int)SendMessage(h, WM_GETTEXT, (WPARAM)max, (LPARAM)buf);
}

BOOL SetWindowText(HWND h, LPCSTR text) {
    if (!h) return FALSE;
    SendMessage(h, WM_SETTEXT, 0, (LPARAM)text);
    return TRUE;
}

int GetWindowTextLength(HWND h) {
    return h ? (int)SendMessage(h, WM_GETTEXTLENGTH, 0, 0) : 0;
}

LONG_PTR GetWindowLongPtr(HWND h, int index) {
    if (!h) return 0;
    switch (index) {
    case GWLP_WNDPROC: return (LONG_PTR)h->proc;
    case GWL_STYLE: return (LONG_PTR)h->style;
    case GWL_EXSTYLE: return (LONG_PTR)h->exStyle;
    case GWLP_ID: return h->id;
    case GWLP_USERDATA: return h->userdata;
    }
    return 0;
}

LONG_PTR SetWindowLongPtr(HWND h, int index, LONG_PTR value) {
    if (!h) return 0;
    LONG_PTR old = GetWindowLongPtr(h, index);
    switch (index) {
    case GWLP_WNDPROC: h->proc = (WNDPROC)value; break;
    case GWL_STYLE: h->style = (DWORD)value; break;
    case GWL_EXSTYLE: h->exStyle = (DWORD)value; break;
    case GWLP_ID: h->id = (int)value; break;
    case GWLP_USERDATA: h->userdata = value; break;
    default: return 0;
    }
    return old;
}

/* ============================================================ controls
 * The Win95 look: raised/sunken 3D edges over the BTNFACE palette. All
 * controls draw fully in WM_PAINT (class bg NULL — no separate erase). */

static void draw_raised(HDC dc, RECT r, int sunken) {
    COLORREF tl1 = sunken ? GetSysColor(COLOR_BTNSHADOW) : GetSysColor(COLOR_BTNHIGHLIGHT);
    COLORREF tl2 = sunken ? GetSysColor(COLOR_3DDKSHADOW) : GetSysColor(COLOR_BTNFACE);
    COLORREF br1 = sunken ? GetSysColor(COLOR_BTNHIGHLIGHT) : GetSysColor(COLOR_3DDKSHADOW);
    COLORREF br2 = sunken ? GetSysColor(COLOR_BTNFACE) : GetSysColor(COLOR_BTNSHADOW);
    HPEN p;
    HGDIOBJ old;
    p = CreatePen(PS_SOLID, 1, tl1);
    old = SelectObject(dc, (HGDIOBJ)p);
    MoveToEx(dc, r.left, r.bottom - 1, NULL);
    LineTo(dc, r.left, r.top);
    LineTo(dc, r.right - 1, r.top);
    SelectObject(dc, old);
    DeleteObject((HGDIOBJ)p);
    p = CreatePen(PS_SOLID, 1, br1);
    old = SelectObject(dc, (HGDIOBJ)p);
    MoveToEx(dc, r.right - 1, r.top, NULL);
    LineTo(dc, r.right - 1, r.bottom - 1);
    LineTo(dc, r.left - 1, r.bottom - 1);
    SelectObject(dc, old);
    DeleteObject((HGDIOBJ)p);
    p = CreatePen(PS_SOLID, 1, tl2);
    old = SelectObject(dc, (HGDIOBJ)p);
    MoveToEx(dc, r.left + 1, r.bottom - 2, NULL);
    LineTo(dc, r.left + 1, r.top + 1);
    LineTo(dc, r.right - 2, r.top + 1);
    SelectObject(dc, old);
    DeleteObject((HGDIOBJ)p);
    p = CreatePen(PS_SOLID, 1, br2);
    old = SelectObject(dc, (HGDIOBJ)p);
    MoveToEx(dc, r.right - 2, r.top + 1, NULL);
    LineTo(dc, r.right - 2, r.bottom - 2);
    LineTo(dc, r.left, r.bottom - 2);
    SelectObject(dc, old);
    DeleteObject((HGDIOBJ)p);
}

/* Sunken client edge (edit/listbox). */
static void draw_well(HDC dc, RECT r) {
    RECT inner = r;
    draw_raised(dc, r, 1);
    InflateRect(&inner, -2, -2);
    FillRect(dc, &inner, GetSysColorBrush(COLOR_WINDOW));
}

/* Mnemonics (0104): strip_amp drops every '&' but keeps the following
 * char, so a single "&X" marks X. mnemonic_index returns X's index in the
 * STRIPPED string (matching strip_amp's output), mnemonic_char its
 * uppercased letter; both -1/0 when the label has no live mnemonic
 * ("&&" is a literal '&' and carries none). */
static int mnemonic_index(const char *raw) {
    int si = 0;
    for (const char *p = raw; p && *p; p++) {
        if (*p == '&') {
            if (p[1] && p[1] != '&') return si;   /* the kept char sits at si */
            if (p[1] == '&') p++;                 /* "&&": skip the pair, no mn */
            continue;                             /* '&' itself is dropped */
        }
        si++;
    }
    return -1;
}

static char mnemonic_char(const char *raw) {
    int idx = mnemonic_index(raw);
    if (idx < 0) return 0;
    char c = 0, si = 0;                           /* the char AT the stripped idx */
    for (const char *p = raw; *p; p++) {
        if (*p == '&') { if (p[1] == '&') p++; continue; }
        if (si == idx) { c = *p; break; }
        si++;
    }
    if (c >= 'a' && c <= 'z') c -= 32;
    return c;
}

/* Draw stripped label at (x,y), underlining the mnemonic glyph — the
 * classic Windows dialog affordance. */
static void draw_label_mn(HDC dc, int x, int y, const char *raw, const char *stripped) {
    TextOut(dc, x, y, stripped, (int)strlen(stripped));
    int idx = mnemonic_index(raw);
    if (idx < 0 || idx >= (int)strlen(stripped)) return;
    SIZE pre, ch;
    GetTextExtentPoint32(dc, stripped, idx, &pre);
    GetTextExtentPoint32(dc, stripped + idx, 1, &ch);
    HPEN pen = CreatePen(PS_SOLID, 1, GetTextColor(dc));
    HGDIOBJ op = SelectObject(dc, (HGDIOBJ)pen);
    int uy = y + ch.cy - 1;
    MoveToEx(dc, x + pre.cx, uy, NULL);
    LineTo(dc, x + pre.cx + ch.cx, uy);
    SelectObject(dc, op);
    DeleteObject((HGDIOBJ)pen);
}

/* ---- BUTTON ---- */

typedef struct { int pressed, check; } BtnState;

static int btn_kind(HWND h) { return (int)(h->style & 0xF); }

static int btn_is_check(int k) {
    return k == BS_CHECKBOX || k == BS_AUTOCHECKBOX ||
           k == BS_RADIOBUTTON || k == BS_AUTORADIOBUTTON;
}

static void btn_paint(HWND h) {
    BtnState *st = (BtnState *)h->ctl;
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    if (!dc) return;
    RECT r;
    SetRect(&r, 0, 0, h->w, h->h);
    char label[256];
    strip_amp(text_get(h), label, sizeof label);
    int kind = btn_kind(h);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, GetSysColor(hwnd_able(h) ? COLOR_BTNTEXT : COLOR_GRAYTEXT));
    if (kind == BS_GROUPBOX) {
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        RECT fr = r;
        fr.top += 6;
        FrameRect(dc, &fr, GetSysColorBrush(COLOR_BTNSHADOW));
        draw_label_mn(dc, 10, 0, text_get(h), label);
    } else if (btn_is_check(kind)) {
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        int radio = kind == BS_RADIOBUTTON || kind == BS_AUTORADIOBUTTON;
        int by = (h->h - 13) / 2;
        RECT box;
        SetRect(&box, 0, by, 13, by + 13);
        if (radio) {
            HGDIOBJ ob = SelectObject(dc, (HGDIOBJ)GetStockObject(WHITE_BRUSH));
            Ellipse(dc, box.left, box.top, box.right, box.bottom);
            SelectObject(dc, ob);
            if (st->check) {
                HBRUSH mark = CreateSolidBrush(GetSysColor(COLOR_BTNTEXT));
                HGDIOBJ om = SelectObject(dc, (HGDIOBJ)mark);
                Ellipse(dc, box.left + 4, box.top + 4, box.right - 4, box.bottom - 4);
                SelectObject(dc, om);
                DeleteObject((HGDIOBJ)mark);
            }
        } else {
            draw_well(dc, box);
            if (st->check) {                     /* the check mark */
                HPEN p = CreatePen(PS_SOLID, 1, GetSysColor(COLOR_BTNTEXT));
                HGDIOBJ op = SelectObject(dc, (HGDIOBJ)p);
                for (int i = 0; i < 2; i++) {
                    MoveToEx(dc, 3, by + 6 + i, NULL);
                    LineTo(dc, 5, by + 8 + i);
                    LineTo(dc, 10, by + 3 + i);
                }
                SelectObject(dc, op);
                DeleteObject((HGDIOBJ)p);
            }
        }
        draw_label_mn(dc, 18, (h->h - 14) / 2, text_get(h), label);
    } else {                                     /* push button */
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        RECT face = r;
        if (kind == BS_DEFPUSHBUTTON) {          /* default: black outline (0104) */
            FrameRect(dc, &r, GetSysColorBrush(COLOR_WINDOWFRAME));
            InflateRect(&face, -1, -1);
        }
        draw_raised(dc, face, st->pressed);
        SIZE sz;
        GetTextExtentPoint32(dc, label, (int)strlen(label), &sz);
        int tx = (h->w - sz.cx) / 2 + (st->pressed ? 1 : 0);
        int ty = (h->h - sz.cy) / 2 + (st->pressed ? 1 : 0);
        draw_label_mn(dc, tx, ty, text_get(h), label);
        if (h->top->focus == h) {                /* focus rect (solid, no dots) */
            RECT fr = r;
            InflateRect(&fr, -4, -4);
            FrameRect(dc, &fr, GetSysColorBrush(COLOR_BTNTEXT));
        }
    }
    EndPaint(h, &ps);
}

static void btn_fire(HWND h) {
    BtnState *st = (BtnState *)h->ctl;
    int kind = btn_kind(h);
    if (kind == BS_AUTOCHECKBOX) {
        st->check = !st->check;
        InvalidateRect(h, NULL, TRUE);
    } else if (kind == BS_AUTORADIOBUTTON) {
        if (h->parent) {
            /* the radio GROUP is bounded by WS_GROUP markers (0211): walk
             * back to the group start, uncheck forward until the next one */
            HWND start = h->parent->child;
            for (HWND c = h->parent->child; c; c = c->next) {
                if (c->style & WS_GROUP) start = c;
                if (c == h) break;
            }
            for (HWND c = start; c; c = c->next) {
                if (c != start && (c->style & WS_GROUP)) break;
                if (c != h && c->cls == h->cls && btn_kind(c) == BS_AUTORADIOBUTTON &&
                    c->ctl && ((BtnState *)c->ctl)->check) {
                    ((BtnState *)c->ctl)->check = 0;
                    InvalidateRect(c, NULL, TRUE);
                }
            }
        }
        st->check = 1;
        InvalidateRect(h, NULL, TRUE);
    }
    if (h->parent)
        SendMessage(h->parent, WM_COMMAND, MAKEWPARAM(h->id, BN_CLICKED), (LPARAM)h);
}

/* BS_OWNERDRAW (0048, calc's keypad): the parent paints via WM_DRAWITEM —
 * the DRAWITEMSTRUCT's hDC is the button's client DC. */
static void btn_paint_ownerdraw(HWND h) {
    BtnState *st = (BtnState *)h->ctl;
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    if (!dc) return;
    if (h->parent) {
        DRAWITEMSTRUCT dis;
        memset(&dis, 0, sizeof dis);
        dis.CtlType = ODT_BUTTON;
        dis.CtlID = (UINT)h->id;
        dis.itemAction = ODA_DRAWENTIRE;
        dis.itemState = (st->pressed ? ODS_SELECTED : 0)
                      | (hwnd_able(h) ? 0 : ODS_DISABLED)
                      | (h->top->focus == h ? ODS_FOCUS : 0);
        dis.hwndItem = h;
        dis.hDC = dc;
        SetRect(&dis.rcItem, 0, 0, h->w, h->h);
        SendMessage(h->parent, WM_DRAWITEM, (WPARAM)h->id, (LPARAM)&dis);
    } else {
        RECT r;
        SetRect(&r, 0, 0, h->w, h->h);
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
    }
    EndPaint(h, &ps);
}

static LRESULT btn_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    BtnState *st = (BtnState *)h->ctl;
    switch (msg) {
    case WM_CREATE:
        h->ctl = calloc(1, sizeof(BtnState));
        return h->ctl ? 0 : -1;
    case WM_PAINT:
        if (btn_kind(h) == BS_OWNERDRAW) btn_paint_ownerdraw(h);
        else btn_paint(h);
        return 0;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        SetFocus(h);
        SetCapture(h);
        st->pressed = 1;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_MOUSEMOVE:
        if (GetCapture() == h) {
            POINT p = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
            RECT r;
            SetRect(&r, 0, 0, h->w, h->h);
            int in = PtInRect(&r, p);
            if (in != st->pressed) {
                st->pressed = in;
                InvalidateRect(h, NULL, TRUE);
            }
        }
        return 0;
    case WM_LBUTTONUP:
        if (GetCapture() == h) {
            ReleaseCapture();
            int fire = st->pressed;
            st->pressed = 0;
            InvalidateRect(h, NULL, TRUE);
            if (fire) btn_fire(h);
        }
        return 0;
    case WM_KEYDOWN:
        if (wp == VK_SPACE) {
            st->pressed = 1;
            InvalidateRect(h, NULL, TRUE);
        }
        return 0;
    case WM_KEYUP:
        if (wp == VK_SPACE && st->pressed) {
            st->pressed = 0;
            InvalidateRect(h, NULL, TRUE);
            btn_fire(h);
        }
        return 0;
    case BM_CLICK:
        SendMessage(h, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(h->w / 2, h->h / 2));
        SendMessage(h, WM_LBUTTONUP, 0, MAKELPARAM(h->w / 2, h->h / 2));
        return 0;
    case BM_GETCHECK:
        return st->check ? BST_CHECKED : BST_UNCHECKED;
    case BM_SETCHECK:
        st->check = wp ? 1 : 0;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case BM_GETSTATE: {                          /* 0211 */
        BtnState *bst = (BtnState *)h->ctl;
        LRESULT r = 0;
        if (bst && bst->check) r |= 1;           /* BST_CHECKED */
        if (bst && bst->pressed) r |= 0x0004;    /* BST_PUSHED */
        if (h->top->focus == h) r |= 0x0008;     /* BST_FOCUS */
        return r;
    }
    case BM_SETSTATE:
        st->pressed = wp ? 1 : 0;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_SETTEXT: {
        LRESULT r = DefWindowProc(h, msg, wp, lp);
        InvalidateRect(h, NULL, TRUE);
        return r;
    }
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_GETDLGCODE: {                         /* dialog nav (0104) */
        int k = btn_kind(h);
        if (k == BS_DEFPUSHBUTTON) return DLGC_BUTTON | DLGC_DEFPUSHBUTTON;
        if (k == BS_RADIOBUTTON || k == BS_AUTORADIOBUTTON)
            return DLGC_BUTTON | DLGC_RADIOBUTTON;
        if (k == BS_GROUPBOX) return DLGC_STATIC;
        if (btn_is_check(k)) return DLGC_BUTTON;
        return DLGC_BUTTON | DLGC_UNDEFPUSHBUTTON;
    }
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- STATIC ---- */

static LRESULT static_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        RECT r;
        SetRect(&r, 0, 0, h->w, h->h);
        /* the parent picks the background, Windows-style (calc paints its
         * display white this way); no answer -> BTNFACE */
        HBRUSH bg = h->parent
            ? (HBRUSH)SendMessage(h->parent, WM_CTLCOLORSTATIC, (WPARAM)dc, (LPARAM)h)
            : NULL;
        FillRect(dc, &r, bg ? bg : GetSysColorBrush(COLOR_BTNFACE));
        if (h->style & SS_SUNKEN) draw_raised(dc, r, 1);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, GetSysColor(hwnd_able(h) ? COLOR_WINDOWTEXT : COLOR_GRAYTEXT));
        UINT fmt = DT_LEFT;
        if ((h->style & 0x3) == SS_CENTER) fmt = DT_CENTER;
        else if ((h->style & 0x3) == SS_RIGHT) fmt = DT_RIGHT;
        /* Single-line labels vcenter in the control (0236): Win95
         * arithmetic sizes labels shorter than the stock glyph cell, so
         * top-aligned text clips descenders at the bottom edge. Multiline
         * text keeps the top-aligned multi-line DrawText path unchanged
         * (DT_SINGLELINE would collapse its '\n's). */
        const char *txt = text_get(h);
        int oneline = !strchr(txt, '\n');
        /* mnemonic (0104): left-aligned labels underline the '&' char —
         * strip_amp + draw_label_mn; other alignments keep raw DrawText */
        if (fmt == DT_LEFT && mnemonic_index(txt) >= 0) {
            char label[256];
            strip_amp(txt, label, sizeof label);
            int ty = r.top;
            if (oneline) {                       /* centered cell top (0236):
                 * floored like DrawText's DT_VCENTER — a cell taller than
                 * the control loses its blank leading row at the top, not
                 * the descender row (the child DC clips both edges). */
                TEXTMETRIC tm;
                if (GetTextMetrics(dc, &tm))
                    ty = r.top + ((h->h - tm.tmHeight) >> 1);
            }
            draw_label_mn(dc, r.left, ty, txt, label);
        } else {
            if (oneline) fmt |= DT_SINGLELINE | DT_VCENTER;
            DrawText(dc, txt, -1, &r, fmt);
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_SETTEXT: {
        LRESULT r = DefWindowProc(h, msg, wp, lp);
        InvalidateRect(h, NULL, TRUE);
        return r;
    }
    case WM_GETDLGCODE:                          /* dialog nav (0104) */
        return DLGC_STATIC;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- EDIT (single-line + ES_MULTILINE) ----
 * Text is a flat buffer; lines split on '\n'. Selection is [anchor, caret)
 * (order-normalized); the caret is solid (no SetTimer, no blink). */

typedef struct {
    char *buf;
    int len, cap;
    int caret, anchor;          /* byte indexes; anchor == caret: no selection */
    int topLine;                /* first visible line (multiline) */
    int scrollX;                /* horizontal pixel scroll (single-line) */
    int sbDrag, sbDragOff;      /* built-in vscroll thumb drag (0210) */
    int wheelAcc;               /* fractional WM_MOUSEWHEEL carry (0210) */
    int modified;               /* EM_GETMODIFY/EM_SETMODIFY (0048) */
    HLOCAL hlocal;              /* EM_GETHANDLE/EM_SETHANDLE (0048): the
                                   external WCHAR buffer notepad manages —
                                   see edit_sync_handle */
} EditState;

#define EDIT_PAD 3
#define EDIT_SB_W 16            /* built-in scrollbar thickness (0210/0211) */
#define EDIT_HSTEP 8            /* hscroll arrow step, ~one char cell (0211) */

static int edit_ml(HWND h) { return (h->style & ES_MULTILINE) != 0; }
static int edit_ro(HWND h) { return (h->style & ES_READONLY) != 0; }
static int edit_sb(HWND h) {
    return edit_ml(h) && (h->style & WS_VSCROLL) != 0;
}
static int edit_hsb(HWND h) {                    /* built-in hscroll (0211) */
    return edit_ml(h) && (h->style & WS_HSCROLL) != 0;
}

static void sb_tri(HDC dc, int cx, int cy, int dir);   /* scrollbar section */

/* gucOS is POSIX — the EDIT buffer is pure LF (todos/0210). Every text-in
 * path normalizes CRLF and lone CR to '\n': the text path has no 0x0D glyph
 * (a stray \r rendered "?"), and WM_GETTEXT/EM_GETHANDLE hand the buffer
 * back out, so the win32 layer never re-imposes CRLF on the filesystem.
 * dst may alias s (in-place shrink: o never passes i). */
static int edit_normalize(char *dst, const char *s, int n) {
    int o = 0;
    for (int i = 0; i < n; i++) {
        if (s[i] == '\r') {
            if (i + 1 < n && s[i + 1] == '\n') continue;
            dst[o++] = '\n';
        } else {
            dst[o++] = s[i];
        }
    }
    return o;
}

static int edit_ensure(EditState *st, int need) {
    if (st->cap >= need) return 1;
    int nc = st->cap ? st->cap * 2 : 64;
    while (nc < need) nc *= 2;
    char *nb = (char *)realloc(st->buf, (size_t)nc);
    if (!nb) return 0;
    st->buf = nb;
    st->cap = nc;
    return 1;
}

static void edit_line_of(EditState *st, int pos, int *lineOut, int *colOut) {
    int line = 0, start = 0;
    for (int i = 0; i < pos && i < st->len; i++)
        if (st->buf[i] == '\n') { line++; start = i + 1; }
    *lineOut = line;
    *colOut = pos - start;
}

static int edit_line_start(EditState *st, int line) {
    int cur = 0, i = 0;
    while (cur < line && i < st->len) {
        if (st->buf[i] == '\n') cur++;
        i++;
    }
    return i;
}

static int edit_line_end(EditState *st, int start) {
    int i = start;
    while (i < st->len && st->buf[i] != '\n') i++;
    return i;
}

static int edit_line_count(EditState *st) {
    int n = 1;
    for (int i = 0; i < st->len; i++)
        if (st->buf[i] == '\n') n++;
    return n;
}

static int edit_line_h(HWND h) {
    HDC dc = GetDC(h);
    TEXTMETRIC tm;
    int lh = 16;
    if (dc) {
        if (GetTextMetrics(dc, &tm)) lh = tm.tmHeight;
        __gdi_dc_unwrap(dc);                    /* measuring only: no present */
    }
    return lh;
}

static int edit_rows(HWND h, int lh) {          /* visible whole rows */
    int avail = h->h - 2 * EDIT_PAD - 4 - (edit_hsb(h) ? EDIT_SB_W : 0);
    int rows = avail / (lh > 0 ? lh : 1);
    return rows < 1 ? 1 : rows;
}

static void edit_notify(HWND h, int code);

static int edit_view_w(HWND h) {                /* text viewport width */
    int w = h->w - 2 * EDIT_PAD - 4 - (edit_sb(h) ? EDIT_SB_W : 0);
    return w > 1 ? w : 1;
}

/* Widest line in pixels (multiline hscroll extent). O(len) measure per
 * call — fine at the sizes the in-OS apps edit. */
static int edit_content_w(HWND h, EditState *st) {
    HDC dc = GetDC(h);
    if (!dc) return 0;
    int maxW = 0, i = 0;
    while (i <= st->len) {
        int end = edit_line_end(st, i);
        SIZE sz;
        if (end > i && GetTextExtentPoint32(dc, st->buf + i, end - i, &sz) &&
            sz.cx > maxW)
            maxW = sz.cx;
        if (end >= st->len) break;
        i = end + 1;
    }
    __gdi_dc_unwrap(dc);
    return maxW;
}

static int edit_max_sx(HWND h, EditState *st) {
    int m = edit_content_w(h, st) + 2 - edit_view_w(h);
    return m > 0 ? m : 0;
}

/* Scroll horizontally without moving the caret (0211). EN_HSCROLL fires
 * on a real change — scrollbar/wheel scrolling, per the Win32 contract
 * (caret-follow goes through edit_show_caret and stays silent). */
static void edit_hscroll(HWND h, EditState *st, int x) {
    int m = edit_max_sx(h, st);
    if (x < 0) x = 0;
    if (x > m) x = m;
    if (x == st->scrollX) return;
    st->scrollX = x;
    InvalidateRect(h, NULL, TRUE);
    edit_notify(h, EN_HSCROLL);
}

static int edit_max_top(HWND h, EditState *st) {
    int m = edit_line_count(st) - edit_rows(h, edit_line_h(h));
    return m > 0 ? m : 0;
}

/* Scroll without moving the caret (wheel/scrollbar semantics). EN_VSCROLL
 * fires on a real change, per the Win32 contract (0211). */
static void edit_vscroll(HWND h, EditState *st, int top) {
    int m = edit_max_top(h, st);
    if (top < 0) top = 0;
    if (top > m) top = m;
    if (top == st->topLine) return;
    st->topLine = top;
    InvalidateRect(h, NULL, TRUE);
    edit_notify(h, EN_VSCROLL);
}

/* The built-in WS_VSCROLL bar (0210): [up arrow][channel with proportional
 * thumb][down arrow], inside the 2px well on the right edge. */
static void edit_sb_geom(HWND h, EditState *st, RECT *bar,
                         int *btn, int *thumbY, int *thumbH) {
    SetRect(bar, h->w - 2 - EDIT_SB_W, 2, h->w - 2,
            h->h - 2 - (edit_hsb(h) ? EDIT_SB_W : 0));
    int len = bar->bottom - bar->top;
    int b = EDIT_SB_W;
    if (b * 2 > len) b = len / 2;
    *btn = b;
    int chan = len - 2 * b;
    int n = edit_line_count(st), rows = edit_rows(h, edit_line_h(h));
    int maxTop = n - rows;
    if (maxTop < 0) maxTop = 0;
    int th = maxTop > 0 ? chan * rows / n : chan;   /* proportional */
    if (th < 8) th = 8;
    if (th > chan) th = chan;
    *thumbH = th;
    *thumbY = bar->top + b +
        (maxTop > 0 ? (chan - th) * st->topLine / maxTop : 0);
}

/* The built-in WS_HSCROLL bar (0211): the 0210 vbar mirrored horizontal,
 * along the bottom edge, stopping short of the vbar when both exist. */
static void edit_hsb_geom(HWND h, EditState *st, RECT *bar,
                          int *btn, int *thumbX, int *thumbW) {
    SetRect(bar, 2, h->h - 2 - EDIT_SB_W,
            h->w - 2 - (edit_sb(h) ? EDIT_SB_W : 0), h->h - 2);
    int len = bar->right - bar->left;
    int b = EDIT_SB_W;
    if (b * 2 > len) b = len / 2;
    *btn = b;
    int chan = len - 2 * b;
    int cw = edit_content_w(h, st) + 2, vw = edit_view_w(h);
    int maxSx = cw - vw;
    if (maxSx < 0) maxSx = 0;
    int tw = maxSx > 0 ? chan * vw / cw : chan;  /* proportional */
    if (tw < 8) tw = 8;
    if (tw > chan) tw = chan;
    *thumbW = tw;
    *thumbX = bar->left + b +
        (maxSx > 0 ? (chan - tw) * st->scrollX / maxSx : 0);
}

static int edit_x_of(HWND h, EditState *st, HDC dc, int lineStart, int pos) {
    SIZE sz;
    if (pos <= lineStart) return 0;
    GetTextExtentPoint32(dc, st->buf + lineStart, pos - lineStart, &sz);
    return sz.cx;
}

static void edit_notify(HWND h, int code) {
    if (h->parent)
        SendMessage(h->parent, WM_COMMAND, MAKEWPARAM(h->id, code), (LPARAM)h);
}

static void edit_sel(EditState *st, int *s, int *e) {
    *s = st->anchor < st->caret ? st->anchor : st->caret;
    *e = st->anchor < st->caret ? st->caret : st->anchor;
}

static void edit_del_sel(EditState *st) {
    int s, e;
    edit_sel(st, &s, &e);
    if (s == e) return;
    memmove(st->buf + s, st->buf + e, (size_t)(st->len - e));
    st->len -= e - s;
    st->caret = st->anchor = s;
}

static void edit_insert(HWND h, EditState *st, const char *s, int n) {
    edit_del_sel(st);
    if (!edit_ensure(st, st->len + n + 1)) return;
    memmove(st->buf + st->caret + n, st->buf + st->caret,
            (size_t)(st->len - st->caret));
    int m = edit_normalize(st->buf + st->caret, s, n);
    if (m < n)                                   /* close the CR shrinkage gap */
        memmove(st->buf + st->caret + m, st->buf + st->caret + n,
                (size_t)(st->len - st->caret));
    st->len += m;
    st->caret += m;
    st->anchor = st->caret;
    (void)h;
}

/* Keep the caret in view: topLine vertically (multiline), scrollX
 * horizontally (single-line always; multiline under ES_AUTOHSCROLL /
 * WS_HSCROLL — the notepad no-wrap styles, 0211). Silent scrolls: the
 * EN_*SCROLL notifications are for user scrollbar/wheel action only. */
static void edit_show_caret(HWND h, EditState *st) {
    int lh = edit_line_h(h);
    int lineStart = 0;
    if (edit_ml(h)) {
        int line, col;
        edit_line_of(st, st->caret, &line, &col);
        int rows = edit_rows(h, lh);
        if (line < st->topLine) st->topLine = line;
        if (line >= st->topLine + rows) st->topLine = line - rows + 1;
        if (!edit_hsb(h) && !(h->style & ES_AUTOHSCROLL)) return;
        lineStart = edit_line_start(st, line);
    }
    HDC dc = GetDC(h);
    if (!dc) return;
    int cx = edit_x_of(h, st, dc, lineStart, st->caret);
    __gdi_dc_unwrap(dc);
    int vw = edit_view_w(h);
    if (cx - st->scrollX > vw - 2) st->scrollX = cx - vw + 2;
    if (cx - st->scrollX < 0) st->scrollX = cx;
    if (st->scrollX < 0) st->scrollX = 0;
}

static void edit_paint(HWND h) {
    EditState *st = (EditState *)h->ctl;
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    if (!dc) return;
    RECT r;
    SetRect(&r, 0, 0, h->w, h->h);
    draw_well(dc, r);
    if (edit_ro(h) || !hwnd_able(h)) {
        RECT inner = r;
        InflateRect(&inner, -2, -2);
        FillRect(dc, &inner, GetSysColorBrush(COLOR_BTNFACE));
    }
    if (edit_sb(h)) {                            /* built-in vscroll (0210) */
        RECT bar, a1, a2, th;
        int btn, ty, thh;
        edit_sb_geom(h, st, &bar, &btn, &ty, &thh);
        FillRect(dc, &bar, GetSysColorBrush(COLOR_SCROLLBAR));
        SetRect(&a1, bar.left, bar.top, bar.right, bar.top + btn);
        SetRect(&a2, bar.left, bar.bottom - btn, bar.right, bar.bottom);
        FillRect(dc, &a1, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a1, 0);
        FillRect(dc, &a2, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a2, 0);
        sb_tri(dc, (a1.left + a1.right) / 2, (a1.top + a1.bottom) / 2, 0);
        sb_tri(dc, (a2.left + a2.right) / 2, (a2.top + a2.bottom) / 2, 1);
        SetRect(&th, bar.left, ty, bar.right, ty + thh);
        FillRect(dc, &th, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, th, 0);
    }
    if (edit_hsb(h)) {                           /* built-in hscroll (0211) */
        RECT bar, a1, a2, th;
        int btn, tx, thw;
        edit_hsb_geom(h, st, &bar, &btn, &tx, &thw);
        FillRect(dc, &bar, GetSysColorBrush(COLOR_SCROLLBAR));
        SetRect(&a1, bar.left, bar.top, bar.left + btn, bar.bottom);
        SetRect(&a2, bar.right - btn, bar.top, bar.right, bar.bottom);
        FillRect(dc, &a1, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a1, 0);
        FillRect(dc, &a2, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a2, 0);
        sb_tri(dc, (a1.left + a1.right) / 2, (a1.top + a1.bottom) / 2, 2);
        sb_tri(dc, (a2.left + a2.right) / 2, (a2.top + a2.bottom) / 2, 3);
        SetRect(&th, tx, bar.top, tx + thw, bar.bottom);
        FillRect(dc, &th, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, th, 0);
        if (edit_sb(h)) {                        /* dead corner square */
            RECT cnr;
            SetRect(&cnr, h->w - 2 - EDIT_SB_W, h->h - 2 - EDIT_SB_W,
                    h->w - 2, h->h - 2);
            FillRect(dc, &cnr, GetSysColorBrush(COLOR_BTNFACE));
        }
    }
    IntersectClipRect(dc, 2, 2, h->w - 2 - (edit_sb(h) ? EDIT_SB_W : 0),
                      h->h - 2 - (edit_hsb(h) ? EDIT_SB_W : 0));
    SetBkMode(dc, TRANSPARENT);
    TEXTMETRIC tm;
    GetTextMetrics(dc, &tm);
    int lh = tm.tmHeight;
    int s, e;
    edit_sel(st, &s, &e);
    int focused = h->top->focus == h;
    int line = 0, i = 0, y = EDIT_PAD - (edit_ml(h) ? st->topLine * lh : 0);
    while (i <= st->len) {
        int end = edit_line_end(st, i);
        if (y + lh > 2 && y < h->h - 2) {
            int x = EDIT_PAD - st->scrollX;      /* hscroll: all flavors (0211) */
            /* selection band on this line */
            if (focused && e > s && s < end + 1 && e > i) {
                int ss = s > i ? s : i, se = e < end ? e : end;
                if (se > ss || (s <= end && e > end)) {
                    int x0 = x + edit_x_of(h, st, dc, i, ss);
                    int x1 = x + edit_x_of(h, st, dc, i, se);
                    if (e > end && se == end) x1 += 4;   /* newline included */
                    RECT sr;
                    SetRect(&sr, x0, y, x1, y + lh);
                    FillRect(dc, &sr, GetSysColorBrush(COLOR_HIGHLIGHT));
                }
            }
            SetTextColor(dc, GetSysColor(hwnd_able(h) ? COLOR_WINDOWTEXT : COLOR_GRAYTEXT));
            TextOut(dc, x, y, st->buf + i, end - i);
            /* selection text repaint in highlight color */
            if (focused && e > s) {
                int ss = s > i ? s : i, se = e < end ? e : end;
                if (se > ss) {
                    SetTextColor(dc, GetSysColor(COLOR_HIGHLIGHTTEXT));
                    TextOut(dc, x + edit_x_of(h, st, dc, i, ss), y,
                            st->buf + ss, se - ss);
                }
            }
            /* solid caret */
            if (focused && s == e && st->caret >= i && st->caret <= end) {
                int cx = x + edit_x_of(h, st, dc, i, st->caret);
                RECT cr;
                SetRect(&cr, cx, y, cx + 1, y + lh);
                FillRect(dc, &cr, GetSysColorBrush(COLOR_WINDOWTEXT));
            }
        }
        if (end >= st->len) break;
        i = end + 1;
        line++;
        y += lh;
        if (!edit_ml(h)) break;
    }
    EndPaint(h, &ps);
}

/* EM_GETHANDLE (0048): the classic edit exposes its buffer as an HLOCAL
 * of WCHARs (ReactOS notepad reads files into one and EM_SETHANDLEs it,
 * saves via EM_GETHANDLE + LocalLock). Internal storage stays UTF-8;
 * this materializes/refreshes the external view on demand. Capacity is
 * (utf8len+1) WCHARs — >= the UTF-16 need, and covers callers that size
 * writes by GetWindowTextLength (UTF-8 units here); the tail is zeroed.
 * Ownership: EM_SETHANDLE adopts (the APP frees the one it replaced,
 * notepad-style); WM_DESTROY frees whatever is attached. */
static HLOCAL edit_sync_handle(EditState *st) {
    SIZE_T cap = ((SIZE_T)st->len + 1) * sizeof(WCHAR);
    HLOCAL h = st->hlocal ? st->hlocal : LocalAlloc(LMEM_MOVEABLE, cap);
    if (!h) return NULL;
    if (st->hlocal && GlobalSize((HGLOBAL)h) < cap) {
        LocalFree(h);
        h = LocalAlloc(LMEM_MOVEABLE, cap);
        if (!h) { st->hlocal = NULL; return NULL; }
    }
    st->hlocal = h;
    WCHAR *w = (WCHAR *)LocalLock(h);
    memset(w, 0, GlobalSize((HGLOBAL)h));
    a2w_trunc(st->buf ? st->buf : "", w, (int)(GlobalSize((HGLOBAL)h) / sizeof(WCHAR)));
    LocalUnlock(h);
    return h;
}

static void edit_adopt_handle(HWND h, EditState *st, HLOCAL hl) {
    st->hlocal = hl;
    char *a = hl ? w2a_dup((LPCWSTR)LocalLock(hl)) : NULL;
    if (hl) LocalUnlock(hl);
    int n = a ? (int)strlen(a) : 0;
    if (edit_ensure(st, n + 1))
        st->len = n ? edit_normalize(st->buf, a, n) : 0;
    free(a);
    st->caret = st->anchor = 0;
    st->topLine = st->scrollX = 0;
    st->modified = 0;                            /* EM_SETHANDLE resets it */
    edit_show_caret(h, st);
    InvalidateRect(h, NULL, TRUE);
}

/* WM_CUT/COPY/PASTE (0048): straight onto the system clipboard (0090). */
static void edit_copy_sel(EditState *st) {
    int s, e;
    edit_sel(st, &s, &e);
    if (e > s) clip_store(st->buf + s, (size_t)(e - s));
}

static void edit_paste(HWND h, EditState *st) {
    char *t = clip_load();
    if (!t) return;
    if (!edit_ml(h))                             /* single line: first line only */
        t[strcspn(t, "\r\n")] = 0;
    edit_insert(h, st, t, (int)strlen(t));
    free(t);
    st->modified = 1;
    edit_show_caret(h, st);
    InvalidateRect(h, NULL, TRUE);
    edit_notify(h, EN_CHANGE);
}

static int edit_hit(HWND h, EditState *st, int px, int py) {
    HDC dc = GetDC(h);
    if (!dc) return st->caret;
    TEXTMETRIC tm;
    GetTextMetrics(dc, &tm);
    int lh = tm.tmHeight > 0 ? tm.tmHeight : 16;
    int line = edit_ml(h) ? st->topLine + (py - EDIT_PAD) / lh : 0;
    if (line < 0) line = 0;
    int nl = edit_line_count(st);
    if (line >= nl) line = nl - 1;
    int start = edit_line_start(st, line);
    int end = edit_line_end(st, start);
    int x = EDIT_PAD - st->scrollX;
    int pos = start;
    while (pos < end) {                          /* step code points (0211) */
        int np = __u8_fwd(st->buf, end, pos);
        int nx = x + edit_x_of(h, st, dc, start, np);
        int cx = x + edit_x_of(h, st, dc, start, pos);
        if (px < (cx + nx) / 2) break;
        pos = np;
    }
    __gdi_dc_unwrap(dc);
    return pos;
}

static LRESULT edit_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    EditState *st = (EditState *)h->ctl;
    switch (msg) {
    case WM_CREATE: {
        st = (EditState *)calloc(1, sizeof(EditState));
        if (!st) return -1;
        h->ctl = st;
        const char *t = text_get(h);
        int n = (int)strlen(t);
        if (n && edit_ensure(st, n + 1))
            st->len = edit_normalize(st->buf, t, n);
        return 0;
    }
    case WM_PAINT:
        edit_paint(h);
        return 0;
    case WM_LBUTTONDOWN: {
        int px = GET_X_LPARAM(lp), py = GET_Y_LPARAM(lp);
        SetFocus(h);
        if (edit_sb(h)) {                        /* built-in vscroll (0210) */
            RECT bar;
            int btn, ty, th;
            edit_sb_geom(h, st, &bar, &btn, &ty, &th);
            if (px >= bar.left && py < bar.bottom) {
                int rows = edit_rows(h, edit_line_h(h));
                if (py < bar.top + btn)
                    edit_vscroll(h, st, st->topLine - 1);
                else if (py >= bar.bottom - btn)
                    edit_vscroll(h, st, st->topLine + 1);
                else if (py >= ty && py < ty + th) {
                    st->sbDrag = 1;
                    st->sbDragOff = py - ty;
                    SetCapture(h);
                } else if (py < ty)              /* channel: page */
                    edit_vscroll(h, st, st->topLine - rows);
                else
                    edit_vscroll(h, st, st->topLine + rows);
                return 0;
            }
            if (px >= bar.left) return 0;        /* dead corner square */
        }
        if (edit_hsb(h)) {                       /* built-in hscroll (0211) */
            RECT bar;
            int btn, tx, tw;
            edit_hsb_geom(h, st, &bar, &btn, &tx, &tw);
            if (py >= bar.top) {
                int vw = edit_view_w(h);
                if (px < bar.left + btn)
                    edit_hscroll(h, st, st->scrollX - EDIT_HSTEP);
                else if (px >= bar.right - btn)
                    edit_hscroll(h, st, st->scrollX + EDIT_HSTEP);
                else if (px >= tx && px < tx + tw) {
                    st->sbDrag = 2;
                    st->sbDragOff = px - tx;
                    SetCapture(h);
                } else if (px < tx)              /* channel: page */
                    edit_hscroll(h, st, st->scrollX - vw);
                else
                    edit_hscroll(h, st, st->scrollX + vw);
                return 0;
            }
        }
        SetCapture(h);
        int pos = edit_hit(h, st, px, py);
        st->caret = pos;
        if (!(GetKeyState(VK_SHIFT) & 0x8000)) st->anchor = pos;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case WM_MOUSEMOVE:
        if (st->sbDrag == 1 && GetCapture() == h) {   /* vthumb drag (0210) */
            RECT bar;
            int btn, ty, th;
            edit_sb_geom(h, st, &bar, &btn, &ty, &th);
            int travel = (bar.bottom - bar.top) - 2 * btn - th;
            int m = edit_max_top(h, st);
            if (travel > 0 && m > 0) {
                int ny = GET_Y_LPARAM(lp) - st->sbDragOff - (bar.top + btn);
                edit_vscroll(h, st, (ny * m + travel / 2) / travel);
            }
            return 0;
        }
        if (st->sbDrag == 2 && GetCapture() == h) {   /* hthumb drag (0211) */
            RECT bar;
            int btn, tx, tw;
            edit_hsb_geom(h, st, &bar, &btn, &tx, &tw);
            int travel = (bar.right - bar.left) - 2 * btn - tw;
            int m = edit_max_sx(h, st);
            if (travel > 0 && m > 0) {
                int nx = GET_X_LPARAM(lp) - st->sbDragOff - (bar.left + btn);
                edit_hscroll(h, st, (nx * m + travel / 2) / travel);
            }
            return 0;
        }
        if (GetCapture() == h && (wp & MK_LBUTTON)) {
            st->caret = edit_hit(h, st, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
            edit_show_caret(h, st);
            InvalidateRect(h, NULL, TRUE);
        }
        return 0;
    case WM_LBUTTONUP:
        st->sbDrag = 0;
        if (GetCapture() == h) ReleaseCapture();
        return 0;
    case WM_MOUSEWHEEL: {                        /* 3 lines per notch (0210);
                                                    deltas accumulate so
                                                    sub-notch trackpad events
                                                    still add up */
        if (!edit_ml(h)) return 0;
        st->wheelAcc += GET_WHEEL_DELTA_WPARAM(wp);
        int lines = st->wheelAcc / (WHEEL_DELTA / 3);
        if (lines) {
            st->wheelAcc -= lines * (WHEEL_DELTA / 3);
            edit_vscroll(h, st, st->topLine - lines);
        }
        return 0;
    }
    case WM_VSCROLL: {                           /* the classic EDIT contract */
        if (!edit_ml(h)) return 0;
        int rows = edit_rows(h, edit_line_h(h));
        switch (LOWORD(wp)) {
        case SB_LINEUP:   edit_vscroll(h, st, st->topLine - 1); break;
        case SB_LINEDOWN: edit_vscroll(h, st, st->topLine + 1); break;
        case SB_PAGEUP:   edit_vscroll(h, st, st->topLine - rows); break;
        case SB_PAGEDOWN: edit_vscroll(h, st, st->topLine + rows); break;
        case SB_TOP:      edit_vscroll(h, st, 0); break;
        case SB_BOTTOM:   edit_vscroll(h, st, edit_max_top(h, st)); break;
        case SB_THUMBTRACK: case SB_THUMBPOSITION:
            edit_vscroll(h, st, HIWORD(wp)); break;
        }
        return 0;
    }
    case WM_HSCROLL: {                           /* mirror contract (0211) */
        if (!edit_ml(h)) return 0;
        int vw = edit_view_w(h);
        switch (LOWORD(wp)) {
        case SB_LINELEFT:  edit_hscroll(h, st, st->scrollX - EDIT_HSTEP); break;
        case SB_LINERIGHT: edit_hscroll(h, st, st->scrollX + EDIT_HSTEP); break;
        case SB_PAGELEFT:  edit_hscroll(h, st, st->scrollX - vw); break;
        case SB_PAGERIGHT: edit_hscroll(h, st, st->scrollX + vw); break;
        case SB_LEFT:      edit_hscroll(h, st, 0); break;
        case SB_RIGHT:     edit_hscroll(h, st, edit_max_sx(h, st)); break;
        case SB_THUMBTRACK: case SB_THUMBPOSITION:
            edit_hscroll(h, st, HIWORD(wp)); break;
        }
        return 0;
    }
    case WM_GETDLGCODE: {                         /* dialog nav (0104) */
        int code = DLGC_WANTCHARS | DLGC_HASSETSEL | DLGC_WANTARROWS;
        if (edit_ml(h) && wp == VK_RETURN) code |= DLGC_WANTALLKEYS;
        return code;
    }
    case WM_CHAR: {
        int ch = (int)wp;
        /* the classic clipboard chords work even in accelerator-less
         * dialogs (0048); ^A selects all */
        if (ch == 3) { SendMessage(h, WM_COPY, 0, 0); return 0; }
        if (ch == 24) { SendMessage(h, WM_CUT, 0, 0); return 0; }
        if (ch == 22) { SendMessage(h, WM_PASTE, 0, 0); return 0; }
        if (ch == 1) { SendMessage(h, EM_SETSEL, 0, -1); return 0; }
        if (edit_ro(h)) return 0;
        if (ch == 8) {                           /* backspace: whole cp (0211) */
            int s, e;
            edit_sel(st, &s, &e);
            if (s == e && st->caret > 0)
                st->anchor = __u8_prev(st->buf, st->caret);
            edit_del_sel(st);
        } else if (ch == '\r' || ch == '\n') {
            if (!edit_ml(h)) return 0;
            edit_insert(h, st, "\n", 1);
        } else if (ch == 9 && edit_ml(h)) {
            edit_insert(h, st, "\t", 1);
        } else if (ch >= 32 && ch != 127 && ch < 0x110000 &&
                   !(ch >= 0xD800 && ch <= 0xDFFF)) {
            /* Any code point, UTF-8-encoded (0211). WM_CHAR carries UTF-16
             * units on the W side; a stray surrogate half is dropped. */
            char u[4];
            int n;
            unsigned cp = (unsigned)ch;
            if (cp < 0x80) { u[0] = (char)cp; n = 1; }
            else if (cp < 0x800) {
                u[0] = (char)(0xC0 | (cp >> 6));
                u[1] = (char)(0x80 | (cp & 0x3F));
                n = 2;
            } else if (cp < 0x10000) {
                u[0] = (char)(0xE0 | (cp >> 12));
                u[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
                u[2] = (char)(0x80 | (cp & 0x3F));
                n = 3;
            } else {
                u[0] = (char)(0xF0 | (cp >> 18));
                u[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
                u[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
                u[3] = (char)(0x80 | (cp & 0x3F));
                n = 4;
            }
            edit_insert(h, st, u, n);
        } else {
            return 0;
        }
        st->modified = 1;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        edit_notify(h, EN_CHANGE);
        return 0;
    }
    case WM_KEYDOWN: {
        int extend = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
        int oldCaret = st->caret;
        switch (wp) {
        case VK_LEFT:                            /* step code points (0211) */
            st->caret = __u8_prev(st->buf, st->caret);
            break;
        case VK_RIGHT:
            st->caret = __u8_fwd(st->buf, st->len, st->caret);
            break;
        case VK_HOME: {
            int l, c;
            edit_line_of(st, st->caret, &l, &c);
            st->caret = edit_line_start(st, l);
            break;
        }
        case VK_END: {
            int l, c;
            edit_line_of(st, st->caret, &l, &c);
            st->caret = edit_line_end(st, edit_line_start(st, l));
            break;
        }
        case VK_UP:
        case VK_DOWN: {
            if (!edit_ml(h)) return 0;
            int l, c;
            edit_line_of(st, st->caret, &l, &c);
            int nl = edit_line_count(st);
            int tl = wp == VK_UP ? l - 1 : l + 1;
            if (tl < 0 || tl >= nl) break;
            int start = edit_line_start(st, tl);
            int end = edit_line_end(st, start);
            st->caret = start + c > end ? end : start + c;
            st->caret = __u8_snap(st->buf, st->caret);   /* boundary (0211) */
            break;
        }
        case VK_DELETE: {
            if (edit_ro(h)) return 0;
            int s, e;
            edit_sel(st, &s, &e);
            if (s == e && st->caret < st->len)
                st->anchor = __u8_fwd(st->buf, st->len, st->caret);
            edit_del_sel(st);
            st->modified = 1;
            edit_show_caret(h, st);
            InvalidateRect(h, NULL, TRUE);
            edit_notify(h, EN_CHANGE);
            return 0;
        }
        default:
            return 0;
        }
        if (!extend) st->anchor = st->caret;
        (void)oldCaret;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case EM_GETSEL: {
        int s, e;
        edit_sel(st, &s, &e);
        if (wp) *(LPDWORD)wp = (DWORD)s;
        if (lp) *(LPDWORD)lp = (DWORD)e;
        return MAKELONG(s, e);
    }
    case EM_SETSEL: {
        int s = (int)wp, e = (int)lp;
        if (e < 0) e = st->len;
        if (s < 0) { s = 0; e = 0; }             /* -1 start: deselect */
        if (s > st->len) s = st->len;
        if (e > st->len) e = st->len;
        st->anchor = s;
        st->caret = e;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case EM_GETLINECOUNT:
        return edit_line_count(st);
    case EM_GETFIRSTVISIBLELINE:
        return st->topLine;
    case EM_LINEFROMCHAR: {                      /* (0048) wp = pos, -1 = caret */
        int pos = (int)wp == -1 ? st->caret : (int)wp;
        if (pos > st->len) pos = st->len;
        int l, c;
        edit_line_of(st, pos, &l, &c);
        return l;
    }
    case EM_LINEINDEX: {                         /* (0048) wp = line, -1 = caret's */
        int line;
        if ((int)wp == -1) {
            int c;
            edit_line_of(st, st->caret, &line, &c);
        } else {
            line = (int)wp;
        }
        if (line < 0 || line >= edit_line_count(st)) return -1;
        return edit_line_start(st, line);
    }
    case EM_SCROLLCARET:
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case EM_REPLACESEL: {                        /* (0048) lp = text; wp = undoable
                                                    (no undo here — ignored) */
        const char *t = lp ? (const char *)lp : "";
        edit_insert(h, st, t, (int)strlen(t));
        st->modified = 1;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        edit_notify(h, EN_CHANGE);
        return 0;
    }
    case EM_GETMODIFY:
        return st->modified;
    case EM_SETMODIFY:
        st->modified = wp ? 1 : 0;
        return 0;
    case EM_LIMITTEXT:                           /* unlimited already */
        return 0;
    case EM_CANUNDO:                             /* no undo buffer (0048 scope) */
        return FALSE;
    case EM_UNDO:
        /* apps normally gate on EM_CANUNDO (menu grayed); an accelerator
         * (^Z) still lands here — say so instead of a dead keypress */
        WIN32_UNSUPPORTED("EDIT EM_UNDO: no undo buffer (todos/0135)");
        return FALSE;
    case EM_EMPTYUNDOBUFFER:
        return 0;
    case EM_GETHANDLE:
        return (LRESULT)edit_sync_handle(st);
    case EM_SETHANDLE:
        edit_adopt_handle(h, st, (HLOCAL)wp);
        return 0;
    case WM_COPY:
        edit_copy_sel(st);
        return 0;
    case WM_CUT:
        if (edit_ro(h)) return 0;
        edit_copy_sel(st);
        /* fall through: delete the selection */
    case WM_CLEAR: {
        if (edit_ro(h)) return 0;
        int s, e;
        edit_sel(st, &s, &e);
        if (e <= s) return 0;
        edit_del_sel(st);
        st->modified = 1;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        edit_notify(h, EN_CHANGE);
        return 0;
    }
    case WM_PASTE:
        if (!edit_ro(h)) edit_paste(h, st);
        return 0;
    case WM_CONTEXTMENU: {
        /* The standard EDIT right-click menu (todos/0091), built fresh per
         * popup over the 0068 primitive (TPM_RETURNCMD keeps it
         * self-contained; the items are agent targets for free — wmctl
         * tree/click). Undo tracks EM_CANUNDO (no undo buffer yet, 0048
         * scope: always grayed); the rest gate on selection/readonly/
         * clipboard state. lParam is top-level SURFACE coords (the
         * DefWindowProc synthesis), which is what TrackPopupMenu takes. */
        SetFocus(h);
        int s, e;
        edit_sel(st, &s, &e);
        int ro = edit_ro(h);
        char *cl = clip_load();
        HMENU m = CreatePopupMenu();
        MenuTbl *mt = MENU_T(m);
        MenuItem *it;
        it = menu_append(mt, 0, 1, "Undo", NULL);
        if (it && !SendMessage(h, EM_CANUNDO, 0, 0)) it->state = MF_GRAYED;
        menu_append(mt, 2, 0, NULL, NULL);
        it = menu_append(mt, 0, 2, "Cut", NULL);
        if (it && (e <= s || ro)) it->state = MF_GRAYED;
        it = menu_append(mt, 0, 3, "Copy", NULL);
        if (it && e <= s) it->state = MF_GRAYED;
        it = menu_append(mt, 0, 4, "Paste", NULL);
        if (it && (!cl || ro)) it->state = MF_GRAYED;
        it = menu_append(mt, 0, 5, "Delete", NULL);
        if (it && (e <= s || ro)) it->state = MF_GRAYED;
        menu_append(mt, 2, 0, NULL, NULL);
        it = menu_append(mt, 0, 6, "Select All", NULL);
        if (it && st->len == 0) it->state = MF_GRAYED;
        free(cl);
        int cmd = (int)TrackPopupMenu(m, TPM_RETURNCMD,
                                      GET_X_LPARAM(lp), GET_Y_LPARAM(lp),
                                      0, h, NULL);
        DestroyMenu(m);
        switch (cmd) {
        case 1: SendMessage(h, EM_UNDO, 0, 0); break;
        case 2: SendMessage(h, WM_CUT, 0, 0); break;
        case 3: SendMessage(h, WM_COPY, 0, 0); break;
        case 4: SendMessage(h, WM_PASTE, 0, 0); break;
        case 5: SendMessage(h, WM_CLEAR, 0, 0); break;
        case 6: SendMessage(h, EM_SETSEL, 0, (LPARAM)-1); break;
        }
        return 0;
    }
    case EM_SETREADONLY:
        if (wp) h->style |= ES_READONLY; else h->style &= ~ES_READONLY;
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    case WM_SETTEXT: {
        const char *t = lp ? (const char *)lp : "";
        int n = (int)strlen(t);
        if (!edit_ensure(st, n + 1)) return FALSE;
        st->len = edit_normalize(st->buf, t, n);
        st->caret = st->anchor = 0;              /* real EDIT: caret to start */
        st->topLine = st->scrollX = 0;
        st->modified = 0;                        /* programmatic set (0048) */
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        edit_notify(h, EN_CHANGE);
        return TRUE;
    }
    case WM_GETTEXT: {
        char *out = (char *)lp;
        int cap = (int)wp;
        if (!out || cap < 1) return 0;
        int n = st->len < cap - 1 ? st->len : cap - 1;
        memcpy(out, st->buf ? st->buf : "", (size_t)n);
        out[n] = 0;
        return n;
    }
    case WM_GETTEXTLENGTH:
        return st->len;
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_DESTROY:
        if (st) {
            free(st->buf);
            st->buf = NULL;
            if (st->hlocal) { LocalFree(st->hlocal); st->hlocal = NULL; }
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- LISTBOX ---- */

typedef struct {
    char **items;
    unsigned char *marks;       /* per-item selection flag (extended-sel, 0106) */
    int n, cap;
    int sel;                    /* -1 = none; the caret in extended mode */
    int anchor;                 /* shift-range pivot (extended mode, 0106) */
    int top;                    /* first visible row */
    int multi;                  /* LBS_EXTENDEDSEL: a selection SET, not one row */
} LbState;

/* Extended-sel primitives (0106): the SET lives in st->marks; st->sel is the
 * caret (LB_GETCURSEL) and st->anchor the shift-range pivot. */
static void lb_clear_marks(LbState *st) {
    if (st->marks) memset(st->marks, 0, (size_t)st->cap);
}
static void lb_mark_range(LbState *st, int a, int b, int on) {
    if (!st->marks) return;
    if (a > b) { int t = a; a = b; b = t; }
    if (a < 0) a = 0;
    if (b >= st->n) b = st->n - 1;
    for (int i = a; i <= b; i++) st->marks[i] = on ? 1 : 0;
}

static int lb_row_h(HWND h) { return edit_line_h(h) + 2; }

static int lb_rows(HWND h) {
    int rh = lb_row_h(h);
    int rows = (h->h - 4) / (rh > 0 ? rh : 1);
    return rows < 1 ? 1 : rows;
}

static void lb_show_sel(HWND h, LbState *st) {
    int rows = lb_rows(h);
    if (st->sel < 0) return;
    if (st->sel < st->top) st->top = st->sel;
    if (st->sel >= st->top + rows) st->top = st->sel - rows + 1;
}

static void lb_notify(HWND h, int code) {
    if (h->parent)
        SendMessage(h->parent, WM_COMMAND, MAKEWPARAM(h->id, code), (LPARAM)h);
}

static LRESULT lb_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    LbState *st = (LbState *)h->ctl;
    switch (msg) {
    case WM_CREATE:
        st = (LbState *)calloc(1, sizeof(LbState));
        if (!st) return -1;
        st->sel = -1;
        st->anchor = -1;
        st->multi = (h->style & (LBS_EXTENDEDSEL | LBS_MULTIPLESEL)) != 0;
        h->ctl = st;
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        RECT r;
        SetRect(&r, 0, 0, h->w, h->h);
        draw_well(dc, r);
        IntersectClipRect(dc, 2, 2, h->w - 2, h->h - 2);
        SetBkMode(dc, TRANSPARENT);
        int rh = lb_row_h(h);
        for (int i = st->top; i < st->n; i++) {
            int y = 2 + (i - st->top) * rh;
            if (y >= h->h - 2) break;
            RECT row;
            SetRect(&row, 2, y, h->w - 2, y + rh);
            int selected = st->multi ? (st->marks && st->marks[i]) : (i == st->sel);
            if (selected) {
                FillRect(dc, &row, GetSysColorBrush(COLOR_HIGHLIGHT));
                SetTextColor(dc, GetSysColor(COLOR_HIGHLIGHTTEXT));
            } else {
                SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
            }
            TextOut(dc, 4, y + 1, st->items[i], (int)strlen(st->items[i]));
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK: {
        SetFocus(h);
        int rh = lb_row_h(h);
        int idx = st->top + (GET_Y_LPARAM(lp) - 2) / (rh > 0 ? rh : 1);
        if (idx >= 0 && idx < st->n) {
            int changed = st->sel != idx;
            if (st->multi && !(h->style & LBS_EXTENDEDSEL)) {
                /* plain LBS_MULTIPLESEL (0211): a click TOGGLES the item —
                 * the old code gave it extended replace-the-set semantics */
                if (st->marks) st->marks[idx] ^= 1;
                st->anchor = idx;
                changed = 1;
            } else if (st->multi) {
                int ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
                int shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
                if (shift) {                     /* range from the anchor */
                    int base = st->anchor < 0 ? idx : st->anchor;
                    if (!ctrl) lb_clear_marks(st);
                    lb_mark_range(st, base, idx, 1);
                } else if (ctrl) {               /* toggle one, move the anchor */
                    if (st->marks) st->marks[idx] ^= 1;
                    st->anchor = idx;
                } else {                         /* plain: replace the set */
                    lb_clear_marks(st);
                    if (st->marks) st->marks[idx] = 1;
                    st->anchor = idx;
                }
                changed = 1;
            }
            st->sel = idx;                       /* the caret follows the click */
            InvalidateRect(h, NULL, TRUE);
            if (changed) lb_notify(h, LBN_SELCHANGE);
            if (msg == WM_LBUTTONDBLCLK) lb_notify(h, LBN_DBLCLK);
        }
        return 0;
    }
    case WM_GETDLGCODE:                          /* dialog nav (0104) */
        return DLGC_WANTARROWS;
    case WM_KEYDOWN: {
        int old = st->sel;
        int page = lb_rows(h);                   /* PageUp/Down step (0104) */
        if (page < 1) page = 1;
        /* Ctrl+A selects all (extended mode, 0106) — Explorer's chord. */
        if (st->multi && (wp == 'A' || wp == 'a') &&
            (GetKeyState(VK_CONTROL) & 0x8000)) {
            lb_mark_range(st, 0, st->n - 1, 1);
            st->anchor = 0;
            InvalidateRect(h, NULL, TRUE);
            lb_notify(h, LBN_SELCHANGE);
            return 0;
        }
        if (wp == VK_UP && st->sel > 0) st->sel--;
        else if (wp == VK_DOWN && st->sel < st->n - 1) st->sel++;
        else if (wp == VK_HOME && st->n) st->sel = 0;
        else if (wp == VK_END && st->n) st->sel = st->n - 1;
        else if (wp == VK_PRIOR && st->n) st->sel = st->sel > page ? st->sel - page : 0;
        else if (wp == VK_NEXT && st->n)
            st->sel = st->sel + page < st->n ? st->sel + page : st->n - 1;
        else return 0;
        if (st->multi) {                         /* keep the SET in step (0106) */
            int shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
            if (shift) {
                if (st->anchor < 0) st->anchor = old < 0 ? st->sel : old;
                lb_clear_marks(st);
                lb_mark_range(st, st->anchor, st->sel, 1);
            } else {
                lb_clear_marks(st);
                if (st->marks && st->sel >= 0) st->marks[st->sel] = 1;
                st->anchor = st->sel;
            }
        }
        if (st->sel != old || st->multi) {
            lb_show_sel(h, st);
            InvalidateRect(h, NULL, TRUE);
            lb_notify(h, LBN_SELCHANGE);
        }
        return 0;
    }
    case WM_MOUSEWHEEL: {
        int delta = GET_WHEEL_DELTA_WPARAM(wp);
        st->top -= 3 * (delta / WHEEL_DELTA);
        int maxTop = st->n - lb_rows(h);
        if (maxTop < 0) maxTop = 0;
        if (st->top > maxTop) st->top = maxTop;
        if (st->top < 0) st->top = 0;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case LB_ADDSTRING: {
        const char *s = (const char *)lp;
        if (!s) return LB_ERR;
        if (st->n >= st->cap) {
            int nc = st->cap ? st->cap * 2 : 16;
            char **ni = (char **)realloc(st->items, (size_t)nc * sizeof(char *));
            if (!ni) return LB_ERR;
            st->items = ni;
            unsigned char *nm = (unsigned char *)realloc(st->marks, (size_t)nc);
            if (!nm) return LB_ERR;
            memset(nm + st->cap, 0, (size_t)(nc - st->cap));
            st->marks = nm;
            st->cap = nc;
        }
        size_t n = strlen(s);
        char *copy = (char *)malloc(n + 1);
        if (!copy) return LB_ERR;
        memcpy(copy, s, n + 1);
        st->items[st->n] = copy;
        st->marks[st->n] = 0;
        InvalidateRect(h, NULL, TRUE);
        return st->n++;
    }
    case LB_DELETESTRING: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return LB_ERR;
        free(st->items[i]);
        memmove(&st->items[i], &st->items[i + 1],
                (size_t)(st->n - i - 1) * sizeof(char *));
        if (st->marks)
            memmove(&st->marks[i], &st->marks[i + 1], (size_t)(st->n - i - 1));
        st->n--;
        if (st->sel == i) st->sel = -1;
        else if (st->sel > i) st->sel--;
        InvalidateRect(h, NULL, TRUE);
        return st->n;
    }
    case LB_RESETCONTENT:
        for (int i = 0; i < st->n; i++) free(st->items[i]);
        lb_clear_marks(st);
        st->n = 0;
        st->sel = -1;
        st->anchor = -1;
        st->top = 0;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case LB_GETCOUNT:
        return st->n;
    case LB_GETSEL:                              /* per-item selection (0106) */
        if ((int)wp < 0 || (int)wp >= st->n) return LB_ERR;
        return st->multi ? (st->marks && st->marks[(int)wp])
                         : ((int)wp == st->sel);
    case LB_SETSEL: {                            /* wp = on/off; lp = index (-1 all) */
        if (!st->multi) return LB_ERR;
        int i = (int)lp;
        if (i == -1) lb_mark_range(st, 0, st->n - 1, (int)wp);
        else if (i >= 0 && i < st->n && st->marks) st->marks[i] = wp ? 1 : 0;
        else return LB_ERR;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case LB_SELITEMRANGE: {                      /* wp = on/off; lp = MAKELPARAM(a,b) */
        if (!st->multi) return LB_ERR;
        lb_mark_range(st, LOWORD(lp), HIWORD(lp), (int)wp);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case LB_GETSELCOUNT: {
        if (!st->multi || !st->marks) return LB_ERR;
        int c = 0;
        for (int i = 0; i < st->n; i++) c += st->marks[i] ? 1 : 0;
        return c;
    }
    case LB_GETSELITEMS: {                       /* wp = max; lp = int* buffer */
        if (!st->multi || !st->marks) return LB_ERR;
        int max = (int)wp, c = 0;
        int *out = (int *)lp;
        for (int i = 0; i < st->n && c < max; i++)
            if (st->marks[i]) out[c++] = i;
        return c;
    }
    case LB_ITEMFROMPOINT: {
        /* lParam is CLIENT coords; LOWORD the nearest row, HIWORD 1 when
         * the point sits outside the items (Windows semantics) — 0092's
         * right-click row hit (fileman maps the WM_CONTEXTMENU surface
         * point into listbox client space itself; it knows its layout). */
        int cy = GET_Y_LPARAM(lp), cx = GET_X_LPARAM(lp);
        int rh = lb_row_h(h);
        int idx = st->top + (cy - 2) / (rh > 0 ? rh : 1);
        int outside = cx < 0 || cx >= h->w || cy < 2 || idx < 0 || idx >= st->n;
        if (idx < 0) idx = 0;
        if (st->n && idx >= st->n) idx = st->n - 1;
        return MAKELPARAM(idx, outside ? 1 : 0);
    }
    case LB_GETCURSEL:
        return st->sel < 0 ? LB_ERR : st->sel;
    case LB_SETCURSEL: {
        int i = (int)wp;
        if (i != -1 && (i < 0 || i >= st->n)) return LB_ERR;
        st->sel = i;
        /* Single-select: the caret IS the selection. Extended-sel: the SET
         * lives in st->marks (LB_SETSEL) — SETCURSEL only moves the caret,
         * so a right-click can position it without collapsing the set. */
        if (st->multi) st->anchor = i;
        if (i >= 0) lb_show_sel(h, st);
        InvalidateRect(h, NULL, TRUE);
        return i;
    }
    case LB_GETTEXT: {
        int i = (int)wp;
        char *out = (char *)lp;
        if (i < 0 || i >= st->n || !out) return LB_ERR;
        strcpy(out, st->items[i]);
        return (LRESULT)strlen(st->items[i]);
    }
    case LB_GETTEXTLEN: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return LB_ERR;
        return (LRESULT)strlen(st->items[i]);
    }
    case WM_GETTEXT: {
        /* Agent-facing: a listbox's "text" is its items, newline-joined,
         * with the selected row marked — WM_GETTEXT on a real listbox is
         * the (empty) caption, useless to a driver. */
        char *out = (char *)lp;
        int cap = (int)wp, n = 0;
        if (!out || cap < 1) return 0;
        for (int i = 0; i < st->n && n < cap - 1; i++) {
            int selected = st->multi ? (st->marks && st->marks[i]) : (i == st->sel);
            n += snprintf(out + n, (size_t)(cap - n), "%s%s\n",
                          selected ? "> " : "", st->items[i]);
            if (n >= cap) { n = cap - 1; break; }
        }
        out[n] = 0;
        return n;
    }
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_DESTROY:
        if (st) {
            for (int i = 0; i < st->n; i++) free(st->items[i]);
            free(st->items);
            free(st->marks);
            st->items = NULL;
            st->marks = NULL;
            st->n = 0;
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- SCROLLBAR (SBS_VERT / SBS_HORZ; SB_CTL only) ---- */

typedef struct {
    int min, max, pos;
    int page;                   /* SIF_PAGE (0211): 0 = classic square thumb */
    int dragging, dragOff;
    int dragPos;                /* thumb position while dragging (visual) */
} SbState;

static int sb_vert(HWND h) { return (h->style & 1) == SBS_VERT; }

/* Highest reachable pos: max - page + 1 when a page is set (the Windows
 * SIF_PAGE rule), else max. */
static int sb_max_pos(SbState *st) {
    int m = st->page > 0 ? st->max - st->page + 1 : st->max;
    return m < st->min ? st->min : m;
}

/* Geometry: [arrow][channel with thumb][arrow]; the thumb is a square
 * classically, proportional once SIF_PAGE set a page size (0211). */
static void sb_geom(HWND h, SbState *st, int *btn, int *track, int *thumbPos,
                    int *thumbLen) {
    int len = sb_vert(h) ? h->h : h->w;
    int b = sb_vert(h) ? h->w : h->h;
    if (b * 2 > len) b = len / 2;
    *btn = b;
    int chan = len - 2 * b;
    int tl = b;
    int span = st->max - st->min + 1;
    if (st->page > 0 && span > 0) {
        tl = chan * st->page / span;
        if (tl < 8) tl = 8;
        if (tl > chan) tl = chan;
    }
    *thumbLen = tl;
    *track = chan - tl;                          /* travel of the thumb's top */
    if (*track < 0) *track = 0;
    int posRange = sb_max_pos(st) - st->min;
    int pos = st->dragging ? st->dragPos : st->pos;
    *thumbPos = b + (posRange > 0 ? (pos - st->min) * *track / posRange : 0);
}

static int sb_pos_of(HWND h, SbState *st, int pix) {
    int btn, track, tp, tl;
    sb_geom(h, st, &btn, &track, &tp, &tl);
    int posRange = sb_max_pos(st) - st->min;
    if (track <= 0 || posRange <= 0) return st->min;
    int p = st->min + (pix - btn) * posRange / track;
    if (p < st->min) p = st->min;
    if (p > sb_max_pos(st)) p = sb_max_pos(st);
    return p;
}

static void sb_notify(HWND h, int code, int pos) {
    if (h->parent)
        SendMessage(h->parent, sb_vert(h) ? WM_VSCROLL : WM_HSCROLL,
                    MAKEWPARAM(code, pos), (LPARAM)h);
}

static void sb_tri(HDC dc, int cx, int cy, int dir) {   /* dir: 0 up/left.. */
    POINT p[3];
    int s = 3;
    switch (dir) {
    case 0: p[0].x = cx; p[0].y = cy - s; p[1].x = cx - s; p[1].y = cy + s; p[2].x = cx + s; p[2].y = cy + s; break;
    case 1: p[0].x = cx; p[0].y = cy + s; p[1].x = cx - s; p[1].y = cy - s; p[2].x = cx + s; p[2].y = cy - s; break;
    case 2: p[0].x = cx - s; p[0].y = cy; p[1].x = cx + s; p[1].y = cy - s; p[2].x = cx + s; p[2].y = cy + s; break;
    default: p[0].x = cx + s; p[0].y = cy; p[1].x = cx - s; p[1].y = cy - s; p[2].x = cx - s; p[2].y = cy + s; break;
    }
    HBRUSH br = CreateSolidBrush(GetSysColor(COLOR_BTNTEXT));
    HGDIOBJ ob = SelectObject(dc, (HGDIOBJ)br);
    HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
    Polygon(dc, p, 3);
    SelectObject(dc, op);
    SelectObject(dc, ob);
    DeleteObject((HGDIOBJ)br);
}

static LRESULT sb_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    SbState *st = (SbState *)h->ctl;
    switch (msg) {
    case WM_CREATE:
        st = (SbState *)calloc(1, sizeof(SbState));
        if (!st) return -1;
        st->max = 100;
        h->ctl = st;
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        int btn, track, tp, tl;
        sb_geom(h, st, &btn, &track, &tp, &tl);
        RECT r;
        /* channel */
        SetRect(&r, 0, 0, h->w, h->h);
        FillRect(dc, &r, GetSysColorBrush(COLOR_SCROLLBAR));
        int v = sb_vert(h);
        /* arrows */
        RECT a1, a2;
        if (v) {
            SetRect(&a1, 0, 0, h->w, btn);
            SetRect(&a2, 0, h->h - btn, h->w, h->h);
        } else {
            SetRect(&a1, 0, 0, btn, h->h);
            SetRect(&a2, h->w - btn, 0, h->w, h->h);
        }
        FillRect(dc, &a1, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a1, 0);
        FillRect(dc, &a2, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, a2, 0);
        sb_tri(dc, (a1.left + a1.right) / 2, (a1.top + a1.bottom) / 2, v ? 0 : 2);
        sb_tri(dc, (a2.left + a2.right) / 2, (a2.top + a2.bottom) / 2, v ? 1 : 3);
        /* thumb */
        RECT th;
        if (v) SetRect(&th, 0, tp, h->w, tp + tl);
        else SetRect(&th, tp, 0, tp + tl, h->h);
        FillRect(dc, &th, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, th, 0);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int v = sb_vert(h);
        int p = v ? GET_Y_LPARAM(lp) : GET_X_LPARAM(lp);
        int len = v ? h->h : h->w;
        int btn, track, tp, tl;
        sb_geom(h, st, &btn, &track, &tp, &tl);
        /* Windows semantics: the control only NOTIFIES — the app moves
         * the position (SetScrollPos) in its WM_VSCROLL handler. */
        if (p < btn) {
            sb_notify(h, SB_LINEUP, 0);
        } else if (p >= len - btn) {
            sb_notify(h, SB_LINEDOWN, 0);
        } else if (p >= tp && p < tp + tl) {
            st->dragging = 1;
            st->dragOff = p - tp;
            st->dragPos = st->pos;
            SetCapture(h);
        } else if (p < tp) {
            sb_notify(h, SB_PAGEUP, 0);
        } else {
            sb_notify(h, SB_PAGEDOWN, 0);
        }
        return 0;
    }
    case WM_MOUSEMOVE:
        if (st->dragging && GetCapture() == h) {
            int p = sb_vert(h) ? GET_Y_LPARAM(lp) : GET_X_LPARAM(lp);
            int np = sb_pos_of(h, st, p - st->dragOff);
            if (np != st->dragPos) {
                st->dragPos = np;
                InvalidateRect(h, NULL, TRUE);
                sb_notify(h, SB_THUMBTRACK, np);
            }
        }
        return 0;
    case WM_LBUTTONUP:
        if (st->dragging) {
            int fin = st->dragPos;
            st->dragging = 0;
            ReleaseCapture();
            InvalidateRect(h, NULL, TRUE);       /* snap back unless app sets */
            sb_notify(h, SB_THUMBPOSITION, fin);
            sb_notify(h, SB_ENDSCROLL, fin);
        }
        return 0;
    case WM_DESTROY:
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- window scroll-info plumbing (0211) ----
 * The Get/SetScroll* APIs route by target: SB_CTL requires a SCROLLBAR
 * control (they used to poke h->ctl blindly — SetScrollPos(hEdit, ...)
 * type-confused the EDIT's state); SB_VERT/SB_HORZ resolve to an EDIT's
 * built-in bars, where the bar state IS the view state (pos = topLine /
 * scrollX px — one source of truth, so a programmatic Set scrolls the
 * text; the EN_*SCROLL notifications stay user-action-only). Any other
 * combination is unsupported and says so. */

enum { SBTGT_NONE, SBTGT_CTL, SBTGT_EDIT_V, SBTGT_EDIT_H };

static int sb_target(HWND h, int bar, const char *api) {
    if (h && h->cls && h->ctl) {
        if (bar == SB_CTL && ci_eq(h->cls->name, "SCROLLBAR"))
            return SBTGT_CTL;
        if (ci_eq(h->cls->name, "EDIT")) {
            if (bar == SB_VERT && edit_sb(h)) return SBTGT_EDIT_V;
            if (bar == SB_HORZ && edit_hsb(h)) return SBTGT_EDIT_H;
        }
    }
    WIN32_UNSUPPORTED("%s: no %s scrollbar on this window (class %s)",
                      api, bar == SB_CTL ? "SB_CTL" :
                           bar == SB_VERT ? "SB_VERT" : "SB_HORZ",
                      h && h->cls ? h->cls->name : "?");
    return SBTGT_NONE;
}

/* EDIT built-in bar views for the scroll APIs. */
static void edit_bar_get(HWND h, int vert, int *min, int *max, int *page,
                         int *pos) {
    EditState *st = (EditState *)h->ctl;
    *min = 0;
    if (vert) {
        *max = edit_line_count(st) - 1;
        *page = edit_rows(h, edit_line_h(h));
        *pos = st->topLine;
    } else {
        *max = edit_content_w(h, st) + 1;        /* px, matches edit_max_sx */
        *page = edit_view_w(h);
        *pos = st->scrollX;
    }
}

static int edit_bar_set_pos(HWND h, int vert, int pos) {
    EditState *st = (EditState *)h->ctl;
    int old = vert ? st->topLine : st->scrollX;
    if (pos < 0) pos = 0;
    if (vert) {
        int m = edit_max_top(h, st);
        st->topLine = pos > m ? m : pos;         /* silent: no EN_VSCROLL */
    } else {
        int m = edit_max_sx(h, st);
        st->scrollX = pos > m ? m : pos;
    }
    InvalidateRect(h, NULL, TRUE);
    return old;
}

int SetScrollPos(HWND h, int bar, int pos, BOOL redraw) {
    switch (sb_target(h, bar, "SetScrollPos")) {
    case SBTGT_CTL: {
        SbState *st = (SbState *)h->ctl;
        int old = st->pos;
        if (pos < st->min) pos = st->min;
        if (pos > sb_max_pos(st)) pos = sb_max_pos(st);
        st->pos = pos;
        if (redraw) InvalidateRect(h, NULL, TRUE);
        return old;
    }
    case SBTGT_EDIT_V: return edit_bar_set_pos(h, 1, pos);
    case SBTGT_EDIT_H: return edit_bar_set_pos(h, 0, pos);
    }
    return 0;
}

int GetScrollPos(HWND h, int bar) {
    int mn, mx, pg, pos;
    switch (sb_target(h, bar, "GetScrollPos")) {
    case SBTGT_CTL: return ((SbState *)h->ctl)->pos;
    case SBTGT_EDIT_V: edit_bar_get(h, 1, &mn, &mx, &pg, &pos); return pos;
    case SBTGT_EDIT_H: edit_bar_get(h, 0, &mn, &mx, &pg, &pos); return pos;
    }
    return 0;
}

BOOL SetScrollRange(HWND h, int bar, int min, int max, BOOL redraw) {
    if (min > max) return FALSE;
    switch (sb_target(h, bar, "SetScrollRange")) {
    case SBTGT_CTL: {
        SbState *st = (SbState *)h->ctl;
        st->min = min;
        st->max = max;
        if (st->pos < min) st->pos = min;
        if (st->pos > sb_max_pos(st)) st->pos = sb_max_pos(st);
        if (redraw) InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case SBTGT_EDIT_V:
    case SBTGT_EDIT_H:
        /* the EDIT owns its range (line count / content width) */
        WIN32_UNSUPPORTED("SetScrollRange on an EDIT built-in bar");
        return FALSE;
    }
    return FALSE;
}

BOOL GetScrollRange(HWND h, int bar, LPINT min, LPINT max) {
    int mn, mx, pg, pos;
    switch (sb_target(h, bar, "GetScrollRange")) {
    case SBTGT_CTL:
        mn = ((SbState *)h->ctl)->min;
        mx = ((SbState *)h->ctl)->max;
        break;
    case SBTGT_EDIT_V: edit_bar_get(h, 1, &mn, &mx, &pg, &pos); break;
    case SBTGT_EDIT_H: edit_bar_get(h, 0, &mn, &mx, &pg, &pos); break;
    default: return FALSE;
    }
    if (min) *min = mn;
    if (max) *max = mx;
    return TRUE;
}

/* SetScrollInfo/GetScrollInfo (0211): the modern API over the same
 * targets. Returns the resulting position, like Windows. */
int SetScrollInfo(HWND h, int bar, const SCROLLINFO *si, BOOL redraw) {
    if (!si) return 0;
    switch (sb_target(h, bar, "SetScrollInfo")) {
    case SBTGT_CTL: {
        SbState *st = (SbState *)h->ctl;
        if (si->fMask & SIF_RANGE) { st->min = si->nMin; st->max = si->nMax; }
        if (si->fMask & SIF_PAGE) st->page = (int)si->nPage;
        if (si->fMask & SIF_POS) st->pos = si->nPos;
        if (st->max < st->min) st->max = st->min;
        if (st->pos < st->min) st->pos = st->min;
        if (st->pos > sb_max_pos(st)) st->pos = sb_max_pos(st);
        if (redraw) InvalidateRect(h, NULL, TRUE);
        return st->pos;
    }
    case SBTGT_EDIT_V:
    case SBTGT_EDIT_H: {
        int vert = bar == SB_VERT;
        if (si->fMask & (SIF_RANGE | SIF_PAGE))
            WIN32_UNSUPPORTED("SetScrollInfo range/page on an EDIT bar");
        if (si->fMask & SIF_POS) edit_bar_set_pos(h, vert, si->nPos);
        int mn, mx, pg, pos;
        edit_bar_get(h, vert, &mn, &mx, &pg, &pos);
        return pos;
    }
    }
    return 0;
}

BOOL GetScrollInfo(HWND h, int bar, SCROLLINFO *si) {
    if (!si) return FALSE;
    int mn, mx, pg, pos, track;
    switch (sb_target(h, bar, "GetScrollInfo")) {
    case SBTGT_CTL: {
        SbState *st = (SbState *)h->ctl;
        mn = st->min; mx = st->max; pg = st->page;
        pos = st->pos;
        track = st->dragging ? st->dragPos : st->pos;
        break;
    }
    case SBTGT_EDIT_V: edit_bar_get(h, 1, &mn, &mx, &pg, &pos); track = pos; break;
    case SBTGT_EDIT_H: edit_bar_get(h, 0, &mn, &mx, &pg, &pos); track = pos; break;
    default: return FALSE;
    }
    if (si->fMask & SIF_RANGE) { si->nMin = mn; si->nMax = mx; }
    if (si->fMask & SIF_PAGE) si->nPage = (UINT)pg;
    if (si->fMask & SIF_POS) si->nPos = pos;
    if (si->fMask & SIF_TRACKPOS) si->nTrackPos = track;
    return TRUE;
}

/* ---- builtin class registration + hit-test transparency ---- */

static int class_transparent(HWND h) {
    if (!h->cls) return 0;
    if (ci_eq(h->cls->name, "STATIC")) return 1;
    if (ci_eq(h->cls->name, "BUTTON") && btn_kind(h) == BS_GROUPBOX) return 1;
    return 0;
}

static void ensure_builtin_classes(void) {
    static int done;
    if (done) return;
    done = 1;
    class_add("BUTTON", btn_proc, 0, NULL);
    class_add("STATIC", static_proc, 0, NULL);
    class_add("EDIT", edit_proc, 0, NULL);
    class_add("LISTBOX", lb_proc, CS_DBLCLKS, NULL);
    class_add("SCROLLBAR", sb_proc, 0, NULL);
}

/* ============================================================ dialogs
 * "#32770" hosts BOTH shapes (0068): MessageBox windows (no DlgState in
 * h->ctl — the 0058 behavior verbatim) and template dialogs
 * (DialogBoxParamW below — a DlgState carries the app DLGPROC, which gets
 * first crack at every message, the DefDlgProc way). */

static int g_mbResult;

typedef struct {
    DLGPROC proc;
    LPARAM param;
    int ended;                  /* EndDialog called */
    INT_PTR result;
    int modal;
} DlgState;

/* The default pushbutton's id (BS_DEFPUSHBUTTON style, one source of
 * truth — the drawing and DM_GETDEFID both read it), 0 if none. (0104) */
static int dlg_default_id(HWND dlg) {
    HWND arr[128];
    int n = dlg_collect(dlg, arr, 128, 0);
    for (int i = 0; i < n; i++) {
        HWND c = arr[i];
        if (c->cls && ci_eq(c->cls->name, "BUTTON") &&
            (c->style & 0xF) == BS_DEFPUSHBUTTON && hwnd_shown(c) && hwnd_able(c))
            return c->id;
    }
    return 0;
}

/* DM_SETDEFID: move the BS_DEFPUSHBUTTON style bit to the target button so
 * the outline + Enter routing follow it. (0104) */
static void dlg_set_defid(HWND dlg, int id) {
    HWND arr[128];
    int n = dlg_collect(dlg, arr, 128, 0);
    for (int i = 0; i < n; i++) {
        HWND c = arr[i];
        if (!c->cls || !ci_eq(c->cls->name, "BUTTON")) continue;
        int k = c->style & 0xF;
        if (k == BS_DEFPUSHBUTTON && c->id != id) {
            c->style = (c->style & ~0xFu) | BS_PUSHBUTTON;
            InvalidateRect(c, NULL, TRUE);
        } else if (c->id == id && (k == BS_PUSHBUTTON || k == BS_DEFPUSHBUTTON)) {
            c->style = (c->style & ~0xFu) | BS_DEFPUSHBUTTON;
            InvalidateRect(c, NULL, TRUE);
        }
    }
}

/* A control whose label mnemonic matches vk (an uppercased letter/digit). */
static HWND dlg_find_mnemonic(HWND dlg, int vk) {
    HWND arr[128];
    int n = dlg_collect(dlg, arr, 128, 0);
    for (int i = 0; i < n; i++) {
        HWND c = arr[i];
        if (hwnd_shown(c) && hwnd_able(c) && mnemonic_char(text_get(c)) == (char)vk)
            return c;
    }
    return NULL;
}

/* Activate a mnemonic hit: a BUTTON presses (STATIC hands focus to the
 * next tabstop — the Win32 label rule). (0104) */
static void dlg_do_mnemonic(HWND dlg, HWND c) {
    if (c->cls && ci_eq(c->cls->name, "BUTTON")) {
        if ((c->style & 0xF) == BS_GROUPBOX) return;
        SetFocus(c);
        SendMessage(c, BM_CLICK, 0, 0);
    } else {
        HWND next = GetNextDlgTabItem(dlg, c, FALSE);
        if (next) SetFocus(next);
    }
}

static LRESULT dlg_proc_32770(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    DlgState *st = (DlgState *)h->ctl;
    if (st) {                                    /* template dialog */
        if (st->proc) {
            LRESULT r = st->proc(h, msg, wp, lp);
            if (r) {
                /* the WM_CTLCOLOR* family returns the BRUSH through the
                 * DLGPROC's return value (the classic quirk) */
                if (msg >= WM_CTLCOLORMSGBOX && msg <= WM_CTLCOLORSTATIC) return r;
                return 0;
            }
        }
        if (msg == DM_GETDEFID) {                /* DefDlgProc (0104) */
            int id = dlg_default_id(h);
            return id ? MAKELONG(id, DC_HASDEFID) : 0;
        }
        if (msg == DM_SETDEFID) { dlg_set_defid(h, (int)wp); return TRUE; }
        if (msg == WM_NEXTDLGCTL) {
            HWND next = wp && lp
                ? (HWND)wp                       /* lParam TRUE: wParam is the ctl */
                : GetNextDlgTabItem(h, h->focus, wp ? TRUE : FALSE);
            if (next) SetFocus(next);
            return 0;
        }
        if (msg == WM_CLOSE) {                   /* DefDlgProc: 'x' = cancel */
            EndDialog(h, IDCANCEL);
            return 0;
        }
        if (msg == WM_DESTROY) return 0;
        return DefWindowProc(h, msg, wp, lp);
    }
    switch (msg) {                               /* MessageBox (0058) */
    case WM_COMMAND:
        g_mbResult = (int)LOWORD(wp);
        DestroyWindow(h);
        return 0;
    case WM_CLOSE:
        g_mbResult = 0;                          /* filled by caller per type */
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static void ensure_dialog_class(void) {
    ensure_builtin_classes();
    if (!class_find("#32770"))
        class_add("#32770", dlg_proc_32770, 0, (HBRUSH)(COLOR_BTNFACE + 1));
}

/* MessageBeep (todos/0094): the event-sound scheme via winmm's PlaySound
 * (same lib — os/win32/lib.json links winmm.c into every user32 app).
 * SND_NODEFAULT: an unknown/absent alias stays silent rather than dinging
 * with the default — MessageBeep IS the default-sound surface. */
BOOL MessageBeep(UINT type) {
    const char *alias;
    switch (type & 0xF0u) {                      /* MB_ICONMASK */
    case MB_ICONHAND:        alias = "SystemHand"; break;
    case MB_ICONQUESTION:    alias = "SystemQuestion"; break;
    case MB_ICONEXCLAMATION: alias = "SystemExclamation"; break;
    case MB_ICONASTERISK:    alias = "SystemAsterisk"; break;
    default:                 alias = "SystemDefault"; break;   /* MB_OK, 0xFFFFFFFF */
    }
    PlaySoundA(alias, NULL, SND_ALIAS | SND_ASYNC | SND_NODEFAULT);
    return TRUE;
}

int MessageBox(HWND owner, LPCSTR text, LPCSTR caption, UINT type) {
    ensure_dialog_class();
    MessageBeep(type);                           /* icon sound (todos/0094) */

    /* Measure the text on a memory DC (the image font). */
    HDC mdc = CreateCompatibleDC(NULL);
    RECT tr;
    SetRect(&tr, 0, 0, 320, 200);
    int textH = 16, lineH = 16;
    if (mdc) {
        TEXTMETRIC tm;
        if (GetTextMetrics(mdc, &tm)) lineH = tm.tmHeight;
        textH = DrawText(mdc, text ? text : "", -1, &tr, DT_CALCRECT | DT_WORDBREAK);
        DeleteDC(mdc);
    }
    /* Button set from the TYPE nibble (0048: MB_YESNOCANCEL is notepad's
     * save prompt; the old flag tests read 0x3 as OKCANCEL). */
    static const struct { const char *label; int id; } BTNSETS[6][3] = {
        { { "OK", IDOK } },                                        /* MB_OK */
        { { "OK", IDOK }, { "Cancel", IDCANCEL } },                /* MB_OKCANCEL */
        { { "Abort", IDABORT }, { "Retry", IDRETRY },              /* 0211 */
          { "Ignore", IDIGNORE } },                                /* MB_ABORTRETRYIGNORE */
        { { "Yes", IDYES }, { "No", IDNO }, { "Cancel", IDCANCEL } },
        { { "Yes", IDYES }, { "No", IDNO } },                      /* MB_YESNO */
        { { "Retry", IDRETRY }, { "Cancel", IDCANCEL } },          /* MB_RETRYCANCEL */
    };
    int set = (int)(type & 0xF) <= 5 ? (int)(type & 0xF) : 0;
    int nBtn = 1;
    while (nBtn < 3 && BTNSETS[set][nBtn].label) nBtn++;
    int w = tr.right + 40;
    if (w < nBtn * 90 + 30) w = nBtn * 90 + 30;
    if (w < 180) w = 180;
    int hgt = textH + 34 + 40;
    if (hgt < 100) hgt = 100;

    HWND box = CreateWindowEx(0, "#32770", caption ? caption : "",
                              WS_POPUP | WS_VISIBLE, 0, 0, w, hgt,
                              NULL, NULL, NULL, NULL);
    if (!box) return 0;
    CreateWindowEx(0, "STATIC", text ? text : "", WS_CHILD | WS_VISIBLE,
                   20, 14, w - 40, textH + lineH, box, NULL, NULL, NULL);
    int by = hgt - 34, bw = 80;
    int bx = (w - (nBtn * bw + (nBtn - 1) * 10)) / 2;
    HWND firstBtn = NULL;
    for (int i = 0; i < nBtn; i++) {
        /* keyboard-navigable (0104): tabstops, the first is the default. */
        DWORD bs = WS_CHILD | WS_VISIBLE | WS_TABSTOP |
                   (i == 0 ? BS_DEFPUSHBUTTON : BS_PUSHBUTTON);
        HWND b = CreateWindowEx(0, "BUTTON", BTNSETS[set][i].label, bs,
                                bx + i * (bw + 10), by, bw, 24, box,
                                (HMENU)(UINT_PTR)BTNSETS[set][i].id, NULL, NULL);
        if (i == 0) firstBtn = b;
    }
    if (firstBtn) SetFocus(firstBtn);

    HWND ownerTop = owner ? owner->top : NULL;
    int reenable = 0;
    if (ownerTop && ownerTop->enabled) {
        EnableWindow(ownerTop, FALSE);
        reenable = 1;
    }

    int saved = g_mbResult;
    g_mbResult = 0;
    MSG m;
    memset(&m, 0, sizeof m);
    while (IsWindow(box) && GetMessage(&m, NULL, 0, 0)) {
        if (IsDialogMessageW(box, &m)) continue;   /* Tab/Enter/Esc (0104) */
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (m.message == WM_QUIT) {
        /* WM_QUIT raced the modal loop: re-post for the outer loop. */
        PostQuitMessage((int)m.wParam);
        if (IsWindow(box)) DestroyWindow(box);
    }
    int result = g_mbResult;
    g_mbResult = saved;
    if (reenable && IsWindow(ownerTop)) EnableWindow(ownerTop, TRUE);
    if (!result)                                 /* closed via 'x' */
        result = set == 4 ? IDNO : set ? IDCANCEL : IDOK;
    return result;
}

/* ============================================================ template
 * dialogs (0068): DialogBoxParamW instantiates the WRES RT_DIALOG record
 * — a "#32770" top-level + child controls, dialog units scaled by the
 * stock font (Windows' base-unit rule: px = du*avgCharW/4 horizontally,
 * du*charH/8 vertically). Modal = the MessageBox loop + owner-disable
 * shape; EndDialog marks the state and the loop exits and destroys. */

typedef struct {                                 /* WRES cursor */
    const uint8_t *p, *end;
    int bad;
} ResRd;

static uint32_t rr16(ResRd *r) {
    if (r->p + 2 > r->end) { r->bad = 1; return 0; }
    uint32_t v = rd16(r->p);
    r->p += 2;
    return v;
}

static uint32_t rr32(ResRd *r) {
    if (r->p + 4 > r->end) { r->bad = 1; return 0; }
    uint32_t v = rd32(r->p);
    r->p += 4;
    return v;
}

static char *rrstr(ResRd *r) {                   /* malloc'd UTF-8 */
    int n = (int)rr16(r);
    if (r->bad || r->p + n > r->end) { r->bad = 1; return NULL; }
    char *s = (char *)malloc((size_t)n + 1);
    if (!s) { r->bad = 1; return NULL; }
    memcpy(s, r->p, (size_t)n);
    s[n] = 0;
    r->p += n;
    return s;
}

static const char *DLG_CLASSES[] = { NULL, "BUTTON", "EDIT", "STATIC",
                                     "LISTBOX", "SCROLLBAR", "COMBOBOX" };

static HWND dlg_create(HINSTANCE inst, LPCWSTR tmpl, HWND owner,
                       DLGPROC proc, LPARAM param, int modal) {
    (void)inst;
    ensure_dialog_class();
    if (!is_intres(tmpl)) return NULL;
    uint32_t sz;
    const uint8_t *d = res_find(RT_DIALOG_K, (int)(UINT_PTR)tmpl, &sz);
    if (!d) return NULL;
    ResRd r = { d, d + sz, 0 };

    /* base units from the stock font */
    TEXTMETRIC tm;
    tm.tmAveCharWidth = 8;
    tm.tmHeight = 16;
    GetTextMetrics(menu_mdc(), &tm);
    int bx = tm.tmAveCharWidth > 0 ? tm.tmAveCharWidth : 8;
    int by = tm.tmHeight > 0 ? tm.tmHeight : 16;

    rr16(&r); rr16(&r);                          /* x, y: the WM places us */
    int dw = (int)(short)rr16(&r), dh = (int)(short)rr16(&r);
    rr32(&r);                                    /* dialog style: geometry is ours */
    int menuId = (int)rr16(&r);                  /* WRES v2: template MENU */
    char *caption = rrstr(&r);
    rr16(&r);                                    /* font size */
    char *face = rrstr(&r);
    free(face);
    int nCtl = (int)rr16(&r);
    if (r.bad || nCtl < 0 || nCtl > 256) { free(caption); return NULL; }

    /* A template menu rides the surface's top MENU_BAR_H pixels — grow the
     * window so the CLIENT area still matches the template (calc). */
    HMENU tmplMenu = menuId ? LoadMenuW(NULL, MAKEINTRESOURCEW(menuId)) : NULL;
    HWND dlg = CreateWindowEx(0, "#32770", caption ? caption : "",
                              WS_POPUP | WS_VISIBLE,
                              0, 0, dw * bx / 4,
                              dh * by / 8 + (tmplMenu ? MENU_BAR_H : 0),
                              NULL, tmplMenu, NULL, NULL);
    free(caption);
    if (!dlg && tmplMenu) DestroyMenu(tmplMenu);
    if (!dlg) return NULL;
    DlgState *st = (DlgState *)calloc(1, sizeof(DlgState));
    if (!st) { DestroyWindow(dlg); return NULL; }
    st->proc = proc;
    st->param = param;
    st->modal = modal;
    dlg->ctl = st;                               /* freed by DestroyWindow */

    HWND firstTab = NULL;
    for (int i = 0; i < nCtl && !r.bad; i++) {
        if (r.p >= r.end) { r.bad = 1; break; }
        int cls = *r.p < 7 ? *r.p : 0;
        r.p++;
        int id = (int)(short)rr16(&r);
        int cx = (int)(short)rr16(&r), cy = (int)(short)rr16(&r);
        int cw = (int)(short)rr16(&r), ch = (int)(short)rr16(&r);
        uint32_t style = rr32(&r);
        char *text = rrstr(&r);
        if (r.bad) { free(text); break; }
        if (!DLG_CLASSES[cls] || !class_find(DLG_CLASSES[cls])) {
            /* COMBOBOX etc: not grown yet (0211) — a template control the
             * veneer can't create is a MISSING control, not a quiet gap */
            WIN32_UNSUPPORTED("dialog-template control class %u "
                              "(control skipped)", (unsigned)cls);
            free(text);
            continue;
        }
        HWND c = CreateWindowEx(0, DLG_CLASSES[cls], text ? text : "",
                                style, cx * bx / 4, cy * by / 8,
                                cw * bx / 4, ch * by / 8,
                                dlg, (HMENU)(UINT_PTR)(id & 0xFFFF), NULL, NULL);
        if (c && !firstTab && (style & WS_TABSTOP)) firstTab = c;
        free(text);
    }
    /* WM_INITDIALOG returning FALSE means "I set focus myself" (0211) */
    BOOL wantFocus = TRUE;
    if (proc) wantFocus = (BOOL)proc(dlg, WM_INITDIALOG, (WPARAM)firstTab, param);
    if (firstTab && wantFocus) SetFocus(firstTab);
    InvalidateRect(dlg, NULL, TRUE);
    return dlg;
}

BOOL EndDialog(HWND dlg, INT_PTR result) {
    if (!dlg || !dlg->ctl || !dlg->cls || !ci_eq(dlg->cls->name, "#32770")) return FALSE;
    DlgState *st = (DlgState *)dlg->ctl;
    st->ended = 1;
    st->result = result;
    if (!st->modal) DestroyWindow(dlg);          /* modeless: gone at once */
    return TRUE;
}

INT_PTR DialogBoxParamW(HINSTANCE inst, LPCWSTR tmpl, HWND owner,
                        DLGPROC proc, LPARAM param) {
    HWND dlg = dlg_create(inst, tmpl, owner, proc, param, 1);
    if (!dlg) return -1;
    DlgState *st = (DlgState *)dlg->ctl;
    HWND ownerTop = owner ? owner->top : NULL;
    int reenable = 0;
    if (ownerTop && ownerTop->enabled) {
        EnableWindow(ownerTop, FALSE);
        reenable = 1;
    }
    MSG m;
    memset(&m, 0, sizeof m);
    while (!st->ended && IsWindow(dlg) && GetMessage(&m, NULL, 0, 0)) {
        if (IsDialogMessageW(dlg, &m)) continue;   /* Tab/Enter/Esc/mnemonic (0104) */
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (!st->ended && m.message == WM_QUIT)
        PostQuitMessage((int)m.wParam);          /* raced: re-post for the outer loop */
    INT_PTR result = st->result;
    if (reenable && IsWindow(ownerTop)) EnableWindow(ownerTop, TRUE);
    if (IsWindow(dlg)) DestroyWindow(dlg);       /* frees st */
    return result;
}

HWND CreateDialogParamW(HINSTANCE inst, LPCWSTR tmpl, HWND owner,
                        DLGPROC proc, LPARAM param) {
    return dlg_create(inst, tmpl, owner, proc, param, 0);
}

/* ---- dialog item helpers (charset-neutral where the payload is) ---- */

UINT GetDlgItemTextW(HWND dlg, int id, LPWSTR buf, int max) {
    if (buf && max > 0) buf[0] = 0;
    HWND c = GetDlgItem(dlg, id);
    if (!c || !buf || max < 1) return 0;
    return (UINT)SendMessageW(c, WM_GETTEXT, (WPARAM)max, (LPARAM)buf);
}

BOOL SetDlgItemTextW(HWND dlg, int id, LPCWSTR text) {
    HWND c = GetDlgItem(dlg, id);
    if (!c) return FALSE;
    SendMessageW(c, WM_SETTEXT, 0, (LPARAM)text);
    return TRUE;
}

BOOL SetDlgItemInt(HWND dlg, int id, UINT value, BOOL signed_) {
    HWND c = GetDlgItem(dlg, id);
    if (!c) return FALSE;
    char buf[16];
    if (signed_) snprintf(buf, sizeof buf, "%d", (int)value);
    else snprintf(buf, sizeof buf, "%u", value);
    SendMessage(c, WM_SETTEXT, 0, (LPARAM)buf);
    return TRUE;
}

UINT GetDlgItemInt(HWND dlg, int id, BOOL *translated, BOOL signed_) {
    if (translated) *translated = FALSE;
    HWND c = GetDlgItem(dlg, id);
    if (!c) return 0;
    char buf[32];
    if (SendMessage(c, WM_GETTEXT, sizeof buf, (LPARAM)buf) < 1) return 0;
    char *endp;
    long v = strtol(buf, &endp, 10);
    if (endp == buf) return 0;
    if (translated) *translated = TRUE;
    return signed_ ? (UINT)(int)v : (UINT)v;
}

LRESULT SendDlgItemMessageW(HWND dlg, int id, UINT msg, WPARAM wp, LPARAM lp) {
    HWND c = GetDlgItem(dlg, id);
    return c ? SendMessageW(c, msg, wp, lp) : 0;
}

BOOL CheckDlgButton(HWND dlg, int id, UINT check) {
    HWND c = GetDlgItem(dlg, id);
    if (!c) return FALSE;
    SendMessage(c, BM_SETCHECK, check, 0);
    return TRUE;
}

UINT IsDlgButtonChecked(HWND dlg, int id) {
    HWND c = GetDlgItem(dlg, id);
    return c ? (UINT)SendMessage(c, BM_GETCHECK, 0, 0) : 0;
}

BOOL CheckRadioButton(HWND dlg, int first, int last, int check) {
    for (int i = first; i <= last; i++) {
        HWND c = GetDlgItem(dlg, i);
        if (c) SendMessage(c, BM_SETCHECK, i == check, 0);
    }
    return TRUE;
}

/* ============================================================ W wrappers
 * (0068): the queue/message APIs carry no text — aliases; the text APIs
 * ride the send_msg translation. */

BOOL GetMessageW(MSG *m, HWND hf, UINT mn, UINT mx) { return GetMessage(m, hf, mn, mx); }
BOOL PeekMessageW(MSG *m, HWND hf, UINT mn, UINT mx, UINT remove) { return PeekMessage(m, hf, mn, mx, remove); }
LRESULT DispatchMessageW(const MSG *m) { return DispatchMessage(m); }

int GetWindowTextW(HWND h, LPWSTR buf, int max) {
    if (!h || !buf || max < 1) return 0;
    return (int)SendMessageW(h, WM_GETTEXT, (WPARAM)max, (LPARAM)buf);
}

BOOL SetWindowTextW(HWND h, LPCWSTR text) {
    if (!h) return FALSE;
    SendMessageW(h, WM_SETTEXT, 0, (LPARAM)text);
    return TRUE;
}

int GetWindowTextLengthW(HWND h) {
    return h ? (int)SendMessage(h, WM_GETTEXTLENGTH, 0, 0) : 0;
}

LONG_PTR GetWindowLongPtrW(HWND h, int index) { return GetWindowLongPtr(h, index); }
LONG_PTR SetWindowLongPtrW(HWND h, int index, LONG_PTR value) { return SetWindowLongPtr(h, index, value); }

int MessageBoxW(HWND owner, LPCWSTR text, LPCWSTR caption, UINT type) {
    char *t = w2a_dup(text), *c = w2a_dup(caption);
    int r = MessageBox(owner, t, c, type);
    free(t);
    free(c);
    return r;
}

int GetClassNameW(HWND h, LPWSTR buf, int max) {
    if (!h || !buf || max < 1) return 0;
    return a2w_trunc(h->cls ? h->cls->name : "", buf, max);
}

/* ============================================================ misc (0068) */

int GetSystemMetrics(int index) {
    switch (index) {
    /* SYNTHETIC screen numbers: a process can't see the real screen (the
     * WM can — EV_SCREEN); these exist so ports' clamping math runs. */
    case SM_CXSCREEN: return 800;
    case SM_CYSCREEN: return 500;
    case SM_CXFULLSCREEN: return 800;
    case SM_CYFULLSCREEN: return 480;
    case SM_CYCAPTION: return 20;
    case SM_CYMENU: return MENU_BAR_H;
    case SM_CXBORDER: case SM_CYBORDER: return 1;
    case SM_CXVSCROLL: case SM_CYHSCROLL:
    case SM_CYVSCROLL: case SM_CXHSCROLL: return 16;
    case SM_CXICON: case SM_CYICON: return 32;
    case SM_CXSMICON: case SM_CYSMICON: return 16;
    }
    return 0;
}

/* The synthetic single monitor: work area == screen (the taskbar is the
 * WM's business, invisible to processes). */
HMONITOR MonitorFromRect(const RECT *r, DWORD flags) { (void)r; (void)flags; return (HMONITOR)1; }
HMONITOR MonitorFromWindow(HWND h, DWORD flags) { (void)h; (void)flags; return (HMONITOR)1; }
HMONITOR MonitorFromPoint(POINT p, DWORD flags) { (void)p; (void)flags; return (HMONITOR)1; }

BOOL GetMonitorInfoW(HMONITOR mon, MONITORINFO *mi) {
    if (!mon || !mi) return FALSE;
    SetRect(&mi->rcMonitor, 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    mi->rcWork = mi->rcMonitor;
    mi->dwFlags = 1;                             /* MONITORINFOF_PRIMARY */
    return TRUE;
}

/* Caption/borders are KERNEL chrome (outside the surface) — only the
 * user32-drawn menu bar widens the window rect. */
BOOL AdjustWindowRect(RECT *r, DWORD style, BOOL menu) {
    (void)style;
    if (!r) return FALSE;
    if (menu) r->top -= MENU_BAR_H;
    return TRUE;
}

BOOL AdjustWindowRectEx(RECT *r, DWORD style, BOOL menu, DWORD exStyle) {
    (void)exStyle;
    return AdjustWindowRect(r, style, menu);
}

BOOL RedrawWindow(HWND h, const RECT *r, HRGN rgn, UINT flags) {
    (void)rgn;
    if (!h) return FALSE;
    if (flags & RDW_INVALIDATE) InvalidateRect(h, r, (flags & RDW_ERASE) != 0);
    if (flags & (RDW_UPDATENOW | RDW_ERASENOW)) UpdateWindow(h);
    return TRUE;
}

/* ============================================================ misc (0048,
 * notepad's tail) */

/* Registered window messages: name -> a stable id in the 0xC000 atom
 * range. Per-PROCESS here (Windows registers system-wide) — enough for
 * the comdlg32 FindText protocol, where both ends are this process. */
UINT RegisterWindowMessageW(LPCWSTR name) {
    static char *names[32];
    static int n;
    char *a = w2a_dup(name);
    if (!a || !a[0]) { free(a); return 0; }
    for (int i = 0; i < n; i++)
        if (strcmp(names[i], a) == 0) { free(a); return 0xC000 + (UINT)i; }
    if (n >= 32) { free(a); return 0; }
    names[n] = a;
    return 0xC000 + (UINT)n++;
}

/* Window placement: rcNormalPosition is the SURFACE-space client rect
 * (position is the WM's; size round-trips through MoveWindow's owner
 * resize). showCmd is always SW_SHOWNORMAL — minimize state lives in the
 * WM, invisible to processes. */
BOOL GetWindowPlacement(HWND hwnd, WINDOWPLACEMENT *wp) {
    if (!hwnd || !wp) return FALSE;
    RECT r;
    if (!GetClientRect(hwnd->top, &r)) return FALSE;
    memset(wp, 0, sizeof *wp);
    wp->length = sizeof *wp;
    wp->showCmd = SW_SHOWNORMAL;
    wp->rcNormalPosition = r;
    return TRUE;
}

BOOL SetWindowPlacement(HWND hwnd, const WINDOWPLACEMENT *wp) {
    if (!hwnd || !wp) return FALSE;
    int w = wp->rcNormalPosition.right - wp->rcNormalPosition.left;
    int h = wp->rcNormalPosition.bottom - wp->rcNormalPosition.top;
    if (w > 0 && h > 0)
        MoveWindow(hwnd, wp->rcNormalPosition.left, wp->rcNormalPosition.top,
                   w, h, TRUE);
    return TRUE;
}

/* Dialog keyboard pre-translation (0104): Tab/Shift+Tab walk WS_TABSTOP
 * controls, Alt+mnemonic jumps/presses, Enter fires the default (or a
 * focused pushbutton, or a newline in a multiline edit), Esc = IDCANCEL,
 * arrows move within a radio group. Controls answer WM_GETDLGCODE so the
 * routing works for app custom controls too. Wired into both modal loops
 * (DialogBoxParamW/MessageBox) and callable from an app's own pump. */
BOOL IsDialogMessageW(HWND dlg, MSG *msg) {
    if (!dlg || !msg || !IsWindow(dlg)) return FALSE;
    if (msg->hwnd == NULL || msg->hwnd->top != dlg->top) return FALSE;
    if (msg->message != WM_KEYDOWN) return FALSE;
    int vk = (int)msg->wParam;
    HWND focus = dlg->top->focus;

    /* Alt+letter/digit: a control mnemonic. */
    if ((GetKeyState(VK_MENU) & 0x8000) &&
        ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9'))) {
        HWND m = dlg_find_mnemonic(dlg, vk);
        if (m) { dlg_do_mnemonic(dlg, m); return TRUE; }
        return FALSE;
    }

    LRESULT code = focus ? SendMessage(focus, WM_GETDLGCODE, (WPARAM)vk, (LPARAM)msg) : 0;

    switch (vk) {
    case VK_TAB: {
        HWND next = GetNextDlgTabItem(dlg, focus, (GetKeyState(VK_SHIFT) & 0x8000) != 0);
        if (next) SetFocus(next);
        return TRUE;
    }
    case VK_RETURN:
        if (code & DLGC_WANTALLKEYS) return FALSE;   /* multiline edit takes it */
        if (code & (DLGC_DEFPUSHBUTTON | DLGC_UNDEFPUSHBUTTON)) {
            SendMessage(focus, BM_CLICK, 0, 0);      /* the focused push button */
            return TRUE;
        }
        {
            int def = dlg_default_id(dlg);
            HWND b = def ? GetDlgItem(dlg, def) : NULL;
            if (b) { SendMessage(b, BM_CLICK, 0, 0); return TRUE; }
            if (def) {
                SendMessage(dlg, WM_COMMAND, MAKEWPARAM(def, BN_CLICKED), 0);
                return TRUE;
            }
        }
        return FALSE;
    case VK_ESCAPE: {
        int id = GetDlgItem(dlg, IDCANCEL) ? IDCANCEL
               : (GetDlgItem(dlg, IDOK) ? IDOK : 0);
        if (id)
            SendMessage(dlg, WM_COMMAND, MAKEWPARAM(id, BN_CLICKED),
                        (LPARAM)GetDlgItem(dlg, id));
        else
            SendMessage(dlg, WM_CLOSE, 0, 0);        /* no cancel: the legacy path */
        return TRUE;
    }
    case VK_LEFT: case VK_UP:
    case VK_RIGHT: case VK_DOWN:
        if (focus && (code & DLGC_RADIOBUTTON)) {    /* radio-group arrows */
            HWND g = GetNextDlgGroupItem(dlg, focus, vk == VK_LEFT || vk == VK_UP);
            if (g && g != focus) {
                SetFocus(g);
                SendMessage(g, BM_CLICK, 0, 0);      /* auto-radio checks it */
            }
            return TRUE;
        }
        return FALSE;
    }
    return FALSE;
}

BOOL SetProcessDefaultLayout(DWORD layout) {
    (void)layout;                                /* LTR is the only layout */
    return TRUE;
}

BOOL WinHelpW(HWND hwnd, LPCWSTR file, UINT cmd, ULONG_PTR data) {
    (void)hwnd; (void)file; (void)cmd; (void)data;
    return FALSE;                                /* no .hlp viewer exists */
}

/* ============================================================ frame-control
 * drawing (0048, calc's owner-drawn keypad): the classic 3D looks over the
 * controls section's draw_raised. Every DFC type draws as a button face —
 * the corpus only asks for DFC_BUTTON. */

BOOL DrawFrameControl(HDC dc, RECT *r, UINT type, UINT state) {
    (void)type;
    if (!dc || !r) return FALSE;
    FillRect(dc, r, GetSysColorBrush(COLOR_BTNFACE));
    draw_raised(dc, *r, (state & DFCS_PUSHED) != 0);
    return TRUE;
}

BOOL DrawStateW(HDC dc, HBRUSH brush, DRAWSTATEPROC cb, LPARAM ldata,
                WPARAM wdata, int x, int y, int cx, int cy, UINT flags) {
    (void)brush; (void)cb; (void)wdata; (void)cx; (void)cy;
    if (!dc) return FALSE;
    if ((flags & 0x7) != DST_TEXT || !ldata) return FALSE;   /* text flavor only */
    char *t = w2a_dup((LPCWSTR)ldata);
    if (!t) return FALSE;
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, GetSysColor((flags & DSS_DISABLED) ? COLOR_GRAYTEXT : COLOR_BTNTEXT));
    TextOut(dc, x, y, t, (int)strlen(t));
    free(t);
    return TRUE;
}
