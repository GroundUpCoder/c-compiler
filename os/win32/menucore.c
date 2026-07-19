/* menucore.c — the ONE menu engine (todos/0257 A13, extracted by M4,
 * todos/0259): model + geometry + tracking + raster over HDC, moved
 * VERBATIM from user32.c's 0068/0091/0211/0257 menu engine and consumed
 * through the menucore.h seam by BOTH front-ends — user32 (the win32
 * HMENU API + bar furniture + agent protocol) and os/wm.c (Start-menu
 * flyouts + context menus, whose fork engines and depth caps this
 * extraction deleted). The engine's only direct outward dependency is
 * gdi32 (drawing on caller-provided HDCs + its own measuring DC);
 * windows, commands and notifications go through the MenuCoreOps vtable
 * registered at mc_track_begin. See menucore.h for the contract.
 */
/* The veneer is implemented ANSI (WIN32.md friction #2: implement W, shim
 * A). Ported apps build -DUNICODE (0060); the implementation must not. */
#undef UNICODE
#undef _UNICODE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "win32_internal.h"
#include "menucore.h"

MenuChain __mc;

/* ============================================================ sys colors
 * (moved from user32.c — the Win95 palette is shared UI vocabulary: the
 * engine's raster, user32's controls and comctl32 all read it, and wm.c
 * links the engine without user32). */

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

void mc_strip_amp(const char *in, char *out, int cap) {
    int n = 0;
    for (; *in && n < cap - 1; in++)
        if (*in != '&') out[n++] = *in;
    out[n] = 0;
}

/* ============================================================ model */

MenuTbl *mc_menu_create(void) { return (MenuTbl *)calloc(1, sizeof(MenuTbl)); }

MenuItem *mc_append(MenuTbl *m, int kind, int id, const char *text,
                    MenuTbl *sub) {
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

void mc_menu_clear(MenuTbl *m) {
    if (!m) return;
    for (int i = 0; i < m->n; i++) {
        free(m->items[i].text);
        if (m->items[i].sub) mc_menu_destroy(m->items[i].sub);
    }
    free(m->items);
    m->items = NULL;
    m->n = m->cap = 0;
}

void mc_menu_destroy(MenuTbl *m) {
    if (!m) return;
    mc_menu_clear(m);
    free(m);
}

/* Label lookup for the agent: '&' stripped, accel tab cut. */
MenuItem *mc_find_label(MenuTbl *m, const char *label) {
    if (!m) return NULL;
    for (int i = 0; i < m->n; i++) {
        MenuItem *it = &m->items[i];
        if (it->kind == 0 && it->text) {
            char stripped[128];
            mc_strip_amp(it->text, stripped, sizeof stripped);
            char *tab = strchr(stripped, '\t');
            if (tab) *tab = 0;
            if (strcmp(stripped, label) == 0) return it;
        }
        if (it->sub) {
            MenuItem *f = mc_find_label(it->sub, label);
            if (f) return f;
        }
    }
    return NULL;
}

MenuItem *mc_find_cmd(MenuTbl *m, int id) {
    if (!m) return NULL;
    for (int i = 0; i < m->n; i++) {
        if (m->items[i].kind == 0 && m->items[i].id == id) return &m->items[i];
        if (m->items[i].sub) {
            MenuItem *f = mc_find_cmd(m->items[i].sub, id);
            if (f) return f;
        }
    }
    return NULL;
}

/* The (table, row) holding `it` anywhere under root — ANY depth (A12);
 * the agent fires items in not-yet-opened cascades through this. */
MenuTbl *mc_locate(MenuTbl *m, const MenuItem *it, int *rowOut) {
    if (!m) return NULL;
    for (int i = 0; i < m->n; i++) {
        if (&m->items[i] == it) { *rowOut = i; return m; }
        if (m->items[i].sub) {
            MenuTbl *f = mc_locate(m->items[i].sub, it, rowOut);
            if (f) return f;
        }
    }
    return NULL;
}

MenuItem *mc_item_of(MenuTbl *m, UINT id, UINT flags) {
    if (!m) return NULL;
    if (flags & MF_BYPOSITION)
        return (int)id < m->n ? &m->items[id] : NULL;
    return mc_find_cmd(m, (int)id);
}

/* ============================================================ geometry
 * (bar and popup share the measuring DC) */

HDC mc_measure_dc(void) {
    static HDC dc;
    if (!dc) dc = CreateCompatibleDC(NULL);
    return dc;
}

int mc_text_w(const char *text) {               /* up to the accel tab */
    char label[128];
    mc_strip_amp(text ? text : "", label, sizeof label);
    char *tab = strchr(label, '\t');
    if (tab) *tab = 0;
    SIZE sz;
    GetTextExtentPoint32(mc_measure_dc(), label, (int)strlen(label), &sz);
    return sz.cx;
}

int mc_row_h(const MenuItem *it) {
    return it->kind == 2 ? MENU_SEP_H : MENU_ITEM_H;
}

/* Measured size of a popup table (0211: shared by root + cascade). */
void mc_tbl_size(MenuTbl *m, int *wOut, int *hOut) {
    int w = 60, h = 2;
    for (int i = 0; m && i < m->n; i++) {
        const MenuItem *it = &m->items[i];
        h += mc_row_h(it);
        if (it->kind != 2) {
            int tw = mc_text_w(it->text) + MENU_GUTTER + 20;
            const char *tab = it->text ? strchr(it->text, '\t') : NULL;
            if (tab) {
                SIZE az;
                GetTextExtentPoint32(mc_measure_dc(), tab + 1, (int)strlen(tab + 1), &az);
                tw += az.cx + 12;
            }
            if (tw > w) w = tw;
        }
    }
    *wOut = w;
    *hOut = h + 2;
}

/* Row index of table m (drawn at pr) at (x, y); -1 outside. */
int mc_tbl_at(MenuTbl *m, const RECT *pr, int x, int y) {
    POINT p = { x, y };
    if (!m || !PtInRect(pr, p)) return -1;
    int ry = pr->top + 1;
    for (int i = 0; i < m->n; i++) {
        int rh = mc_row_h(&m->items[i]);
        if (y >= ry && y < ry + rh) return i;
        ry += rh;
    }
    return -1;
}

/* ============================================================ raster */

/* The Win95 look: raised/sunken 3D edges over the BTNFACE palette
 * (moved from user32.c's controls section — the popup border and the
 * controls share it). */
void mc_draw_raised(HDC dc, RECT r, int sunken) {
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

void mc_draw_tbl(HDC dc, MenuTbl *m, const RECT *prp, int hotRow) {
    RECT pr = *prp;
    FillRect(dc, &pr, GetSysColorBrush(COLOR_MENU));
    mc_draw_raised(dc, pr, 0);
    SetBkMode(dc, TRANSPARENT);
    int y = pr.top + 1;
    for (int i = 0; m && i < m->n; i++) {
        const MenuItem *it = &m->items[i];
        int rh = mc_row_h(it);
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
            mc_strip_amp(it->text ? it->text : "", label, sizeof label);
            char *tab = strchr(label, '\t');
            if (tab) *tab = 0;
            TextOut(dc, pr.left + MENU_GUTTER, y + 2, label, (int)strlen(label));
            if (tab)                                          /* accel column */
                TextOut(dc, pr.right - 8 - mc_text_w(tab + 1) - 0, y + 2,
                        tab + 1, (int)strlen(tab + 1));
            if (it->kind == 1) {                              /* cascade ► (0211) */
                POINT tri[3];
                int cx = pr.right - 10, cy = y + rh / 2;
                tri[0].x = cx + 4; tri[0].y = cy;
                tri[1].x = cx - 3; tri[1].y = cy - 6;
                tri[2].x = cx - 3; tri[2].y = cy + 6;
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

/* Paint + present one open chain level into its own window. */
void mc_level_paint(int k) {
    MenuLevel *L = &__mc.lev[k];
    if (!L->win || !__mc.ops) return;
    int w, h;
    HDC dc = __mc.ops->win_begin(L->win, &w, &h);
    if (!dc) return;
    RECT pr;
    SetRect(&pr, 0, 0, w, h);
    mc_draw_tbl(dc, L->m, &pr, L->hot);
    __mc.ops->win_present(L->win, dc);
}

/* ============================================================ tracking */

void mc_track_begin(const MenuCoreOps *ops, void *owner, void *cmd,
                    int standalone, unsigned tpmFlags) {
    __mc.ops = ops;
    __mc.owner = owner;
    __mc.cmd = cmd;
    __mc.standalone = standalone;
    __mc.tpmFlags = tpmFlags;
    __mc.retcmd = 0;
    __mc.open = 1;
    ops->track_state(owner, 1, standalone);
}

/* Destroy open levels >= k, deepest first (each destroy pops its window;
 * nothing of the owner to repaint — the popups never overwrote its
 * pixels). */
void mc_trunc(int k) {
    while (__mc.nlev > k) {
        MenuLevel *L = &__mc.lev[--__mc.nlev];
        if (L->win) __mc.ops->win_destroy(L->win);
        memset(L, 0, sizeof *L);
    }
}

void mc_close(void) {
    if (!__mc.open) return;
    void *owner = __mc.owner;
    int standalone = __mc.standalone;
    mc_trunc(0);
    __mc.open = 0;
    __mc.owner = NULL;
    __mc.cmd = NULL;
    /* wParam TRUE for a TrackPopupMenu loop, like Windows (0211) */
    __mc.ops->track_state(owner, 0, standalone);
}

/* Teardown WITHOUT the leaving notification — the owner window is dying
 * (user32's WM_DESTROY path, unchanged semantics from 0257). */
void mc_abort(void) {
    if (!__mc.open) return;
    mc_trunc(0);
    __mc.open = 0;
    __mc.owner = NULL;
    __mc.cmd = NULL;
}

/* Open table `tbl` as the next chain level, anchored at (ax, ay) in
 * `parentWin`'s space (level 0's parent is the front-end's owner
 * window). popup_opening fires BEFORE measuring so live check/gray (or
 * lazy-population) mutations land in the paint. The level is capped to
 * the SCREEN, not the owner surface (ops->screen_size) — popups really
 * overflow the window; keeping the window on-screen is the window
 * layer's job (user32: the kernel anchored-child slide clamp; wm.c: its
 * work-area clamp — design §3.1/§3.3.3, resolution in the 0257 dev
 * log). */
void mc_level_open(MenuTbl *tbl, int idx, MCWIN parentWin, int ax, int ay) {
    if (__mc.nlev >= MENU_MAX_DEPTH) {
        WIN32_UNSUPPORTED("menu cascade deeper than %d levels", MENU_MAX_DEPTH);
        return;
    }
    __mc.ops->popup_opening(__mc.owner, tbl, idx);
    MenuLevel *L = &__mc.lev[__mc.nlev];
    L->m = tbl;
    L->hot = -1;
    L->ax = ax;
    L->ay = ay;
    mc_tbl_size(L->m, &L->w, &L->h);
    int sw = 0, sh = 0;
    __mc.ops->screen_size(&sw, &sh);
    if (sw > 0 && L->w > sw) L->w = sw;
    if (sh > 0 && L->h > sh) L->h = sh;
    L->win = __mc.ops->win_create(parentWin, ax, ay, L->w, L->h, 1);
    if (!L->win) return;
    __mc.nlev++;
    mc_level_paint(__mc.nlev - 1);
}

/* Open the cascade of level k's row as level k+1 (deeper levels close
 * first). Arbitrary depth (A12) — the 0211 one-nested-level cap and its
 * "unsupported" report are gone. */
void mc_sub_open(int k, int row) {
    MenuLevel *P = &__mc.lev[k];
    if (!P->m || row < 0 || row >= P->m->n) return;
    MenuItem *it = &P->m->items[row];
    if (it->kind != 1 || !it->sub || (it->state & (MF_GRAYED | MF_DISABLED)))
        return;
    if (__mc.nlev > k + 1) {
        if (__mc.lev[k + 1].m == it->sub) return;            /* already open */
        mc_trunc(k + 1);
    }
    int ry = 1;                                  /* the anchor row's drawn top */
    for (int i = 0; i < row; i++) ry += mc_row_h(&P->m->items[i]);
    mc_level_open(it->sub, row, P->win, P->w - 3, ry);
}

void mc_fire(MenuTbl *m, int row) {
    if (!m || row < 0 || row >= m->n) return;
    MenuItem *it = &m->items[row];
    if (it->kind != 0 || (it->state & (MF_GRAYED | MF_DISABLED))) return;
    /* Capture BEFORE the close: a front-end may free its tables in the
     * leaving track_state (wm.c's per-tracking tables do). */
    int id = it->id;
    int standalone = __mc.standalone;
    void *owner = __mc.owner, *cmd = __mc.cmd;
    unsigned tpm = __mc.tpmFlags;
    const MenuCoreOps *ops = __mc.ops;
    mc_close();
    if (standalone) {
        if (tpm & TPM_RETURNCMD) __mc.retcmd = id;
        else if (!(tpm & TPM_NONOTIFY) && cmd)
            ops->post_command(cmd, id);
    } else if (owner) {
        ops->post_command(owner, id);
    }
}

/* Mouse on open chain level k's window, popup-local coords. */
void mc_level_mouse(int k, UINT msg, int x, int y) {
    MenuLevel *L = &__mc.lev[k];
    RECT pr;
    SetRect(&pr, 0, 0, L->w, L->h);
    int row = mc_tbl_at(L->m, &pr, x, y);
    switch (msg) {
    case WM_MOUSEMOVE:
        if (row >= 0 && row != L->hot) {
            L->hot = row;
            if (L->m->items[row].kind == 1)
                mc_sub_open(k, row);             /* hover opens the cascade */
            else if (__mc.nlev > k + 1)
                mc_trunc(k + 1);                 /* left the cascade's row */
            mc_level_paint(k);
        } else if (row < 0 && L->hot >= 0 && __mc.nlev == k + 1) {
            L->hot = -1;                         /* left the deepest level: unhot */
            mc_level_paint(k);
        }
        return;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        if (row < 0) return;
        if (L->m->items[row].kind == 1) {
            L->hot = row;
            mc_sub_open(k, row);                 /* click opens the cascade */
            mc_level_paint(k);
        } else {
            mc_fire(L->m, row);
        }
        return;
    case WM_LBUTTONUP:
        if (row >= 0 && L->m->items[row].kind == 0)
            mc_fire(L->m, row);                  /* press-drag-release */
        return;
    default:
        return;                                  /* modal while open */
    }
}

/* Keyboard while a tracking is open (todos/0091): Up/Down walk the
 * enabled rows of the DEEPEST level, Enter fires the hot one, Right
 * opens a hot cascade / Left closes the deepest level (any depth, A12),
 * Esc closes the deepest level. Returns 1 for the keys it owns; 0 for
 * printables/anything else so front-ends can layer type-ahead — an open
 * menu is modal for the keyboard either way (Windows semantics; the
 * mouse routing above already is), the front-end swallows the rest. */
int mc_route_key(int key) {
    if (!__mc.open || __mc.nlev == 0) {
        if (key == 27) { mc_close(); return 1; }
        return 0;
    }
    int deep = __mc.nlev - 1;
    MenuLevel *L = &__mc.lev[deep];
    if (key == 27) {                                       /* Esc */
        if (deep > 0) mc_trunc(deep);
        else mc_close();
        return 1;
    }
    if (!L->m || L->m->n == 0) return 0;
    if (key == 1073741905 || key == 1073741906) {          /* Down / Up */
        int dir = key == 1073741905 ? 1 : -1;
        int i = L->hot;
        for (int k = 0; k < L->m->n; k++) {
            i = i < 0 ? (dir > 0 ? 0 : L->m->n - 1) : (i + dir + L->m->n) % L->m->n;
            MenuItem *it = &L->m->items[i];
            if (it->kind != 2 && !(it->state & (MF_GRAYED | MF_DISABLED)))
                break;
        }
        L->hot = i;
        mc_level_paint(deep);
        return 1;
    }
    if (key == 1073741903) {                               /* Right: cascade */
        if (L->hot >= 0 && L->m->items[L->hot].kind == 1) {
            int before = __mc.nlev;
            mc_sub_open(deep, L->hot);
            if (__mc.nlev > before)
                mc_route_key(1073741905);                  /* hot first row */
        }
        return 1;
    }
    if (key == 1073741904) {                               /* Left: back out */
        if (deep > 0) mc_trunc(deep);
        return 1;
    }
    if (key == 13 || key == 1073741912) {                  /* Return / KP */
        if (L->hot >= 0) {
            MenuItem *it = &L->m->items[L->hot];
            if (it->kind == 1)
                mc_sub_open(deep, L->hot);                 /* Enter opens too */
            else
                mc_fire(L->m, L->hot);
        } else {
            mc_close();
        }
        return 1;
    }
    return 0;
}

/* First-letter type-ahead over the DEEPEST level (wm.c's 0078 flyout
 * behavior, front-end-opt-in — user32's menus keep plain modal
 * swallowing until a mnemonic milestone wires them). */
void mc_typeahead(int ch) {
    if (!__mc.open || __mc.nlev == 0) return;
    if (ch < 32 || ch >= 127) return;
    int deep = __mc.nlev - 1;
    MenuLevel *L = &__mc.lev[deep];
    if (!L->m || L->m->n == 0) return;
    char lc = (char)(ch >= 'A' && ch <= 'Z' ? ch + 32 : ch);
    int n = L->m->n;
    for (int k = 1; k <= n; k++) {
        int i = (L->hot + k + n) % n;                /* hot -1 starts at 0 */
        MenuItem *it = &L->m->items[i];
        if (it->kind == 2 || (it->state & (MF_GRAYED | MF_DISABLED)))
            continue;
        char stripped[8];
        mc_strip_amp(it->text ? it->text : "", stripped, sizeof stripped);
        char f = stripped[0];
        if (f >= 'A' && f <= 'Z') f = (char)(f + 32);
        if (f == lc) { L->hot = i; mc_level_paint(deep); break; }
    }
}
