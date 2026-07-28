/* comctl32.c — the common-controls veneer slice (todos/0048, design
 * todos/WIN32.md). Since todos/0370 comctl32 owns REAL classes:
 * InitCommonControls / InitCommonControlsEx(ICC_LISTVIEW_CLASSES) register
 * SysListView32 + SysHeader32 (listview.c, its own TU — the menucore.c
 * one-facility-per-TU precedent). The standard controls (BUTTON/EDIT/...)
 * stay user32's; calc's InitCommonControls call now registers the
 * listview classes too, which is exactly the real comctl32 contract.
 *
 * The STATUS BAR is the other control this slice owns (notepad's
 * Ln/Col + encoding + EOLN readout): a self-bottom-parking child strip
 * (WM_SIZE with any params re-parks it against the parent's client
 * bottom — notepad sends WM_SIZE 0,0 and then reads GetWindowRect for
 * the height), parts as sunken wells. Built over PUBLIC user32/gdi32
 * APIs only — state hangs off GWLP_USERDATA, no user32 internals.
 * Texts arrive as WCHAR (SB_SETTEXTW — the UNICODE corpus) and are
 * stored UTF-8; WM_GETTEXT joins the parts with ' | ' so `wmctl
 * gettext` reads the whole readout (the LISTBOX items convention). */

#undef UNICODE
#undef _UNICODE
#include "win32_internal.h"     /* __comctl_register_listview */
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void InitCommonControls(void) {                  /* the register-everything
                                                  * legacy entry */
    __comctl_register_listview();
}

BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *icc) {
    if (!icc || icc->dwSize != sizeof *icc) return FALSE;
    if (icc->dwICC & (ICC_LISTVIEW_CLASSES | ICC_WIN95_CLASSES))
        __comctl_register_listview();
    return TRUE;
}

/* ---- status bar ---- */

#define SB_VBORDER 2            /* Wine VERT_BORDER: breathing room above+below the wells */
#define SB_PARTS   16

typedef struct {
    int n;                      /* part count (0 = one implicit part) */
    int h;                      /* bar height, font-derived (0 = not yet computed) */
    int edges[SB_PARTS];        /* right edges; -1 = to the right border */
    char *text[SB_PARTS];
} SbarState;

static char *sb_w2a(LPCWSTR w) {                 /* malloc'd UTF-8 */
    if (!w) w = (LPCWSTR)u"";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *out = (char *)malloc(n > 0 ? (size_t)n : 1);
    if (!out) return NULL;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
    else out[0] = 0;
    return out;
}

/* Bar height from the DC's font, the Win95/Wine STATUSBAR_ComputeHeight
 * formula: tmHeight + max(tmInternalLeading, 2) + 2*SM_CYBORDER, plus the
 * vertical border — so the well interior fits a whole glyph cell for ANY
 * stock font (a hardcoded 20 was Win95 MS Sans Serif arithmetic; the 19px
 * stock cell here sat 3px low with its descenders clipped). Cached in
 * SbarState; a future WM_SETFONT honors it by zeroing st->h and re-parking. */
static int sb_height(HWND h, SbarState *st) {
    if (st && st->h) return st->h;
    int bar = 20;                                /* fontless fallback */
    HDC dc = GetDC(h);
    if (dc) {
        TEXTMETRIC tm;
        if (GetTextMetrics(dc, &tm)) {
            int lead = tm.tmInternalLeading > 2 ? tm.tmInternalLeading : 2;
            bar = tm.tmHeight + lead + 2 * GetSystemMetrics(SM_CYBORDER)
                  + SB_VBORDER;
        }
        ReleaseDC(h, dc);
    }
    if (st) st->h = bar;
    return bar;
}

static void sb_park(HWND h) {                    /* bottom of the parent client */
    HWND parent = GetParent(h);
    if (!parent) return;
    int bh = sb_height(h, (SbarState *)GetWindowLongPtr(h, GWLP_USERDATA));
    RECT pr;
    GetClientRect(parent, &pr);
    MoveWindow(h, 0, pr.bottom - bh, pr.right, bh, TRUE);
}

static LRESULT CALLBACK sbar_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    SbarState *st = (SbarState *)GetWindowLongPtr(h, GWLP_USERDATA);
    switch (msg) {
    case WM_CREATE:
        st = (SbarState *)calloc(1, sizeof(SbarState));
        if (!st) return -1;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)st);
        return 0;
    case WM_SIZE:
        /* real status bars re-park on ANY WM_SIZE — the universal port
         * idiom forwards the parent's real wParam/lParam (0211; notepad
         * happens to send 0,0) */
        sb_park(h);
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        RECT r;
        GetClientRect(h, &r);
        FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, GetSysColor(COLOR_BTNTEXT));
        int bh = sb_height(h, st);
        int n = st && st->n ? st->n : 1;
        int left = 0;
        for (int i = 0; i < n; i++) {
            int right = (st && st->n && st->edges[i] >= 0) ? st->edges[i] : r.right;
            if (right > r.right) right = r.right;
            RECT part;
            SetRect(&part, left, 2, right - 2, bh - 2);
            if (part.right > part.left + 2) {
                /* sunken well edge */
                HBRUSH sh = GetSysColorBrush(COLOR_BTNSHADOW);
                HBRUSH hi = GetSysColorBrush(COLOR_BTNHIGHLIGHT);
                RECT ln;
                SetRect(&ln, part.left, part.top, part.right, part.top + 1);
                FillRect(dc, &ln, sh);
                SetRect(&ln, part.left, part.top, part.left + 1, part.bottom);
                FillRect(dc, &ln, sh);
                SetRect(&ln, part.left, part.bottom - 1, part.right, part.bottom);
                FillRect(dc, &ln, hi);
                SetRect(&ln, part.right - 1, part.top, part.right, part.bottom);
                FillRect(dc, &ln, hi);
            }
            const char *t = st && st->text[i] ? st->text[i] : "";
            /* Center the text in the well and clip it to its own cell — a
             * readout wider than its part (e.g. "Windows (CR + LF)" in a
             * narrow window) must cut at the border, not bleed into the
             * next part (DrawText clips to its rect unless DT_NOCLIP). */
            RECT tr;
            SetRect(&tr, part.left + 6, part.top + 1,
                    part.right - 1, part.bottom - 1);
            DrawText(dc, t, -1, &tr,
                     DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX);
            left = right;
        }
        EndPaint(h, &ps);
        return 0;
    }
    case SB_SETPARTS: {
        int n = (int)wp;
        if (!st || n < 1 || n > SB_PARTS || !lp) return FALSE;
        st->n = n;
        const int *edges = (const int *)lp;
        for (int i = 0; i < n; i++) st->edges[i] = edges[i];
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case SB_SETTEXTA:
    case SB_SETTEXTW: {
        int i = (int)(wp & 0xFF);
        if (!st || i < 0 || i >= SB_PARTS) return FALSE;
        free(st->text[i]);
        st->text[i] = msg == SB_SETTEXTW ? sb_w2a((LPCWSTR)lp)
                                         : (lp ? strdup((const char *)lp) : NULL);
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case WM_GETTEXT: {                           /* agent-facing part join */
        char *out = (char *)lp;
        int cap = (int)wp, n = 0;
        if (!out || cap < 1) return 0;
        int parts = st && st->n ? st->n : 1;
        for (int i = 0; i < parts && n < cap - 1; i++) {
            n += snprintf(out + n, (size_t)(cap - n), "%s%s",
                          i ? " | " : "", st && st->text[i] ? st->text[i] : "");
            if (n >= cap) { n = cap - 1; break; }
        }
        out[n] = 0;
        return n;
    }
    case WM_DESTROY:
        if (st) {
            for (int i = 0; i < SB_PARTS; i++) free(st->text[i]);
            free(st);
            SetWindowLongPtr(h, GWLP_USERDATA, 0);
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static HWND sb_create(LONG style, const char *text, HWND parent, UINT id) {
    static int registered;
    if (!registered) {
        WNDCLASS wc;
        memset(&wc, 0, sizeof wc);
        wc.lpfnWndProc = sbar_proc;
        wc.lpszClassName = STATUSCLASSNAMEA;
        RegisterClass(&wc);
        registered = 1;
    }
    HWND h = CreateWindowEx(0, STATUSCLASSNAMEA, text ? text : "",
                            (DWORD)style | WS_CHILD | WS_VISIBLE,
                            0, 0, 10, 10, parent, (HMENU)(UINT_PTR)id,
                            NULL, NULL);
    if (h) sb_park(h);                           /* real size: font-derived */
    return h;
}

HWND CreateStatusWindowA(LONG style, LPCSTR text, HWND parent, UINT id) {
    return sb_create(style, text, parent, id);
}

HWND CreateStatusWindowW(LONG style, LPCWSTR text, HWND parent, UINT id) {
    char *t = text ? sb_w2a(text) : NULL;
    HWND h = sb_create(style, t, parent, id);
    free(t);
    return h;
}
