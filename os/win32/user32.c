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
 * __sdl_pump_wait host import, which drains the kernel input ring into
 * the SDL event queue in place and Atomics.waits on the ring until the
 * kernel's push notifies (kernel.js _wmPushEvent). Message priority is
 * Windows': posted messages first, WM_PAINT only when the queue is dry,
 * WM_QUIT after everything.
 *
 * The agent tree (OS.md's agent-target pillar): the first CreateWindowEx
 * binds /run/win32/agent.<pid>.sock (wm_agent.h) and the GetMessage idle
 * loop serves it — AQ_TREE dumps the HWND tree, AQ_CLICK presses a
 * window resolved BY LABEL (BM_CLICK for buttons, a synthetic client-
 * center click otherwise), AQ_GETTEXT/AQ_SETTEXT read/write WM_GETTEXT
 * text. `wmctl click "OK"` needs no pixel coordinates, ever.
 *
 * Deliberate 0058 simplifications (grow under 0060's missing-symbol log):
 *   - single-threaded by design (WIN32.md friction #1) — one queue, no
 *     PostThreadMessage; SendMessage is a direct call
 *   - invalidation is whole-window (rcPaint = the client rect)
 *   - no SetTimer/WM_TIMER (no caret blink — the caret is solid), no
 *     clipboard, no menus/accelerators/DialogBox templates (MessageBox
 *     is the modal dialog), no Tab-order navigation (IsDialogMessage)
 *   - hidden top-levels: ShowWindow(SW_HIDE) on a top-level is a no-op
 *     (the kernel surface has no hide op; minimize is the WM's)
 *   - WM_CLOSE from the kernel (title-bar 'x' / wmctl close) lands on
 *     the FIRST live top-level: the ring's QUIT record is process-wide
 *   - VK mapping covers letters/digits/named keys; punctuation VKs are
 *     approximate (WM_CHAR carries the real character — SDL3 keysyms
 *     are modifier-applied, so TranslateMessage is a table-free map)
 */

#include <windows.h>
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

/* ============================================================ classes */

#define MAX_CLASSES 64

typedef struct {
    char name[64];
    WNDPROC proc;
    UINT style;
    HBRUSH bg;
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

static ATOM class_add(const char *name, WNDPROC proc, UINT style, HBRUSH bg) {
    if (!name || !proc || class_find(name)) return 0;
    for (int i = 0; i < MAX_CLASSES; i++) {
        if (!g_classes[i].used) {
            Class *c = &g_classes[i];
            strncpy(c->name, name, sizeof c->name - 1);
            c->name[sizeof c->name - 1] = 0;
            c->proc = proc;
            c->style = style;
            c->bg = bg;
            c->used = 1;
            return (ATOM)(i + 1);
        }
    }
    return 0;
}

ATOM RegisterClass(const WNDCLASS *wc) {
    if (!wc) return 0;
    return class_add(wc->lpszClassName, wc->lpfnWndProc, wc->style, wc->hbrBackground);
}

ATOM RegisterClassEx(const WNDCLASSEX *wc) {
    if (!wc) return 0;
    return class_add(wc->lpszClassName, wc->lpfnWndProc, wc->style, wc->hbrBackground);
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
    int visible, enabled;
    int needPaint;
    int inDestroy;
    LONG_PTR userdata;
    void *ctl;                  /* control state (edit/listbox/scrollbar) */
};

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
    int cw = is_top(h) ? s->w : h->w;
    int ch = is_top(h) ? s->h : h->h;
    if (ox + cw > s->w) cw = s->w - ox;
    if (oy + ch > s->h) ch = s->h - oy;
    if (ox < 0 || oy < 0 || cw < 1 || ch < 1)
        return __gdi_dc_wrap(g_scratchPx, 1, 1, 1);
    int stride = s->pitch / 4;
    return __gdi_dc_wrap((uint32_t *)s->pixels + oy * stride + ox, cw, ch, stride);
}

int ReleaseDC(HWND h, HDC dc) {
    if (!h || !dc) return 0;
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
        SetRect(r, 0, 0, s->w, s->h);
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

LRESULT SendMessage(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (!h) return 0;
    return CallWindowProc(h->proc, h, msg, wp, lp);
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

static void route_mouse(HWND top, UINT downMsg, int btnIdx, float fx, float fy,
                        int clicks, Uint32 state) {
    int x = (int)fx, y = (int)fy;
    g_lastPt.x = x;
    g_lastPt.y = y;
    g_activeTop = top;
    HWND target = g_capture ? g_capture : hit_test(top, x, y);
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
            q_push(top, WM_SIZE, SIZE_RESTORED,
                   MAKELPARAM(e.window.data1, e.window.data2), 0);
            InvalidateRect(top, NULL, TRUE);
            break;
        }
        case SDL_EVENT_QUIT: {
            /* Process-wide close (title-bar 'x' / wmctl close): route
             * WM_CLOSE to the first live top-level. */
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

typedef struct { const char *label; const char *cls; int idx, count; HWND found; int wantButton; } Find;

static void find_walk(HWND h, Find *f) {
    if (f->found) return;
    if (f->cls) {
        if (h->cls && ci_eq(h->cls->name, f->cls)) {
            if (f->count == f->idx) { f->found = h; return; }
            f->count++;
        }
    } else if (hwnd_shown(h)) {
        int isBtn = h->cls && ci_eq(h->cls->name, "BUTTON");
        if (!f->wantButton || isBtn) {
            char stripped[256];
            strip_amp(text_get(h), stripped, sizeof stripped);
            if (strcmp(stripped, f->label) == 0) { f->found = h; return; }
        }
    }
    for (HWND c = h->child; c; c = c->next) find_walk(c, f);
}

static HWND agent_find(const char *label) {
    Find f;
    memset(&f, 0, sizeof f);
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
        aq_send(cfd, AQ_R_TEXT, sb.buf ? sb.buf : "", (uint32_t)sb.len);
        free(sb.buf);
        break;
    }
    case AQ_CLICK: {
        HWND h = agent_find(payload);
        if (!h || !hwnd_shown(h) || !hwnd_able(h)) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
        if (h->cls && ci_eq(h->cls->name, "BUTTON")) {
            PostMessage(h, BM_CLICK, 0, 0);
        } else {
            LPARAM at = MAKELPARAM(h->w / 2, h->h / 2);
            PostMessage(h, WM_LBUTTONDOWN, MK_LBUTTON, at);
            PostMessage(h, WM_LBUTTONUP, 0, at);
        }
        aq_send(cfd, AQ_R_OK, NULL, 0);
        break;
    }
    case AQ_GETTEXT: {
        HWND h = agent_find(payload);
        if (!h) { aq_send(cfd, AQ_R_ERR, NULL, 0); break; }
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
        __sdl_pump_wait(0);                      /* ring -> SDL event queue */
        pump_sdl();                              /* SDL queue -> message queue */
        agent_poll();
        if (q_get(out, hf, mn, mx, 1))
            return out->message != WM_QUIT ? TRUE : FALSE;
        if (paint_scan(out, hf, mn, mx)) return TRUE;
        if (g_quitPosted) {
            memset(out, 0, sizeof *out);
            out->message = WM_QUIT;
            out->wParam = (WPARAM)g_quitCode;
            g_quitPosted = 0;
            return FALSE;
        }
        /* Park: instant wake on kernel input (ring notify); the 25ms
         * ceiling bounds agent-socket latency. Before the first window
         * there is no ring — pace on a kernel timer instead. */
        if (!__sdl_pump_wait(25)) sleep_ms(10);
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

HWND CreateWindowEx(DWORD exStyle, LPCSTR className, LPCSTR windowName,
                    DWORD style, int x, int y, int w, int h,
                    HWND parent, HMENU menu, HINSTANCE inst, LPVOID param) {
    ensure_builtin_classes();
    Class *cls = class_find(className);
    if (!cls) return NULL;
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
    cs.lpszName = windowName;
    cs.lpszClass = className;
    cs.dwExStyle = exStyle;
    if ((int)SendMessage(hw, WM_CREATE, 0, (LPARAM)&cs) == -1) {
        DestroyWindow(hw);
        return NULL;
    }
    SendMessage(hw, WM_SIZE, SIZE_RESTORED, MAKELPARAM(w, h));
    SendMessage(hw, WM_MOVE, 0, MAKELPARAM(x, y));
    if (hw->visible) InvalidateRect(hw, NULL, TRUE);
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
    switch (msg) {
    case WM_CLOSE:
        DestroyWindow(h);
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

/* ============================================================ show/paint */

BOOL ShowWindow(HWND h, int cmd) {
    if (!h) return FALSE;
    BOOL was = h->visible;
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
    if (!h || is_top(h)) return FALSE;           /* kernel owns top geometry */
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
    if (!h) return NULL;
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
        TextOut(dc, 10, 0, label, (int)strlen(label));
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
        TextOut(dc, 18, (h->h - 14) / 2, label, (int)strlen(label));
    } else {                                     /* push button */
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, r, st->pressed);
        SIZE sz;
        GetTextExtentPoint32(dc, label, (int)strlen(label), &sz);
        int tx = (h->w - sz.cx) / 2 + (st->pressed ? 1 : 0);
        int ty = (h->h - sz.cy) / 2 + (st->pressed ? 1 : 0);
        TextOut(dc, tx, ty, label, (int)strlen(label));
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
            for (HWND c = h->parent->child; c; c = c->next)
                if (c != h && c->cls == h->cls && btn_kind(c) == BS_AUTORADIOBUTTON &&
                    c->ctl && ((BtnState *)c->ctl)->check) {
                    ((BtnState *)c->ctl)->check = 0;
                    InvalidateRect(c, NULL, TRUE);
                }
        }
        st->check = 1;
        InvalidateRect(h, NULL, TRUE);
    }
    if (h->parent)
        SendMessage(h->parent, WM_COMMAND, MAKEWPARAM(h->id, BN_CLICKED), (LPARAM)h);
}

static LRESULT btn_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    BtnState *st = (BtnState *)h->ctl;
    switch (msg) {
    case WM_CREATE:
        h->ctl = calloc(1, sizeof(BtnState));
        return h->ctl ? 0 : -1;
    case WM_PAINT:
        btn_paint(h);
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
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, GetSysColor(hwnd_able(h) ? COLOR_WINDOWTEXT : COLOR_GRAYTEXT));
        UINT fmt = DT_LEFT;
        if ((h->style & 0x3) == SS_CENTER) fmt = DT_CENTER;
        else if ((h->style & 0x3) == SS_RIGHT) fmt = DT_RIGHT;
        DrawText(dc, text_get(h), -1, &r, fmt);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_SETTEXT: {
        LRESULT r = DefWindowProc(h, msg, wp, lp);
        InvalidateRect(h, NULL, TRUE);
        return r;
    }
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
} EditState;

#define EDIT_PAD 3

static int edit_ml(HWND h) { return (h->style & ES_MULTILINE) != 0; }
static int edit_ro(HWND h) { return (h->style & ES_READONLY) != 0; }

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
    memcpy(st->buf + st->caret, s, (size_t)n);
    st->len += n;
    st->caret += n;
    st->anchor = st->caret;
    (void)h;
}

/* Keep the caret in view: multiline scrolls topLine, single-line scrollX. */
static void edit_show_caret(HWND h, EditState *st) {
    int lh = edit_line_h(h);
    if (edit_ml(h)) {
        int line, col;
        edit_line_of(st, st->caret, &line, &col);
        int rows = (h->h - 2 * EDIT_PAD - 4) / (lh > 0 ? lh : 1);
        if (rows < 1) rows = 1;
        if (line < st->topLine) st->topLine = line;
        if (line >= st->topLine + rows) st->topLine = line - rows + 1;
    } else {
        HDC dc = GetDC(h);
        if (!dc) return;
        int cx = edit_x_of(h, st, dc, 0, st->caret);
        __gdi_dc_unwrap(dc);
        int vw = h->w - 2 * EDIT_PAD - 4;
        if (cx - st->scrollX > vw - 2) st->scrollX = cx - vw + 2;
        if (cx - st->scrollX < 0) st->scrollX = cx;
        if (st->scrollX < 0) st->scrollX = 0;
    }
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
    IntersectClipRect(dc, 2, 2, h->w - 2, h->h - 2);
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
            int x = EDIT_PAD - (edit_ml(h) ? 0 : st->scrollX);
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
    int x = EDIT_PAD - (edit_ml(h) ? 0 : st->scrollX);
    int pos = start;
    while (pos < end) {
        int nx = x + edit_x_of(h, st, dc, start, pos + 1);
        int cx = x + edit_x_of(h, st, dc, start, pos);
        if (px < (cx + nx) / 2) break;
        pos++;
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
        if (n && edit_ensure(st, n + 1)) {
            memcpy(st->buf, t, (size_t)n);
            st->len = n;
        }
        return 0;
    }
    case WM_PAINT:
        edit_paint(h);
        return 0;
    case WM_GETDLGCODE:
        return 4 /* DLGC_WANTCHARS-ish */;
    case WM_LBUTTONDOWN: {
        SetFocus(h);
        SetCapture(h);
        int pos = edit_hit(h, st, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
        st->caret = pos;
        if (!(GetKeyState(VK_SHIFT) & 0x8000)) st->anchor = pos;
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    }
    case WM_MOUSEMOVE:
        if (GetCapture() == h && (wp & MK_LBUTTON)) {
            st->caret = edit_hit(h, st, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
            edit_show_caret(h, st);
            InvalidateRect(h, NULL, TRUE);
        }
        return 0;
    case WM_LBUTTONUP:
        if (GetCapture() == h) ReleaseCapture();
        return 0;
    case WM_CHAR: {
        if (edit_ro(h)) return 0;
        int ch = (int)wp;
        if (ch == 8) {                           /* backspace */
            int s, e;
            edit_sel(st, &s, &e);
            if (s == e && st->caret > 0) st->anchor = st->caret - 1;
            edit_del_sel(st);
        } else if (ch == '\r' || ch == '\n') {
            if (!edit_ml(h)) return 0;
            edit_insert(h, st, "\n", 1);
        } else if (ch == 9 && edit_ml(h)) {
            edit_insert(h, st, "\t", 1);
        } else if (ch >= 32 && ch < 127) {
            char c = (char)ch;
            edit_insert(h, st, &c, 1);
        } else {
            return 0;
        }
        edit_show_caret(h, st);
        InvalidateRect(h, NULL, TRUE);
        edit_notify(h, EN_CHANGE);
        return 0;
    }
    case WM_KEYDOWN: {
        int extend = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
        int oldCaret = st->caret;
        switch (wp) {
        case VK_LEFT:
            if (st->caret > 0) st->caret--;
            break;
        case VK_RIGHT:
            if (st->caret < st->len) st->caret++;
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
            break;
        }
        case VK_DELETE: {
            if (edit_ro(h)) return 0;
            int s, e;
            edit_sel(st, &s, &e);
            if (s == e && st->caret < st->len) st->anchor = st->caret + 1;
            edit_del_sel(st);
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
    case EM_SETREADONLY:
        if (wp) h->style |= ES_READONLY; else h->style &= ~ES_READONLY;
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    case WM_SETTEXT: {
        const char *t = lp ? (const char *)lp : "";
        int n = (int)strlen(t);
        if (!edit_ensure(st, n + 1)) return FALSE;
        memcpy(st->buf, t, (size_t)n);
        st->len = n;
        st->caret = st->anchor = n;
        st->topLine = st->scrollX = 0;
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
        if (st) { free(st->buf); st->buf = NULL; }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- LISTBOX ---- */

typedef struct {
    char **items;
    int n, cap;
    int sel;                    /* -1 = none */
    int top;                    /* first visible row */
} LbState;

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
            if (i == st->sel) {
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
            st->sel = idx;
            InvalidateRect(h, NULL, TRUE);
            if (changed) lb_notify(h, LBN_SELCHANGE);
            if (msg == WM_LBUTTONDBLCLK) lb_notify(h, LBN_DBLCLK);
        }
        return 0;
    }
    case WM_KEYDOWN: {
        int old = st->sel;
        if (wp == VK_UP && st->sel > 0) st->sel--;
        else if (wp == VK_DOWN && st->sel < st->n - 1) st->sel++;
        else if (wp == VK_HOME && st->n) st->sel = 0;
        else if (wp == VK_END && st->n) st->sel = st->n - 1;
        else return 0;
        if (st->sel != old) {
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
            st->cap = nc;
        }
        size_t n = strlen(s);
        char *copy = (char *)malloc(n + 1);
        if (!copy) return LB_ERR;
        memcpy(copy, s, n + 1);
        st->items[st->n] = copy;
        InvalidateRect(h, NULL, TRUE);
        return st->n++;
    }
    case LB_DELETESTRING: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return LB_ERR;
        free(st->items[i]);
        memmove(&st->items[i], &st->items[i + 1],
                (size_t)(st->n - i - 1) * sizeof(char *));
        st->n--;
        if (st->sel == i) st->sel = -1;
        else if (st->sel > i) st->sel--;
        InvalidateRect(h, NULL, TRUE);
        return st->n;
    }
    case LB_RESETCONTENT:
        for (int i = 0; i < st->n; i++) free(st->items[i]);
        st->n = 0;
        st->sel = -1;
        st->top = 0;
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case LB_GETCOUNT:
        return st->n;
    case LB_GETCURSEL:
        return st->sel < 0 ? LB_ERR : st->sel;
    case LB_SETCURSEL: {
        int i = (int)wp;
        if (i != -1 && (i < 0 || i >= st->n)) return LB_ERR;
        st->sel = i;
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
            n += snprintf(out + n, (size_t)(cap - n), "%s%s\n",
                          i == st->sel ? "> " : "", st->items[i]);
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
            st->items = NULL;
            st->n = 0;
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---- SCROLLBAR (SBS_VERT / SBS_HORZ; SB_CTL only) ---- */

typedef struct {
    int min, max, pos;
    int dragging, dragOff;
    int dragPos;                /* thumb position while dragging (visual) */
} SbState;

static int sb_vert(HWND h) { return (h->style & 1) == SBS_VERT; }

/* Geometry: [arrow][channel with thumb][arrow]; the thumb is a square. */
static void sb_geom(HWND h, SbState *st, int *btn, int *track, int *thumbPos) {
    int len = sb_vert(h) ? h->h : h->w;
    int b = sb_vert(h) ? h->w : h->h;
    if (b * 2 > len) b = len / 2;
    *btn = b;
    *track = len - 2 * b - b;                    /* travel of the thumb's top */
    if (*track < 0) *track = 0;
    int range = st->max - st->min;
    int pos = st->dragging ? st->dragPos : st->pos;
    *thumbPos = b + (range > 0 ? (pos - st->min) * *track / range : 0);
}

static int sb_pos_of(HWND h, SbState *st, int pix) {
    int btn, track, tp;
    sb_geom(h, st, &btn, &track, &tp);
    int range = st->max - st->min;
    if (track <= 0 || range <= 0) return st->min;
    int p = st->min + (pix - btn) * range / track;
    if (p < st->min) p = st->min;
    if (p > st->max) p = st->max;
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
        int btn, track, tp;
        sb_geom(h, st, &btn, &track, &tp);
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
        if (v) SetRect(&th, 0, tp, h->w, tp + btn);
        else SetRect(&th, tp, 0, tp + btn, h->h);
        FillRect(dc, &th, GetSysColorBrush(COLOR_BTNFACE));
        draw_raised(dc, th, 0);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int v = sb_vert(h);
        int p = v ? GET_Y_LPARAM(lp) : GET_X_LPARAM(lp);
        int len = v ? h->h : h->w;
        int btn, track, tp;
        sb_geom(h, st, &btn, &track, &tp);
        /* Windows semantics: the control only NOTIFIES — the app moves
         * the position (SetScrollPos) in its WM_VSCROLL handler. */
        if (p < btn) {
            sb_notify(h, SB_LINEUP, 0);
        } else if (p >= len - btn) {
            sb_notify(h, SB_LINEDOWN, 0);
        } else if (p >= tp && p < tp + btn) {
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

int SetScrollPos(HWND h, int bar, int pos, BOOL redraw) {
    (void)bar;
    if (!h || !h->ctl) return 0;
    SbState *st = (SbState *)h->ctl;
    int old = st->pos;
    if (pos < st->min) pos = st->min;
    if (pos > st->max) pos = st->max;
    st->pos = pos;
    if (redraw) InvalidateRect(h, NULL, TRUE);
    return old;
}

int GetScrollPos(HWND h, int bar) {
    (void)bar;
    return h && h->ctl ? ((SbState *)h->ctl)->pos : 0;
}

BOOL SetScrollRange(HWND h, int bar, int min, int max, BOOL redraw) {
    (void)bar;
    if (!h || !h->ctl || min > max) return FALSE;
    SbState *st = (SbState *)h->ctl;
    st->min = min;
    st->max = max;
    if (st->pos < min) st->pos = min;
    if (st->pos > max) st->pos = max;
    if (redraw) InvalidateRect(h, NULL, TRUE);
    return TRUE;
}

BOOL GetScrollRange(HWND h, int bar, LPINT min, LPINT max) {
    (void)bar;
    if (!h || !h->ctl) return FALSE;
    if (min) *min = ((SbState *)h->ctl)->min;
    if (max) *max = ((SbState *)h->ctl)->max;
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

/* ============================================================ MessageBox
 * The one modal dialog (DialogBox templates are 0060 growth): its own
 * top-level window + a STATIC + buttons, a nested message loop, and the
 * owner disabled for the duration — the Windows shape. */

static int g_mbResult;

static LRESULT mb_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
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

int MessageBox(HWND owner, LPCSTR text, LPCSTR caption, UINT type) {
    ensure_builtin_classes();
    if (!class_find("#32770"))
        class_add("#32770", mb_proc, 0, (HBRUSH)(COLOR_BTNFACE + 1));

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
    int nBtn = (type & MB_OKCANCEL) ? 2 : (type & MB_YESNO) ? 2 : 1;
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
    if (type & MB_YESNO) {
        CreateWindowEx(0, "BUTTON", "Yes", WS_CHILD | WS_VISIBLE, bx, by, bw, 24,
                       box, (HMENU)IDYES, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "No", WS_CHILD | WS_VISIBLE, bx + bw + 10, by,
                       bw, 24, box, (HMENU)IDNO, NULL, NULL);
    } else if (type & MB_OKCANCEL) {
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE, bx, by, bw, 24,
                       box, (HMENU)IDOK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE, bx + bw + 10,
                       by, bw, 24, box, (HMENU)IDCANCEL, NULL, NULL);
    } else {
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE, bx, by, bw, 24,
                       box, (HMENU)IDOK, NULL, NULL);
    }

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
        result = (type & MB_YESNO) ? IDNO : (type & MB_OKCANCEL) ? IDCANCEL : IDOK;
    return result;
}
