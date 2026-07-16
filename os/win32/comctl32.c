/* comctl32.c — the common-controls veneer slice (todos/0048, design
 * todos/WIN32.md). The "common controls" here ARE user32's controls —
 * this OS has one control implementation, so Init* has nothing to load
 * (calc calls InitCommonControls for theming/manifest reasons only).
 *
 * The STATUS BAR is the one real control this slice owns (notepad's
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
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void InitCommonControls(void) { /* one toolkit, nothing to register */ }

BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *icc) {
    return icc != NULL && icc->dwSize == sizeof *icc;
}

/* ---- status bar ---- */

#define SB_H      20
#define SB_PARTS  16

typedef struct {
    int n;                      /* part count (0 = one implicit part) */
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

static void sb_park(HWND h) {                    /* bottom of the parent client */
    HWND parent = GetParent(h);
    if (!parent) return;
    RECT pr;
    GetClientRect(parent, &pr);
    MoveWindow(h, 0, pr.bottom - SB_H, pr.right, SB_H, TRUE);
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
        int n = st && st->n ? st->n : 1;
        int left = 0;
        for (int i = 0; i < n; i++) {
            int right = (st && st->n && st->edges[i] >= 0) ? st->edges[i] : r.right;
            if (right > r.right) right = r.right;
            RECT part;
            SetRect(&part, left, 1, right - 2, SB_H - 1);
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
            /* Clip each part's text to its own cell — a readout wider than
             * its part (e.g. "Windows (CR + LF)" in a narrow window) must
             * cut at the border, not bleed into the next part. */
            ExtTextOut(dc, left + 6, 3, ETO_CLIPPED, &part, t, (int)strlen(t), NULL);
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

HWND CreateStatusWindowW(LONG style, LPCWSTR text, HWND parent, UINT id) {
    static int registered;
    if (!registered) {
        WNDCLASS wc;
        memset(&wc, 0, sizeof wc);
        wc.lpfnWndProc = sbar_proc;
        wc.lpszClassName = STATUSCLASSNAMEA;
        RegisterClass(&wc);
        registered = 1;
    }
    char *t = text ? sb_w2a(text) : NULL;
    HWND h = CreateWindowEx(0, STATUSCLASSNAMEA, t ? t : "",
                            (DWORD)style | WS_CHILD | WS_VISIBLE,
                            0, 0, 10, SB_H, parent, (HMENU)(UINT_PTR)id,
                            NULL, NULL);
    free(t);
    if (h) sb_park(h);
    return h;
}
