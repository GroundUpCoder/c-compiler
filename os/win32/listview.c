/* listview.c — SysListView32 (report view) + SysHeader32 (todos/0370,
 * design todos/SOFTWARE-NATIVE.md §3). One facility per TU, the menucore.c
 * precedent; registered by comctl32's InitCommonControls[Ex] via
 * __comctl_register_listview (win32_internal.h).
 *
 * Built over PUBLIC user32/gdi32 APIs (the comctl32.c status-bar
 * precedent: state hangs off GWLP_USERDATA, no user32 internals) plus the
 * exported menucore helpers (mc_draw_raised / mc_strip_amp). The listview
 * creates its SysHeader32 as a child (the Windows architecture) and an
 * embedded SCROLLBAR child for the vertical bar — deliberately NOT
 * repeating the known LISTBOX divergence ("WS_VSCROLL: no scrollbar is
 * drawn", WIN32.md 0211 audit).
 *
 * Report view ONLY: icon/small-icon/list views have no customer and no
 * ImageList substrate — a creation style asking for them reports through
 * the 0211 fail-loud path and proceeds as report view. LVS_EX_FULLROWSELECT
 * is honored; other extended bits report once.
 *
 * The agent surface (the 0370 crux): WM_GETTEXT returns the CONTENT,
 * row-per-line — header line first, subitems joined " | ", "> " on
 * selected rows (the LISTBOX/status-bar convention extended) — and both
 * classes answer the AQM seam (win32_internal.h): AQM_DUMPCHILDREN splices
 * `lvrow`/`hdcol` lines under the control's `win` line in `wmctl tree`;
 * AQM_FINDLABEL makes every row a click/label target by its column-0 text
 * (a header segment by its title, so `wmctl click Version` sorts). Formats
 * here are test-facing, like the LISTBOX join. */
#undef UNICODE
#undef _UNICODE
#include "win32_internal.h"
#include <commctrl.h>
#include "menucore.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LV_B    2               /* sunken-well border, the LISTBOX inset */
#define LV_SBW  16              /* embedded scrollbar width (ctldemo idiom) */
#define LV_PADX 4               /* cell text inset */
#define HD_MINW 8               /* divider drag floor */
#define HD_GRIP 4               /* divider hit slop, +/- px */

/* ---- small shared helpers ---- */

static char *lv_dup(const char *s) {
    if (!s) s = "";
    size_t n = strlen(s);
    char *out = (char *)malloc(n + 1);
    if (out) memcpy(out, s, n + 1);
    return out;
}

static char *lv_w2a(LPCWSTR w) {                 /* malloc'd UTF-8 */
    if (!w) w = (LPCWSTR)u"";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *out = (char *)malloc(n > 0 ? (size_t)n : 1);
    if (!out) return NULL;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
    else out[0] = 0;
    return out;
}

/* UTF-8 -> caller's WCHAR buffer, truncating; returns wchar count sans NUL */
static int lv_a2w_buf(const char *a, LPWSTR out, int cap) {
    if (!out || cap < 1) return 0;
    int n = MultiByteToWideChar(CP_UTF8, 0, a ? a : "", -1, out, cap);
    if (n > 0) return n - 1;                     /* converted incl. NUL */
    out[cap - 1] = 0;                            /* truncated: re-run capped */
    n = MultiByteToWideChar(CP_UTF8, 0, a ? a : "", (int)strlen(a ? a : ""),
                            out, cap - 1);
    if (n < 0) n = 0;
    out[n] = 0;
    return n;
}

/* Font-derived metrics off the control's own DC (respects WM_SETFONT via
 * the 0223 GetDC choke; the sb_height precedent). */
static int lv_font_h(HWND h) {
    int fh = 16;
    HDC dc = GetDC(h);
    if (dc) {
        TEXTMETRIC tm;
        if (GetTextMetrics(dc, &tm) && tm.tmHeight > 0) fh = tm.tmHeight;
        ReleaseDC(h, dc);
    }
    return fh;
}

/* One aligned, clipped cell draw shared by the header and the rows. */
static void lv_cell_text(HDC dc, RECT cell, const char *text, int fmt) {
    if (!text || !text[0]) return;
    int len = (int)strlen(text);
    SIZE sz;
    sz.cx = 0; sz.cy = 0;
    GetTextExtentPoint32(dc, text, len, &sz);
    int tx = cell.left + LV_PADX;
    if ((fmt & 3) == LVCFMT_RIGHT) tx = cell.right - LV_PADX - sz.cx;
    else if ((fmt & 3) == LVCFMT_CENTER)
        tx = cell.left + (cell.right - cell.left - sz.cx) / 2;
    if (tx < cell.left + 1) tx = cell.left + 1;
    ExtTextOut(dc, tx, cell.top + 1, ETO_CLIPPED, &cell, text, len, NULL);
}

/* ============================================================ SysHeader32
 * A real, separately registered control (reusable alone): owns column
 * segments, paints BTNFACE button-style bevels, fires HDN_ITEMCLICK on a
 * segment press and HDN_ITEMCHANGED live through a divider drag. */

typedef struct { char *text; int cxy; int fmt; LPARAM lParam; } HdCol;

typedef struct {
    HdCol *it;
    int n, cap;
    int press;                  /* pressed segment during a click, -1 */
    int drag;                   /* divider being dragged (col index), -1 */
    int dragOff;                /* x offset from the pointer to the edge */
} HdState;

static int hd_left(HdState *st, int i) {         /* segment left edge */
    int x = 0;
    for (int c = 0; c < i && c < st->n; c++) x += st->it[c].cxy;
    return x;
}

/* Segment index at x; -1 = past the last segment. divider != NULL: set to
 * the column whose RIGHT edge is within HD_GRIP of x (-1 none). */
static int hd_hit(HdState *st, int x, int *divider) {
    int left = 0, seg = -1;
    if (divider) *divider = -1;
    for (int i = 0; i < st->n; i++) {
        int right = left + st->it[i].cxy;
        if (divider && x >= right - HD_GRIP && x <= right + HD_GRIP)
            *divider = i;
        if (seg < 0 && x >= left && x < right) seg = i;
        left = right;
    }
    return seg;
}

static void hd_notify(HWND h, UINT code, int item) {
    HWND p = GetParent(h);
    if (!p) return;
    NMHEADERA nm;
    memset(&nm, 0, sizeof nm);
    nm.hdr.hwndFrom = h;
    nm.hdr.idFrom = (UINT_PTR)GetDlgCtrlID(h);
    nm.hdr.code = code;
    nm.iItem = item;
    SendMessage(p, WM_NOTIFY, (WPARAM)nm.hdr.idFrom, (LPARAM)&nm);
}

static LRESULT hd_insert(HWND h, HdState *st, int at, const HDITEMA *hi,
                         char *ownedText) {
    /* ownedText: pre-converted W text (we take ownership) or NULL = use
     * hi->pszText. */
    if (!hi) { free(ownedText); return -1; }
    if (at < 0) at = 0;
    if (at > st->n) at = st->n;
    if (st->n >= st->cap) {
        int nc = st->cap ? st->cap * 2 : 8;
        HdCol *ni = (HdCol *)realloc(st->it, (size_t)nc * sizeof(HdCol));
        if (!ni) { free(ownedText); return -1; }
        st->it = ni;
        st->cap = nc;
    }
    memmove(&st->it[at + 1], &st->it[at], (size_t)(st->n - at) * sizeof(HdCol));
    HdCol *c = &st->it[at];
    memset(c, 0, sizeof *c);
    c->text = ownedText ? ownedText
                        : lv_dup((hi->mask & HDI_TEXT) ? hi->pszText : "");
    c->cxy = (hi->mask & HDI_WIDTH) ? hi->cxy : 60;
    if (c->cxy < HD_MINW) c->cxy = HD_MINW;
    c->fmt = (hi->mask & HDI_FORMAT) ? hi->fmt : HDF_LEFT;
    c->lParam = (hi->mask & HDI_LPARAM) ? hi->lParam : 0;
    st->n++;
    InvalidateRect(h, NULL, TRUE);
    return at;
}

static LRESULT hd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    HdState *st = (HdState *)GetWindowLongPtr(h, GWLP_USERDATA);
    switch (msg) {
    case WM_CREATE:
        st = (HdState *)calloc(1, sizeof(HdState));
        if (!st) return -1;
        st->press = st->drag = -1;
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)st);
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
        int left = 0;
        for (int i = 0; i < st->n && left < r.right; i++) {
            RECT seg;
            SetRect(&seg, left, 0, left + st->it[i].cxy, r.bottom);
            if (seg.right > r.right) seg.right = r.right;
            mc_draw_raised(dc, seg, st->press == i);
            RECT cell;
            SetRect(&cell, seg.left + 1, seg.top + 1, seg.right - 2,
                    seg.bottom - 1);
            /* HDF alignment values match LVCFMT (left 0 / right 1 / center 2) */
            lv_cell_text(dc, cell, st->it[i].text, st->it[i].fmt);
            left += st->it[i].cxy;
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        int divider;
        int seg = hd_hit(st, GET_X_LPARAM(lp), &divider);
        if (divider >= 0) {                      /* drag-resize the divider */
            st->drag = divider;
            st->dragOff = GET_X_LPARAM(lp)
                          - (hd_left(st, divider) + st->it[divider].cxy);
            SetCapture(h);
        } else if (seg >= 0) {                   /* arm a segment press */
            st->press = seg;
            SetCapture(h);
            InvalidateRect(h, NULL, TRUE);
        }
        return 0;
    }
    case WM_MOUSEMOVE:
        if (st->drag >= 0 && GetCapture() == h) {
            int w = GET_X_LPARAM(lp) - st->dragOff - hd_left(st, st->drag);
            if (w < HD_MINW) w = HD_MINW;
            if (w != st->it[st->drag].cxy) {
                st->it[st->drag].cxy = w;
                InvalidateRect(h, NULL, TRUE);
                /* live-notify so the listview reflows mid-drag */
                hd_notify(h, HDN_ITEMCHANGED, st->drag);
            }
        }
        return 0;
    case WM_LBUTTONUP:
        if (st->drag >= 0) {
            st->drag = -1;
            ReleaseCapture();
            hd_notify(h, HDN_ITEMCHANGED, -1);   /* settle */
        } else if (st->press >= 0) {
            int was = st->press;
            int divider;
            st->press = -1;
            ReleaseCapture();
            InvalidateRect(h, NULL, TRUE);
            if (hd_hit(st, GET_X_LPARAM(lp), &divider) == was)
                hd_notify(h, HDN_ITEMCLICK, was);
        }
        return 0;
    case HDM_GETITEMCOUNT:
        return st->n;
    case HDM_INSERTITEMA:
        return hd_insert(h, st, (int)wp, (const HDITEMA *)lp, NULL);
    case HDM_INSERTITEMW: {
        const HDITEMW *wi = (const HDITEMW *)lp;
        if (!wi) return -1;
        HDITEMA a;
        memcpy(&a, wi, sizeof a);                /* same layout but pszText */
        a.pszText = NULL;
        char *t = (wi->mask & HDI_TEXT) ? lv_w2a(wi->pszText) : lv_dup("");
        return hd_insert(h, st, (int)wp, &a, t);
    }
    case HDM_DELETEITEM: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return FALSE;
        free(st->it[i].text);
        memmove(&st->it[i], &st->it[i + 1],
                (size_t)(st->n - i - 1) * sizeof(HdCol));
        st->n--;
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case HDM_GETITEMA:
    case HDM_GETITEMW: {
        int i = (int)wp;
        HDITEMA *hi = (HDITEMA *)lp;             /* layouts agree sans text */
        if (i < 0 || i >= st->n || !hi) return FALSE;
        if (hi->mask & HDI_WIDTH) hi->cxy = st->it[i].cxy;
        if (hi->mask & HDI_FORMAT) hi->fmt = st->it[i].fmt;
        if (hi->mask & HDI_LPARAM) hi->lParam = st->it[i].lParam;
        if ((hi->mask & HDI_TEXT) && hi->pszText && hi->cchTextMax > 0) {
            if (msg == HDM_GETITEMW)
                lv_a2w_buf(st->it[i].text, (LPWSTR)hi->pszText, hi->cchTextMax);
            else
                snprintf(hi->pszText, (size_t)hi->cchTextMax, "%s",
                         st->it[i].text ? st->it[i].text : "");
        }
        return TRUE;
    }
    case HDM_SETITEMA:
    case HDM_SETITEMW: {
        int i = (int)wp;
        const HDITEMA *hi = (const HDITEMA *)lp;
        if (i < 0 || i >= st->n || !hi) return FALSE;
        if (hi->mask & HDI_WIDTH) {
            st->it[i].cxy = hi->cxy < HD_MINW ? HD_MINW : hi->cxy;
        }
        if (hi->mask & HDI_FORMAT) st->it[i].fmt = hi->fmt;
        if (hi->mask & HDI_LPARAM) st->it[i].lParam = hi->lParam;
        if (hi->mask & HDI_TEXT) {
            free(st->it[i].text);
            st->it[i].text = msg == HDM_SETITEMW
                ? lv_w2a((LPCWSTR)hi->pszText) : lv_dup(hi->pszText);
        }
        InvalidateRect(h, NULL, TRUE);
        hd_notify(h, HDN_ITEMCHANGED, i);
        return TRUE;
    }
    case WM_GETTEXT: {                           /* agent-facing title join */
        char *out = (char *)lp;
        int cap = (int)wp, n = 0;
        if (!out || cap < 1) return 0;
        for (int i = 0; i < st->n && n < cap - 1; i++) {
            n += snprintf(out + n, (size_t)(cap - n), "%s%s", i ? " | " : "",
                          st->it[i].text ? st->it[i].text : "");
            if (n >= cap) { n = cap - 1; break; }
        }
        out[n] = 0;
        return n;
    }
    case AQM_DUMPCHILDREN: {                     /* columns as tree lines */
        AqmDump *d = (AqmDump *)lp;
        if (!d || !st->n) return 0;
        size_t cap = (size_t)st->n * 96 + 1;
        char *out = (char *)malloc(cap);
        if (!out) return 0;
        size_t n = 0;
        for (int i = 0; i < st->n; i++)
            n += (size_t)snprintf(out + n, cap - n, "%*shdcol i=%d text='%s'\n",
                                  d->depth * 2, "", i,
                                  st->it[i].text ? st->it[i].text : "");
        d->out = out;
        return 1;
    }
    case AQM_FINDLABEL: {                        /* a segment title is a target */
        AqmFind *f = (AqmFind *)lp;
        if (!f) return 0;
        for (int i = 0; i < st->n; i++) {
            char stripped[256];
            mc_strip_amp(st->it[i].text ? st->it[i].text : "", stripped,
                         sizeof stripped);
            if (strcmp(stripped, f->label) != 0) continue;
            f->text = lv_dup(stripped);
            if (f->act) hd_notify(h, HDN_ITEMCLICK, i);
            return 1;
        }
        return 0;
    }
    case WM_DESTROY:
        if (st) {
            for (int i = 0; i < st->n; i++) free(st->it[i].text);
            free(st->it);
            free(st);
            SetWindowLongPtr(h, GWLP_USERDATA, 0);
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ============================================================ SysListView32 */

typedef struct {
    char **sub;                 /* ncols texts; NULL slot = "" */
    UINT state;                 /* LVIS_SELECTED (LVIS_FOCUSED is derived) */
    LPARAM lParam;
} LvItem;

typedef struct {
    LvItem *it;
    int n, cap;
    int ncols;                  /* mirrors the header's item count */
    int focus;                  /* focused row, -1 (the caret) */
    int anchor;                 /* shift-range pivot */
    int top;                    /* first visible row */
    int single;                 /* LVS_SINGLESEL */
    DWORD ex;                   /* LVS_EX_* */
    HWND hdr;                   /* SysHeader32 child */
    HWND vbar;                  /* embedded SCROLLBAR child */
    int vbarShown;
} LvState;

static int lv_row_h(HWND h) { return lv_font_h(h) + 2; }
static int lv_hdr_h(HWND h) { return lv_font_h(h) + 6; }

static int lv_vis_rows(HWND h, LvState *st) {
    RECT r;
    GetClientRect(h, &r);
    int rows = (r.bottom - 2 * LV_B - lv_hdr_h(h)) / lv_row_h(h);
    (void)st;
    return rows < 1 ? 1 : rows;
}

static int lv_colw(LvState *st, int c) {
    HDITEMA hi;
    memset(&hi, 0, sizeof hi);
    hi.mask = HDI_WIDTH;
    if (!SendMessage(st->hdr, HDM_GETITEMA, (WPARAM)c, (LPARAM)&hi)) return 0;
    return hi.cxy;
}

static int lv_colfmt(LvState *st, int c) {
    HDITEMA hi;
    memset(&hi, 0, sizeof hi);
    hi.mask = HDI_FORMAT;
    if (!SendMessage(st->hdr, HDM_GETITEMA, (WPARAM)c, (LPARAM)&hi)) return 0;
    return hi.fmt;
}

/* Layout the header + scrollbar children and clamp the scroll state; call
 * after anything that moves geometry, item count, or fonts. */
static void lv_layout(HWND h, LvState *st) {
    RECT r;
    GetClientRect(h, &r);
    int hh = lv_hdr_h(h);
    int vis = lv_vis_rows(h, st);
    int need = st->n > vis;
    int sbw = need ? LV_SBW : 0;
    int maxTop = st->n - vis;
    if (maxTop < 0) maxTop = 0;
    if (st->top > maxTop) st->top = maxTop;
    if (st->top < 0) st->top = 0;
    MoveWindow(st->hdr, LV_B, LV_B, r.right - 2 * LV_B - sbw, hh, TRUE);
    if (need) {
        MoveWindow(st->vbar, r.right - LV_B - LV_SBW, LV_B + hh, LV_SBW,
                   r.bottom - 2 * LV_B - hh, TRUE);
        SCROLLINFO si;
        memset(&si, 0, sizeof si);
        si.cbSize = sizeof si;
        si.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        si.nMin = 0;
        si.nMax = st->n - 1;
        si.nPage = (UINT)vis;
        si.nPos = st->top;
        SetScrollInfo(st->vbar, SB_CTL, &si, TRUE);
        if (!st->vbarShown) { ShowWindow(st->vbar, SW_SHOW); st->vbarShown = 1; }
    } else if (st->vbarShown) {
        ShowWindow(st->vbar, SW_HIDE);
        st->vbarShown = 0;
    }
}

static void lv_scroll_to(HWND h, LvState *st, int top) {
    int vis = lv_vis_rows(h, st);
    int maxTop = st->n - vis;
    if (maxTop < 0) maxTop = 0;
    if (top > maxTop) top = maxTop;
    if (top < 0) top = 0;
    if (top == st->top) return;
    st->top = top;
    if (st->vbarShown) SetScrollPos(st->vbar, SB_CTL, top, TRUE);
    InvalidateRect(h, NULL, TRUE);
}

static void lv_show_row(HWND h, LvState *st, int i) {  /* ENSUREVISIBLE core */
    if (i < 0 || i >= st->n) return;
    int vis = lv_vis_rows(h, st);
    int top = st->top;
    if (i < top) top = i;
    else if (i >= top + vis) top = i - vis + 1;
    lv_scroll_to(h, st, top);
}

static void lv_nfy(HWND h, LvState *st, UINT code, int item, int sub,
                   UINT newst, UINT oldst) {
    HWND p = GetParent(h);
    if (!p) return;
    NMLISTVIEW nm;
    memset(&nm, 0, sizeof nm);
    nm.hdr.hwndFrom = h;
    nm.hdr.idFrom = (UINT_PTR)GetDlgCtrlID(h);
    nm.hdr.code = code;
    nm.iItem = item;
    nm.iSubItem = sub;
    nm.uNewState = newst;
    nm.uOldState = oldst;
    nm.uChanged = code == LVN_ITEMCHANGED ? LVIF_STATE : 0;
    nm.lParam = item >= 0 && item < st->n ? st->it[item].lParam : 0;
    SendMessage(p, WM_NOTIFY, (WPARAM)nm.hdr.idFrom, (LPARAM)&nm);
}

/* The one selection mutator: applies a click/keyboard gesture at row i
 * (single vs extended semantics lifted from LISTBOX 0106), then fires
 * LVN_ITEMCHANGED for the gesture row. shift/ctrl: live modifier state. */
static void lv_select_gesture(HWND h, LvState *st, int i, int shift, int ctrl) {
    if (i < 0 || i >= st->n) return;
    UINT old = st->it[i].state | (st->focus == i ? LVIS_FOCUSED : 0);
    if (st->single) {
        for (int k = 0; k < st->n; k++) st->it[k].state &= ~LVIS_SELECTED;
        st->it[i].state |= LVIS_SELECTED;
        st->anchor = i;
    } else if (shift) {                          /* range from the anchor */
        int base = st->anchor < 0 ? i : st->anchor;
        if (!ctrl)
            for (int k = 0; k < st->n; k++) st->it[k].state &= ~LVIS_SELECTED;
        int a = base < i ? base : i, b = base < i ? i : base;
        for (int k = a; k <= b; k++) st->it[k].state |= LVIS_SELECTED;
    } else if (ctrl) {                           /* toggle one, move anchor */
        st->it[i].state ^= LVIS_SELECTED;
        st->anchor = i;
    } else {                                     /* plain: replace the set */
        for (int k = 0; k < st->n; k++) st->it[k].state &= ~LVIS_SELECTED;
        st->it[i].state |= LVIS_SELECTED;
        st->anchor = i;
    }
    st->focus = i;
    lv_show_row(h, st, i);
    InvalidateRect(h, NULL, TRUE);
    lv_nfy(h, st, LVN_ITEMCHANGED, i, 0,
           st->it[i].state | LVIS_FOCUSED, old);
}

static int lv_row_at(HWND h, LvState *st, int y) {
    int hh = lv_hdr_h(h);
    if (y < LV_B + hh) return -1;
    int i = st->top + (y - LV_B - hh) / lv_row_h(h);
    return i >= 0 && i < st->n ? i : -1;
}

/* Join a row's subitems " | " into out (agent text). */
static int lv_row_join(LvState *st, int i, char *out, int cap) {
    int n = 0;
    for (int c = 0; c < st->ncols && n < cap - 1; c++) {
        const char *t = st->it[i].sub[c] ? st->it[i].sub[c] : "";
        n += snprintf(out + n, (size_t)(cap - n), "%s%s", c ? " | " : "", t);
        if (n >= cap) { n = cap - 1; break; }
    }
    out[n] = 0;
    return n;
}

static void lv_free_item(LvItem *it, int ncols) {
    for (int c = 0; c < ncols; c++) free(it->sub[c]);
    free(it->sub);
}

/* Set item/subitem text (owned = pre-converted W text we take over). */
static LRESULT lv_set_text(HWND h, LvState *st, int i, int sub,
                           const char *text, char *owned) {
    if (i < 0 || i >= st->n || sub < 0 || sub >= st->ncols) {
        free(owned);
        return FALSE;
    }
    free(st->it[i].sub[sub]);
    st->it[i].sub[sub] = owned ? owned : lv_dup(text);
    InvalidateRect(h, NULL, TRUE);
    return TRUE;
}

/* LVM_INSERTITEM core: ownedText = converted W col-0 text or NULL. */
static LRESULT lv_insert_item(HWND h, LvState *st, const LVITEMA *li,
                              char *ownedText) {
    if (!li || st->ncols < 1) { free(ownedText); return -1; }
    if (li->iSubItem != 0) { free(ownedText); return -1; }
    int at = li->iItem;
    if (at < 0) at = 0;
    if (at > st->n) at = st->n;
    if (st->n >= st->cap) {
        int nc = st->cap ? st->cap * 2 : 16;
        LvItem *ni = (LvItem *)realloc(st->it, (size_t)nc * sizeof(LvItem));
        if (!ni) { free(ownedText); return -1; }
        st->it = ni;
        st->cap = nc;
    }
    char **sub = (char **)calloc((size_t)st->ncols, sizeof(char *));
    if (!sub) { free(ownedText); return -1; }
    memmove(&st->it[at + 1], &st->it[at], (size_t)(st->n - at) * sizeof(LvItem));
    LvItem *it = &st->it[at];
    memset(it, 0, sizeof *it);
    it->sub = sub;
    if (li->mask & LVIF_TEXT)
        it->sub[0] = ownedText ? ownedText : lv_dup(li->pszText);
    else
        free(ownedText);
    if (li->mask & LVIF_STATE)
        it->state = li->state & li->stateMask & LVIS_SELECTED;
    if (li->mask & LVIF_PARAM) it->lParam = li->lParam;
    if (li->mask & LVIF_IMAGE)
        WIN32_UNSUPPORTED("listview LVIF_IMAGE (no ImageList substrate)");
    st->n++;
    if (st->focus >= at) st->focus++;
    if (st->anchor >= at) st->anchor++;
    lv_layout(h, st);
    InvalidateRect(h, NULL, TRUE);
    return at;
}

/* qsort trampoline for LVM_SORTITEMS (single-threaded world; the compare
 * context rides statics, the Windows PFNLVCOMPARE contract). */
static PFNLVCOMPARE lv_cmp_fn;
static LPARAM lv_cmp_ctx;
static int lv_cmp_tramp(const void *a, const void *b) {
    return lv_cmp_fn(((const LvItem *)a)->lParam, ((const LvItem *)b)->lParam,
                     lv_cmp_ctx);
}

static LRESULT lv_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    LvState *st = (LvState *)GetWindowLongPtr(h, GWLP_USERDATA);
    switch (msg) {
    case WM_CREATE: {
        st = (LvState *)calloc(1, sizeof(LvState));
        if (!st) return -1;
        st->focus = st->anchor = -1;
        LONG style = GetWindowLong(h, GWL_STYLE);
        st->single = (style & LVS_SINGLESEL) != 0;
        if ((style & LVS_TYPEMASK) != LVS_REPORT)
            WIN32_UNSUPPORTED("listview view style %d (LVS_REPORT only; "
                              "proceeding as report)",
                              (int)(style & LVS_TYPEMASK));
        SetWindowLongPtr(h, GWLP_USERDATA, (LONG_PTR)st);
        st->hdr = CreateWindowEx(0, WC_HEADERA, "", WS_CHILD | WS_VISIBLE,
                                 0, 0, 10, 10, h, NULL, NULL, NULL);
        st->vbar = CreateWindowEx(0, "SCROLLBAR", "",
                                  WS_CHILD | SBS_VERT,   /* hidden until needed */
                                  0, 0, 10, 10, h, NULL, NULL, NULL);
        if (!st->hdr || !st->vbar) return -1;
        return 0;
    }
    case WM_SIZE:
        lv_layout(h, st);
        return 0;
    case WM_SETFONT:
        /* metrics move together: header shares the font; rows re-measure */
        SendMessage(st->hdr, WM_SETFONT, wp, lp);
        lv_layout(h, st);
        InvalidateRect(h, NULL, TRUE);
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        RECT r;
        GetClientRect(h, &r);
        FillRect(dc, &r, GetSysColorBrush(COLOR_WINDOW));
        mc_draw_raised(dc, r, 1);                /* sunken well frame */
        int hh = lv_hdr_h(h);
        int rh = lv_row_h(h);
        int sbw = st->vbarShown ? LV_SBW : 0;
        int rowRight = r.right - LV_B - sbw;
        IntersectClipRect(dc, LV_B, LV_B + hh, rowRight, r.bottom - LV_B);
        SetBkMode(dc, TRANSPARENT);
        int fullrow = (st->ex & LVS_EX_FULLROWSELECT) != 0;
        int focused = GetFocus() == h;
        for (int i = st->top; i < st->n; i++) {
            int y = LV_B + hh + (i - st->top) * rh;
            if (y >= r.bottom - LV_B) break;
            RECT row;
            SetRect(&row, LV_B, y, rowRight, y + rh);
            int selected = (st->it[i].state & LVIS_SELECTED) != 0;
            int selRight = row.right;
            if (selected && !fullrow) {          /* classic: col-0 cell only */
                int w0 = st->ncols ? lv_colw(st, 0) : 0;
                selRight = LV_B + w0;
                if (selRight > row.right) selRight = row.right;
            }
            if (selected) {
                RECT sr;
                SetRect(&sr, row.left, row.top, selRight, row.bottom);
                FillRect(dc, &sr, GetSysColorBrush(COLOR_HIGHLIGHT));
            }
            int x = LV_B;
            for (int c = 0; c < st->ncols; c++) {
                int w = lv_colw(st, c);
                RECT cell;
                SetRect(&cell, x, y, x + w, y + rh);
                if (cell.left >= rowRight) break;
                if (cell.right > rowRight) cell.right = rowRight;
                SetTextColor(dc, GetSysColor(
                    selected && (fullrow || c == 0) ? COLOR_HIGHLIGHTTEXT
                                                    : COLOR_WINDOWTEXT));
                lv_cell_text(dc, cell, st->it[i].sub[c], lv_colfmt(st, c));
                x += w;
            }
            if (i == st->focus && focused)
                FrameRect(dc, &row, GetSysColorBrush(COLOR_BTNSHADOW));
        }
        EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK: {
        SetFocus(h);
        int i = lv_row_at(h, st, GET_Y_LPARAM(lp));
        if (i >= 0) {
            lv_select_gesture(h, st, i,
                              (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                              (GetKeyState(VK_CONTROL) & 0x8000) != 0);
            lv_nfy(h, st, msg == WM_LBUTTONDBLCLK ? NM_DBLCLK : NM_CLICK,
                   i, 0, 0, 0);
        }
        return 0;
    }
    case WM_RBUTTONDOWN: {
        SetFocus(h);
        int i = lv_row_at(h, st, GET_Y_LPARAM(lp));
        if (i >= 0) {
            if (!(st->it[i].state & LVIS_SELECTED))
                lv_select_gesture(h, st, i, 0, 0);
            lv_nfy(h, st, NM_RCLICK, i, 0, 0, 0);
        }
        return 0;
    }
    case WM_GETDLGCODE:
        return DLGC_WANTARROWS;
    case WM_KEYDOWN: {
        int i = st->focus;
        int page = lv_vis_rows(h, st);
        if (wp == VK_UP && i > 0) i--;
        else if (wp == VK_DOWN && i < st->n - 1) i++;
        else if (wp == VK_HOME && st->n) i = 0;
        else if (wp == VK_END && st->n) i = st->n - 1;
        else if (wp == VK_PRIOR && st->n) i = i > page ? i - page : 0;
        else if (wp == VK_NEXT && st->n)
            i = i + page < st->n ? i + page : st->n - 1;
        else return 0;
        if (i < 0) i = 0;
        lv_select_gesture(h, st, i,
                          !st->single && (GetKeyState(VK_SHIFT) & 0x8000) != 0,
                          0);
        return 0;
    }
    case WM_MOUSEWHEEL:
        lv_scroll_to(h, st,
                     st->top - 3 * (GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA));
        return 0;
    case WM_VSCROLL: {                           /* the embedded bar notifies */
        int vis = lv_vis_rows(h, st);
        switch (LOWORD(wp)) {
        case SB_LINEUP:   lv_scroll_to(h, st, st->top - 1); break;
        case SB_LINEDOWN: lv_scroll_to(h, st, st->top + 1); break;
        case SB_PAGEUP:   lv_scroll_to(h, st, st->top - vis); break;
        case SB_PAGEDOWN: lv_scroll_to(h, st, st->top + vis); break;
        case SB_THUMBTRACK:
        case SB_THUMBPOSITION: lv_scroll_to(h, st, (int)HIWORD(wp)); break;
        }
        return 0;
    }
    case WM_NOTIFY: {                            /* from the header child */
        const NMHEADERA *nm = (const NMHEADERA *)lp;
        if (!nm || nm->hdr.hwndFrom != st->hdr) return 0;
        if (nm->hdr.code == HDN_ITEMCLICK)
            lv_nfy(h, st, LVN_COLUMNCLICK, -1, nm->iItem, 0, 0);
        else if (nm->hdr.code == HDN_ITEMCHANGED)
            InvalidateRect(h, NULL, TRUE);       /* live reflow on drag */
        return 0;
    }
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
        InvalidateRect(h, NULL, TRUE);
        return 0;

    /* ---- columns (the header child is the single source of truth) ---- */
    case LVM_INSERTCOLUMNA:
    case LVM_INSERTCOLUMNW: {
        const LVCOLUMNA *lc = (const LVCOLUMNA *)lp;
        if (!lc) return -1;
        HDITEMA hi;
        memset(&hi, 0, sizeof hi);
        hi.mask = HDI_TEXT | HDI_WIDTH | HDI_FORMAT;
        hi.cxy = (lc->mask & LVCF_WIDTH) ? lc->cx : 60;
        hi.fmt = (lc->mask & LVCF_FMT) ? (lc->fmt & 3) : HDF_LEFT;
        char *t = NULL;
        if (lc->mask & LVCF_TEXT)
            t = msg == LVM_INSERTCOLUMNW ? lv_w2a((LPCWSTR)lc->pszText)
                                         : lv_dup(lc->pszText);
        hi.pszText = t ? t : (LPSTR)"";
        LRESULT at = SendMessage(st->hdr, HDM_INSERTITEMA, wp, (LPARAM)&hi);
        free(t);
        if (at < 0) return -1;
        /* splice a NULL cell into every item at the new column */
        for (int i = 0; i < st->n; i++) {
            char **ns = (char **)realloc(st->it[i].sub,
                                         (size_t)(st->ncols + 1) * sizeof(char *));
            if (!ns) return -1;
            memmove(&ns[at + 1], &ns[at],
                    (size_t)(st->ncols - (int)at) * sizeof(char *));
            ns[at] = NULL;
            st->it[i].sub = ns;
        }
        st->ncols++;
        InvalidateRect(h, NULL, TRUE);
        return at;
    }
    case LVM_DELETECOLUMN: {
        int c = (int)wp;
        if (c < 0 || c >= st->ncols) return FALSE;
        if (!SendMessage(st->hdr, HDM_DELETEITEM, wp, 0)) return FALSE;
        for (int i = 0; i < st->n; i++) {
            free(st->it[i].sub[c]);
            memmove(&st->it[i].sub[c], &st->it[i].sub[c + 1],
                    (size_t)(st->ncols - c - 1) * sizeof(char *));
        }
        st->ncols--;
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case LVM_GETCOLUMNA:
    case LVM_GETCOLUMNW: {
        LVCOLUMNA *lc = (LVCOLUMNA *)lp;
        if (!lc) return FALSE;
        HDITEMA hi;
        memset(&hi, 0, sizeof hi);
        char buf[256];
        hi.mask = ((lc->mask & LVCF_WIDTH) ? HDI_WIDTH : 0)
                | ((lc->mask & LVCF_FMT) ? HDI_FORMAT : 0)
                | ((lc->mask & LVCF_TEXT) ? HDI_TEXT : 0);
        hi.pszText = buf;
        hi.cchTextMax = sizeof buf;
        if (!SendMessage(st->hdr, HDM_GETITEMA, wp, (LPARAM)&hi)) return FALSE;
        if (lc->mask & LVCF_WIDTH) lc->cx = hi.cxy;
        if (lc->mask & LVCF_FMT) lc->fmt = hi.fmt;
        if ((lc->mask & LVCF_TEXT) && lc->pszText && lc->cchTextMax > 0) {
            if (msg == LVM_GETCOLUMNW)
                lv_a2w_buf(buf, (LPWSTR)lc->pszText, lc->cchTextMax);
            else
                snprintf(lc->pszText, (size_t)lc->cchTextMax, "%s", buf);
        }
        return TRUE;
    }
    case LVM_SETCOLUMNA:
    case LVM_SETCOLUMNW: {
        const LVCOLUMNA *lc = (const LVCOLUMNA *)lp;
        if (!lc) return FALSE;
        HDITEMA hi;
        memset(&hi, 0, sizeof hi);
        char *t = NULL;
        hi.mask = ((lc->mask & LVCF_WIDTH) ? HDI_WIDTH : 0)
                | ((lc->mask & LVCF_FMT) ? HDI_FORMAT : 0);
        hi.cxy = lc->cx;
        hi.fmt = lc->fmt & 3;
        if (lc->mask & LVCF_TEXT) {
            hi.mask |= HDI_TEXT;
            t = msg == LVM_SETCOLUMNW ? lv_w2a((LPCWSTR)lc->pszText)
                                      : lv_dup(lc->pszText);
            hi.pszText = t;
        }
        LRESULT r = SendMessage(st->hdr, HDM_SETITEMA, wp, (LPARAM)&hi);
        free(t);
        InvalidateRect(h, NULL, TRUE);
        return r;
    }
    case LVM_GETHEADER:
        return (LRESULT)st->hdr;

    /* ---- items ---- */
    case LVM_GETITEMCOUNT:
        return st->n;
    case LVM_INSERTITEMA:
        return lv_insert_item(h, st, (const LVITEMA *)lp, NULL);
    case LVM_INSERTITEMW: {
        const LVITEMW *wi = (const LVITEMW *)lp;
        if (!wi) return -1;
        LVITEMA a;
        memcpy(&a, wi, sizeof a);
        a.pszText = NULL;
        char *t = (wi->mask & LVIF_TEXT) ? lv_w2a(wi->pszText) : NULL;
        return lv_insert_item(h, st, &a, t);
    }
    case LVM_DELETEITEM: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return FALSE;
        lv_free_item(&st->it[i], st->ncols);
        memmove(&st->it[i], &st->it[i + 1],
                (size_t)(st->n - i - 1) * sizeof(LvItem));
        st->n--;
        if (st->focus == i) st->focus = -1;
        else if (st->focus > i) st->focus--;
        if (st->anchor == i) st->anchor = -1;
        else if (st->anchor > i) st->anchor--;
        lv_layout(h, st);
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case LVM_DELETEALLITEMS:
        for (int i = 0; i < st->n; i++) lv_free_item(&st->it[i], st->ncols);
        st->n = 0;
        st->focus = st->anchor = -1;
        st->top = 0;
        lv_layout(h, st);
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    case LVM_SETITEMTEXTA:
    case LVM_SETITEMTEXTW: {
        const LVITEMA *li = (const LVITEMA *)lp;
        if (!li) return FALSE;
        char *t = msg == LVM_SETITEMTEXTW ? lv_w2a((LPCWSTR)li->pszText) : NULL;
        return lv_set_text(h, st, (int)wp, li->iSubItem, li->pszText, t);
    }
    case LVM_GETITEMTEXTA:
    case LVM_GETITEMTEXTW: {
        LVITEMA *li = (LVITEMA *)lp;
        int i = (int)wp;
        if (!li || i < 0 || i >= st->n || li->iSubItem < 0
            || li->iSubItem >= st->ncols || !li->pszText
            || li->cchTextMax < 1)
            return 0;
        const char *t = st->it[i].sub[li->iSubItem];
        if (!t) t = "";
        if (msg == LVM_GETITEMTEXTW)
            return lv_a2w_buf(t, (LPWSTR)li->pszText, li->cchTextMax);
        snprintf(li->pszText, (size_t)li->cchTextMax, "%s", t);
        return (LRESULT)strlen(li->pszText);
    }
    case LVM_SETITEMA:
    case LVM_SETITEMW: {
        const LVITEMA *li = (const LVITEMA *)lp;
        if (!li) return FALSE;
        int i = li->iItem;
        if (i < 0 || i >= st->n) return FALSE;
        if (li->mask & LVIF_TEXT) {
            char *t = msg == LVM_SETITEMW ? lv_w2a((LPCWSTR)li->pszText) : NULL;
            if (!lv_set_text(h, st, i, li->iSubItem, li->pszText, t))
                return FALSE;
        }
        if (li->mask & LVIF_PARAM) st->it[i].lParam = li->lParam;
        if (li->mask & LVIF_STATE) {
            UINT old = st->it[i].state | (st->focus == i ? LVIS_FOCUSED : 0);
            if (li->stateMask & LVIS_SELECTED)
                st->it[i].state = (st->it[i].state & ~LVIS_SELECTED)
                                | (li->state & LVIS_SELECTED);
            if (li->stateMask & LVIS_FOCUSED) {
                if (li->state & LVIS_FOCUSED) st->focus = i;
                else if (st->focus == i) st->focus = -1;
            }
            InvalidateRect(h, NULL, TRUE);
            lv_nfy(h, st, LVN_ITEMCHANGED, i, 0,
                   st->it[i].state | (st->focus == i ? LVIS_FOCUSED : 0), old);
        }
        if (li->mask & LVIF_IMAGE)
            WIN32_UNSUPPORTED("listview LVIF_IMAGE (no ImageList substrate)");
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case LVM_GETITEMA:
    case LVM_GETITEMW: {
        LVITEMA *li = (LVITEMA *)lp;
        if (!li) return FALSE;
        int i = li->iItem;
        if (i < 0 || i >= st->n) return FALSE;
        if (li->mask & LVIF_PARAM) li->lParam = st->it[i].lParam;
        if (li->mask & LVIF_STATE)
            li->state = (st->it[i].state
                         | (st->focus == i ? LVIS_FOCUSED : 0))
                        & li->stateMask;
        if ((li->mask & LVIF_TEXT) && li->pszText && li->cchTextMax > 0) {
            const char *t = li->iSubItem >= 0 && li->iSubItem < st->ncols
                            ? st->it[i].sub[li->iSubItem] : NULL;
            if (!t) t = "";
            if (msg == LVM_GETITEMW)
                lv_a2w_buf(t, (LPWSTR)li->pszText, li->cchTextMax);
            else
                snprintf(li->pszText, (size_t)li->cchTextMax, "%s", t);
        }
        return TRUE;
    }
    case LVM_SETITEMSTATE: {
        const LVITEMA *li = (const LVITEMA *)lp;
        if (!li) return FALSE;
        int i = (int)wp;
        int a = i, b = i;
        if (i == -1) { a = 0; b = st->n - 1; }
        else if (i < 0 || i >= st->n) return FALSE;
        for (int k = a; k <= b; k++) {
            UINT old = st->it[k].state | (st->focus == k ? LVIS_FOCUSED : 0);
            UINT nw = old;
            if (li->stateMask & LVIS_SELECTED)
                nw = (nw & ~LVIS_SELECTED) | (li->state & LVIS_SELECTED);
            if (li->stateMask & LVIS_FOCUSED) {
                if (li->state & LVIS_FOCUSED) st->focus = k;
                else if (st->focus == k) st->focus = -1;
            }
            st->it[k].state = nw & ~LVIS_FOCUSED;
            nw = st->it[k].state | (st->focus == k ? LVIS_FOCUSED : 0);
            if (nw != old) lv_nfy(h, st, LVN_ITEMCHANGED, k, 0, nw, old);
        }
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case LVM_GETITEMSTATE: {
        int i = (int)wp;
        if (i < 0 || i >= st->n) return 0;
        return (st->it[i].state | (st->focus == i ? LVIS_FOCUSED : 0))
               & (UINT)lp;
    }
    case LVM_GETNEXTITEM: {
        int start = (int)wp;
        UINT flags = (UINT)lp;
        for (int i = start + 1; i < st->n; i++) {
            if ((flags & LVNI_SELECTED) && !(st->it[i].state & LVIS_SELECTED))
                continue;
            if ((flags & LVNI_FOCUSED) && st->focus != i) continue;
            return i;
        }
        return -1;
    }
    case LVM_GETSELECTEDCOUNT: {
        int c = 0;
        for (int i = 0; i < st->n; i++)
            if (st->it[i].state & LVIS_SELECTED) c++;
        return c;
    }
    case LVM_ENSUREVISIBLE:
        if ((int)wp < 0 || (int)wp >= st->n) return FALSE;
        lv_show_row(h, st, (int)wp);
        return TRUE;
    case LVM_HITTEST: {
        LVHITTESTINFO *ht = (LVHITTESTINFO *)lp;
        if (!ht) return -1;
        int i = lv_row_at(h, st, ht->pt.y);
        ht->iItem = i;
        ht->iSubItem = 0;
        if (i >= 0) {
            int x = LV_B;
            for (int c = 0; c < st->ncols; c++) {
                int w = lv_colw(st, c);
                if (ht->pt.x >= x && ht->pt.x < x + w) { ht->iSubItem = c; break; }
                x += w;
            }
            ht->flags = LVHT_ONITEM;
        } else {
            ht->flags = LVHT_NOWHERE;
        }
        return i;
    }
    case LVM_SORTITEMS: {
        if (!lp) return FALSE;
        char marked = 0;
        if (st->focus >= 0 && st->focus < st->n) {
            st->it[st->focus].state |= 0x80000000u;   /* temp focus marker */
            marked = 1;
        }
        lv_cmp_fn = (PFNLVCOMPARE)lp;
        lv_cmp_ctx = (LPARAM)wp;
        qsort(st->it, (size_t)st->n, sizeof(LvItem), lv_cmp_tramp);
        if (marked) {
            for (int i = 0; i < st->n; i++)
                if (st->it[i].state & 0x80000000u) {
                    st->it[i].state &= ~0x80000000u;
                    st->focus = i;
                    break;
                }
        }
        st->anchor = st->focus;
        lv_layout(h, st);
        InvalidateRect(h, NULL, TRUE);
        return TRUE;
    }
    case LVM_SETEXTENDEDLISTVIEWSTYLE: {
        DWORD mask = (DWORD)wp ? (DWORD)wp : 0xFFFFFFFFu;
        DWORD old = st->ex;
        st->ex = (st->ex & ~mask) | ((DWORD)lp & mask);
        DWORD unsup = st->ex & ~(DWORD)LVS_EX_FULLROWSELECT;
        if (unsup)
            WIN32_UNSUPPORTED("listview extended style 0x%x "
                              "(LVS_EX_FULLROWSELECT only)", (unsigned)unsup);
        InvalidateRect(h, NULL, TRUE);
        return old;
    }
    case LVM_GETEXTENDEDLISTVIEWSTYLE:
        return st->ex;

    /* ---- the agent surface (todos/0370) ---- */
    case WM_GETTEXT: {
        /* Content, row-per-line (the LISTBOX convention extended): header
         * line first, subitems " | "-joined, "> " marks selected rows. */
        char *out = (char *)lp;
        int cap = (int)wp, n = 0;
        if (!out || cap < 1) return 0;
        n = (int)SendMessage(st->hdr, WM_GETTEXT, (WPARAM)cap, (LPARAM)out);
        if (n > 0 && n < cap - 1) out[n++] = '\n';
        char line[512];
        for (int i = 0; i < st->n && n < cap - 1; i++) {
            lv_row_join(st, i, line, sizeof line);
            n += snprintf(out + n, (size_t)(cap - n), "%s%s\n",
                          (st->it[i].state & LVIS_SELECTED) ? "> " : "", line);
            if (n >= cap) { n = cap - 1; break; }
        }
        out[n] = 0;
        return n;
    }
    case AQM_DUMPCHILDREN: {                     /* rows as tree lines */
        AqmDump *d = (AqmDump *)lp;
        if (!d || !st->n) return 0;
        size_t cap = 0, n = 0;
        char *out = NULL;
        char line[512];
        for (int i = 0; i < st->n; i++) {
            lv_row_join(st, i, line, sizeof line);
            char one[600];
            int ln = snprintf(one, sizeof one, "%*slvrow i=%d%s text='%s'\n",
                              d->depth * 2, "", i,
                              (st->it[i].state & LVIS_SELECTED) ? " sel" : "",
                              line);
            if (n + (size_t)ln + 1 > cap) {
                size_t nc = cap ? cap * 2 : 4096;
                while (nc < n + (size_t)ln + 1) nc *= 2;
                char *nb = (char *)realloc(out, nc);
                if (!nb) { free(out); return 0; }
                out = nb;
                cap = nc;
            }
            memcpy(out + n, one, (size_t)ln + 1);
            n += (size_t)ln;
        }
        d->out = out;
        return out != NULL;
    }
    case AQM_FINDLABEL: {                        /* a row is a target by col-0 */
        AqmFind *f = (AqmFind *)lp;
        if (!f) return 0;
        for (int i = 0; i < st->n; i++) {
            char stripped[256];
            mc_strip_amp(st->it[i].sub[0] ? st->it[i].sub[0] : "", stripped,
                         sizeof stripped);
            if (strcmp(stripped, f->label) != 0) continue;
            char line[512];
            lv_row_join(st, i, line, sizeof line);
            f->text = lv_dup(line);
            if (f->act) {                        /* full click semantics */
                SetFocus(h);
                lv_select_gesture(h, st, i, 0, 0);
                lv_nfy(h, st, NM_CLICK, i, 0, 0, 0);
            }
            return 1;
        }
        return 0;
    }
    case WM_DESTROY:
        if (st) {
            for (int i = 0; i < st->n; i++) lv_free_item(&st->it[i], st->ncols);
            free(st->it);
            free(st);
            SetWindowLongPtr(h, GWLP_USERDATA, 0);
        }
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ============================================================ registration */

void __comctl_register_listview(void) {
    static int done;
    if (done) return;
    done = 1;
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = hd_proc;
    wc.lpszClassName = WC_HEADERA;
    RegisterClass(&wc);
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = lv_proc;
    wc.style = CS_DBLCLKS;
    wc.lpszClassName = WC_LISTVIEWA;
    RegisterClass(&wc);
}
