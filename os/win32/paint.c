/* paint.c — the Paint accessory (todos/0107, design todos/WIN32.md): the
 * first *creative* app on the veneer (gdi32 0057, user32 0058/0068,
 * comdlg32 0048). A small mspaint-class program — NOT a ReactOS port
 * (mspaint is C++, the Solitaire rule) — so it exercises the whole stack:
 * a memory-DC canvas, the shape/pen/brush set, mouse capture, a menu bar +
 * accelerators, comdlg32 open/save, and 24-bit BMP round-trip.
 *
 * Design calls (v1):
 *   - The client is ONE owner-drawn surface (no child controls): a left
 *     TOOLBOX column, the CANVAS blitted 1:1 from a memory DC, and a bottom
 *     PALETTE strip. Everything hit-tests in WndProc from client coords.
 *   - Tools are ALSO a menu (File/Edit/Image/Tools/Help) so they are
 *     agent-drivable by label (`wmctl click Line`); colors are palette
 *     swatches driven by pixel injection (`wmctl click SID X Y`).
 *   - FG = left button, BG = right button (the mspaint convention). Filled
 *     shapes fill with FG; outline shapes use a hollow brush.
 *   - Undo is single-level: one stashed canvas copy (Edit->Undo, Ctrl+Z).
 *     Cut/Copy/Paste stay GRAYED — a selection region is the 0107 non-goal
 *     (v2 with a real bitmap clipboard).
 *   - File I/O is 24-bit BMP only via comdlg32 (the gdi32 DIB path already
 *     swizzles B<->R); `.bmp` gets an openwith association -> /bin/paint.
 *
 * Every notable event prints a `paint:` marker to stdout — the headless
 * tests/kernel/test_paint_e2e.js asserts lifecycle + reads canvas pixels via
 * `wmctl shot`. Layout coordinates are load-bearing (the test probes canvas
 * and palette pixels): change them together.
 */
#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <commdlg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------ layout */
/* All client coords (the 20px menu bar sits above client space, drawn by
 * user32; injected pointer coords are surface coords = client + 20). */
#define TB_X       4
#define TB_Y       4
#define TB_CELL    22
#define TB_COLS    2
#define TB_ROWS    4
#define CANVAS_X   56
#define CANVAS_Y   6
#define PAL_CELL   16
#define PAL_COLS   8
#define PAL_GAP    12      /* below the canvas */

static int g_cw = 400, g_ch = 300;         /* canvas bitmap size */

static int pal_y(void)      { return CANVAS_Y + g_ch + PAL_GAP; }
static int client_w(void) {
    int a = CANVAS_X + g_cw + 8;
    int b = CANVAS_X + PAL_COLS * PAL_CELL + 8;
    return a > b ? a : b;
}
static int client_h(void) {
    int a = pal_y() + 2 * PAL_CELL + 8;
    int b = TB_Y + TB_ROWS * TB_CELL + 8;
    return a > b ? a : b;
}

/* ------------------------------------------------------------ tools */
enum { T_PENCIL, T_ERASER, T_FILL, T_LINE, T_RECT, T_FILLRECT,
       T_ELLIPSE, T_FILLELLIPSE, T_COUNT };

/* ------------------------------------------------------------ menu ids */
#define ID_NEW     101
#define ID_OPEN    102
#define ID_SAVE    103
#define ID_SAVEAS  104
#define ID_EXIT    105
#define ID_UNDO    110
#define ID_CUT     111
#define ID_COPY    112
#define ID_PASTE   113
#define ID_CLEAR   130
#define ID_TOOL0   120            /* T_* == ID_TOOL0 + tool index */
#define ID_WIDTH1  150
#define ID_WIDTH3  151
#define ID_WIDTH5  152
#define ID_ABOUT   140

/* ------------------------------------------------------------ state */
static HWND    g_hwnd;
static HDC     g_mdc, g_udc;                /* canvas + undo memory DCs */
static HBITMAP g_canvas, g_undo;
static int     g_tool = T_PENCIL;
static COLORREF g_fg = RGB(0, 0, 0), g_bg = RGB(255, 255, 255);
static int     g_penw = 1;
static int     g_canUndo;
static char    g_file[512];                 /* current path, "" = untitled */

/* the 16 VGA-ish palette (row 0 dark, row 1 bright), row-major k=row*8+col */
static const COLORREF g_pal[16] = {
    RGB(0,0,0),     RGB(128,128,128), RGB(128,0,0),   RGB(128,128,0),
    RGB(0,128,0),   RGB(0,128,128),   RGB(0,0,128),   RGB(128,0,128),
    RGB(255,255,255), RGB(192,192,192), RGB(255,0,0), RGB(255,255,0),
    RGB(0,255,0),   RGB(0,255,255),   RGB(0,0,255),   RGB(255,0,255),
};

/* drag state */
static int g_drawing, g_button;             /* 1 = left/FG, 2 = right/BG */
static int g_x0, g_y0, g_lx, g_ly;          /* stroke anchor + last (bitmap) */

static int is_shape(int t) {
    return t == T_LINE || t == T_RECT || t == T_FILLRECT ||
           t == T_ELLIPSE || t == T_FILLELLIPSE;
}

/* ------------------------------------------------------------ helpers */
static void mark(const char *s) { printf("paint: %s\n", s); fflush(stdout); }

static void a2w(const char *s, WCHAR *o, int cap) {
    if (cap < 1) return;
    MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, o, cap);
    o[cap - 1] = 0;
}
static void w2a(const WCHAR *w, char *o, int cap) {
    if (cap < 1) return;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, o, cap, NULL, NULL);
    o[cap - 1] = 0;
}

/* ------------------------------------------------------------ canvas */

/* (re)allocate the canvas + undo bitmaps at (w,h), fill white. */
static int canvas_make(int w, int h) {
    HDC ref = GetDC(g_hwnd);
    HBITMAP cb = CreateCompatibleBitmap(ref, w, h);
    HBITMAP ub = CreateCompatibleBitmap(ref, w, h);
    ReleaseDC(g_hwnd, ref);
    if (!cb || !ub) { if (cb) DeleteObject(cb); if (ub) DeleteObject(ub); return 0; }
    if (!g_mdc) g_mdc = CreateCompatibleDC(NULL);
    if (!g_udc) g_udc = CreateCompatibleDC(NULL);
    SelectObject(g_mdc, cb);
    SelectObject(g_udc, ub);
    if (g_canvas) DeleteObject(g_canvas);
    if (g_undo)   DeleteObject(g_undo);
    g_canvas = cb; g_undo = ub;
    g_cw = w; g_ch = h;
    RECT all; SetRect(&all, 0, 0, w, h);
    FillRect(g_mdc, &all, (HBRUSH)GetStockObject(WHITE_BRUSH));
    FillRect(g_udc, &all, (HBRUSH)GetStockObject(WHITE_BRUSH));
    g_canUndo = 0;
    return 1;
}

/* stash the current canvas for a single-level Undo, before a mutating op. */
static void undo_push(void) {
    BitBlt(g_udc, 0, 0, g_cw, g_ch, g_mdc, 0, 0, SRCCOPY);
    g_canUndo = 1;
    EnableMenuItem(GetMenu(g_hwnd), ID_UNDO, MF_ENABLED);
}
static void undo_apply(void) {
    if (!g_canUndo) return;
    BitBlt(g_mdc, 0, 0, g_cw, g_ch, g_udc, 0, 0, SRCCOPY);   /* restore */
    InvalidateRect(g_hwnd, NULL, FALSE);
    mark("undo");
}

/* draw the current shape/stroke segment into the canvas memory DC. */
static void draw_dot(int x, int y, COLORREF c) {
    int r = g_penw;
    RECT d; SetRect(&d, x - r / 2, y - r / 2, x - r / 2 + r, y - r / 2 + r);
    HBRUSH br = CreateSolidBrush(c);
    FillRect(g_mdc, &d, br);
    DeleteObject(br);
}
static void draw_seg(int x0, int y0, int x1, int y1, COLORREF c) {
    HPEN pen = CreatePen(PS_SOLID, g_penw, c);
    HPEN old = (HPEN)SelectObject(g_mdc, pen);
    MoveToEx(g_mdc, x0, y0, NULL);
    LineTo(g_mdc, x1, y1);
    SelectObject(g_mdc, old);
    DeleteObject(pen);
    draw_dot(x1, y1, c);           /* LineTo omits the endpoint; cover it */
}
static void draw_shape(int t, int x0, int y0, int x1, int y1, COLORREF c) {
    HPEN pen = CreatePen(PS_SOLID, g_penw, c);
    HPEN oldp = (HPEN)SelectObject(g_mdc, pen);
    int filled = (t == T_FILLRECT || t == T_FILLELLIPSE);
    HBRUSH br = filled ? CreateSolidBrush(c) : (HBRUSH)GetStockObject(NULL_BRUSH);
    HBRUSH oldb = (HBRUSH)SelectObject(g_mdc, br);
    int l = x0 < x1 ? x0 : x1, r = x0 < x1 ? x1 : x0;
    int tp = y0 < y1 ? y0 : y1, bt = y0 < y1 ? y1 : y0;
    if (t == T_LINE) { MoveToEx(g_mdc, x0, y0, NULL); LineTo(g_mdc, x1, y1); draw_dot(x1, y1, c); }
    else if (t == T_RECT || t == T_FILLRECT) Rectangle(g_mdc, l, tp, r + 1, bt + 1);
    else Ellipse(g_mdc, l, tp, r + 1, bt + 1);
    SelectObject(g_mdc, oldp);
    SelectObject(g_mdc, oldb);
    DeleteObject(pen);
    if (filled) DeleteObject(br);
}

/* scanline flood fill at (x,y) with newColor over the target color. */
static void flood_fill(int x, int y, COLORREF newc) {
    if (x < 0 || y < 0 || x >= g_cw || y >= g_ch) return;
    COLORREF target = GetPixel(g_mdc, x, y);
    if (target == newc) return;
    int cap = 1024, sp = 0;
    int *stack = (int *)malloc((size_t)cap * 2 * sizeof(int));
    if (!stack) return;
    stack[sp * 2] = x; stack[sp * 2 + 1] = y; sp++;
    while (sp > 0) {
        sp--;
        int px = stack[sp * 2], py = stack[sp * 2 + 1];
        if (px < 0 || px >= g_cw || py < 0 || py >= g_ch) continue;
        if (GetPixel(g_mdc, px, py) != target) continue;
        int lft = px, rgt = px;
        while (lft > 0 && GetPixel(g_mdc, lft - 1, py) == target) lft--;
        while (rgt < g_cw - 1 && GetPixel(g_mdc, rgt + 1, py) == target) rgt++;
        for (int i = lft; i <= rgt; i++) SetPixel(g_mdc, i, py, newc);
        for (int i = lft; i <= rgt; i++) {
            int ny0 = py - 1, ny1 = py + 1;
            if (ny0 >= 0 && GetPixel(g_mdc, i, ny0) == target) {
                if (sp + 1 >= cap) { cap *= 2; stack = (int *)realloc(stack, (size_t)cap * 2 * sizeof(int)); if (!stack) return; }
                stack[sp * 2] = i; stack[sp * 2 + 1] = ny0; sp++;
            }
            if (ny1 < g_ch && GetPixel(g_mdc, i, ny1) == target) {
                if (sp + 1 >= cap) { cap *= 2; stack = (int *)realloc(stack, (size_t)cap * 2 * sizeof(int)); if (!stack) return; }
                stack[sp * 2] = i; stack[sp * 2 + 1] = ny1; sp++;
            }
        }
    }
    free(stack);
}

/* ------------------------------------------------------------ BMP I/O */

static void put_u32(unsigned char *p, unsigned v) {
    p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF;
}
static void put_u16(unsigned char *p, unsigned v) { p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; }
static unsigned get_u32(const unsigned char *p) {
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((unsigned)p[3] << 24);
}
static unsigned get_u16(const unsigned char *p) { return p[0] | (p[1] << 8); }

static int bmp_save(const char *path) {
    int w = g_cw, h = g_ch;
    uint32_t *bits = (uint32_t *)malloc((size_t)w * h * 4);
    if (!bits) return 0;
    BITMAPINFO bmi; memset(&bmi, 0, sizeof bmi);
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w; bmi.bmiHeader.biHeight = h;   /* bottom-up */
    bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    GetDIBits(g_mdc, g_canvas, 0, h, bits, &bmi, DIB_RGB_COLORS);
    /* bits[row i] is BMP-bottom-up already; pixel bytes little-endian B,G,R,X */
    int rowb = w * 3, pad = (4 - (rowb & 3)) & 3, stride = rowb + pad;
    unsigned data = (unsigned)stride * h;
    FILE *f = fopen(path, "wb");
    if (!f) { free(bits); return 0; }
    unsigned char hdr[54]; memset(hdr, 0, sizeof hdr);
    hdr[0] = 'B'; hdr[1] = 'M';
    put_u32(hdr + 2, 54 + data);              /* file size */
    put_u32(hdr + 10, 54);                    /* pixel data offset */
    put_u32(hdr + 14, 40);                    /* info header size */
    put_u32(hdr + 18, (unsigned)w);
    put_u32(hdr + 22, (unsigned)h);
    put_u16(hdr + 26, 1);                     /* planes */
    put_u16(hdr + 28, 24);                    /* bpp */
    put_u32(hdr + 34, data);                  /* image size */
    fwrite(hdr, 1, 54, f);
    unsigned char *row = (unsigned char *)malloc((size_t)stride);
    if (!row) { fclose(f); free(bits); return 0; }
    for (int i = 0; i < h; i++) {
        unsigned char *src = (unsigned char *)(bits + (size_t)i * w);
        for (int x = 0; x < w; x++) {         /* copy B,G,R, drop X */
            row[x * 3 + 0] = src[x * 4 + 0];
            row[x * 3 + 1] = src[x * 4 + 1];
            row[x * 3 + 2] = src[x * 4 + 2];
        }
        for (int p = 0; p < pad; p++) row[rowb + p] = 0;
        fwrite(row, 1, (size_t)stride, f);
    }
    free(row); free(bits); fclose(f);
    return 1;
}

static int bmp_load(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char hdr[54];
    if (fread(hdr, 1, 54, f) != 54 || hdr[0] != 'B' || hdr[1] != 'M') { fclose(f); return 0; }
    unsigned off = get_u32(hdr + 10);
    int w = (int)get_u32(hdr + 18);
    int sh = (int)get_u32(hdr + 22);          /* signed via reinterpret below */
    int topdown = 0, h = sh;
    if (sh < 0) { topdown = 1; h = -sh; }
    int bpp = (int)get_u16(hdr + 28);
    unsigned comp = get_u32(hdr + 30);
    if (w < 1 || h < 1 || w > 4096 || h > 4096 || comp != 0 ||
        (bpp != 24 && bpp != 32)) { fclose(f); return 0; }
    uint32_t *buf = (uint32_t *)malloc((size_t)w * h * 4);   /* SetDIBits: bottom-up */
    if (!buf) { fclose(f); return 0; }
    int bypp = bpp / 8, rowb = w * bypp, pad = bpp == 24 ? ((4 - (rowb & 3)) & 3) : 0;
    int stride = rowb + pad;
    unsigned char *row = (unsigned char *)malloc((size_t)stride);
    if (!row) { free(buf); fclose(f); return 0; }
    fseek(f, (long)off, SEEK_SET);
    int ok = 1;
    for (int s = 0; s < h && ok; s++) {
        if (fread(row, 1, (size_t)stride, f) != (size_t)stride) { ok = 0; break; }
        /* stored row s: bottom-up file -> image row (h-1-s); top-down -> row s.
         * SetDIBits wants buf bottom-up (buf row i -> image row h-1-i), so
         * buf row index for image row R is (h-1-R). */
        int imgRow = topdown ? s : (h - 1 - s);
        int bi = h - 1 - imgRow;
        uint32_t *dst = buf + (size_t)bi * w;
        for (int x = 0; x < w; x++) {
            unsigned b = row[x * bypp + 0], g = row[x * bypp + 1], r = row[x * bypp + 2];
            dst[x] = b | (g << 8) | (r << 16);
        }
    }
    free(row); fclose(f);
    if (!ok) { free(buf); return 0; }
    if (w != g_cw || h != g_ch) {
        if (!canvas_make(w, h)) { free(buf); return 0; }
        MoveWindow(g_hwnd, 0, 0, client_w(), client_h() + 20, TRUE);
    }
    BITMAPINFO bmi; memset(&bmi, 0, sizeof bmi);
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w; bmi.bmiHeader.biHeight = h;
    bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    SetDIBits(g_mdc, g_canvas, 0, h, buf, &bmi, DIB_RGB_COLORS);
    free(buf);
    g_canUndo = 0;
    EnableMenuItem(GetMenu(g_hwnd), ID_UNDO, MF_GRAYED);
    return 1;
}

/* comdlg32 open/save -> a UTF-8 path (path[] is out). */
static int choose_file(int saving, char *path, int cap) {
    WCHAR wf[512]; wf[0] = 0;
    if (g_file[0]) a2w(g_file, wf, 512);
    OPENFILENAMEW ofn; memset(&ofn, 0, sizeof ofn);
    ofn.lStructSize = sizeof ofn;
    ofn.hwndOwner = g_hwnd;
    ofn.lpstrFile = wf; ofn.nMaxFile = 512;
    ofn.lpstrDefExt = u"bmp";
    ofn.lpstrTitle = saving ? u"Save As" : u"Open";
    ofn.Flags = saving ? OFN_OVERWRITEPROMPT : OFN_FILEMUSTEXIST;
    BOOL ok = saving ? GetSaveFileNameW(&ofn) : GetOpenFileNameW(&ofn);
    if (!ok) return 0;
    w2a(wf, path, cap);
    return 1;
}

static void do_save(int as) {
    char path[512];
    if (as || !g_file[0]) {
        if (!choose_file(1, path, sizeof path)) return;
        snprintf(g_file, sizeof g_file, "%s", path);
    }
    if (bmp_save(g_file)) { printf("paint: saved %s\n", g_file); fflush(stdout); }
    else MessageBox(g_hwnd, "Could not save the file.", "Paint", MB_OK);
}
static void do_open(void) {
    char path[512];
    if (!choose_file(0, path, sizeof path)) return;
    if (bmp_load(path)) {
        snprintf(g_file, sizeof g_file, "%s", path);
        InvalidateRect(g_hwnd, NULL, TRUE);
        printf("paint: opened %s %dx%d\n", g_file, g_cw, g_ch); fflush(stdout);
    } else MessageBox(g_hwnd, "Not a supported BMP file.", "Paint", MB_OK);
}

/* ------------------------------------------------------------ menu */

static void set_tool(int t) {
    if (t < 0 || t >= T_COUNT) return;
    g_tool = t;
    HMENU m = GetMenu(g_hwnd);
    for (int i = 0; i < T_COUNT; i++)
        CheckMenuItem(m, ID_TOOL0 + i, i == t ? MF_CHECKED : MF_UNCHECKED);
    InvalidateRect(g_hwnd, NULL, FALSE);      /* toolbox highlight */
}
static void set_width(int w) {
    g_penw = w;
    HMENU m = GetMenu(g_hwnd);
    CheckMenuItem(m, ID_WIDTH1, w == 1 ? MF_CHECKED : MF_UNCHECKED);
    CheckMenuItem(m, ID_WIDTH3, w == 3 ? MF_CHECKED : MF_UNCHECKED);
    CheckMenuItem(m, ID_WIDTH5, w == 5 ? MF_CHECKED : MF_UNCHECKED);
}

static HMENU build_menu(void) {
    static const char *tools[T_COUNT] = {
        "Pencil", "Eraser", "Fill", "Line", "Rectangle",
        "Filled Rectangle", "Ellipse", "Filled Ellipse" };
    HMENU bar = CreateMenu();
    HMENU file = CreatePopupMenu();
    AppendMenuA(file, MF_STRING, ID_NEW,    "&New\tCtrl+N");
    AppendMenuA(file, MF_STRING, ID_OPEN,   "&Open...\tCtrl+O");
    AppendMenuA(file, MF_STRING, ID_SAVE,   "&Save\tCtrl+S");
    AppendMenuA(file, MF_STRING, ID_SAVEAS, "Save &As...");
    AppendMenuA(file, MF_SEPARATOR, 0, NULL);
    AppendMenuA(file, MF_STRING, ID_EXIT,   "E&xit");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)file, "&File");

    HMENU edit = CreatePopupMenu();
    AppendMenuA(edit, MF_STRING, ID_UNDO, "&Undo\tCtrl+Z");
    AppendMenuA(edit, MF_SEPARATOR, 0, NULL);
    AppendMenuA(edit, MF_STRING, ID_CUT,   "Cu&t");
    AppendMenuA(edit, MF_STRING, ID_COPY,  "&Copy");
    AppendMenuA(edit, MF_STRING, ID_PASTE, "&Paste");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)edit, "&Edit");

    HMENU img = CreatePopupMenu();
    AppendMenuA(img, MF_STRING, ID_CLEAR, "&Clear Image");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)img, "&Image");

    HMENU tm = CreatePopupMenu();
    for (int i = 0; i < T_COUNT; i++)
        AppendMenuA(tm, MF_STRING, ID_TOOL0 + i, tools[i]);
    AppendMenuA(tm, MF_SEPARATOR, 0, NULL);
    HMENU wm = CreatePopupMenu();
    AppendMenuA(wm, MF_STRING, ID_WIDTH1, "Thin");
    AppendMenuA(wm, MF_STRING, ID_WIDTH3, "Medium");
    AppendMenuA(wm, MF_STRING, ID_WIDTH5, "Thick");
    AppendMenuA(tm, MF_POPUP, (UINT_PTR)wm, "&Width");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)tm, "&Tools");

    HMENU help = CreatePopupMenu();
    AppendMenuA(help, MF_STRING, ID_ABOUT, "&About Paint");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)help, "&Help");
    return bar;
}

/* ------------------------------------------------------------ painting */

static void paint_tool_icon(HDC dc, int t, int cx, int cy) {
    /* a tiny representative glyph centered in the cell */
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(0, 0, 0));
    HPEN old = (HPEN)SelectObject(dc, pen);
    HBRUSH ob = (HBRUSH)SelectObject(dc, GetStockObject(NULL_BRUSH));
    switch (t) {
    case T_PENCIL: MoveToEx(dc, cx - 5, cy + 5, NULL); LineTo(dc, cx + 5, cy - 5); break;
    case T_ERASER: { RECT r; SetRect(&r, cx - 5, cy - 3, cx + 5, cy + 4);
                     FillRect(dc, &r, (HBRUSH)GetStockObject(WHITE_BRUSH));
                     FrameRect(dc, &r, (HBRUSH)GetStockObject(BLACK_BRUSH)); break; }
    case T_FILL:   { RECT r; SetRect(&r, cx - 5, cy - 1, cx + 5, cy + 5);
                     FillRect(dc, &r, (HBRUSH)GetStockObject(GRAY_BRUSH));
                     MoveToEx(dc, cx - 3, cy - 5, NULL); LineTo(dc, cx - 3, cy - 1); break; }
    case T_LINE:   MoveToEx(dc, cx - 5, cy + 5, NULL); LineTo(dc, cx + 5, cy - 5); break;
    case T_RECT:   Rectangle(dc, cx - 5, cy - 4, cx + 6, cy + 5); break;
    case T_FILLRECT: { SelectObject(dc, GetStockObject(GRAY_BRUSH));
                       Rectangle(dc, cx - 5, cy - 4, cx + 6, cy + 5);
                       SelectObject(dc, GetStockObject(NULL_BRUSH)); break; }
    case T_ELLIPSE: Ellipse(dc, cx - 5, cy - 4, cx + 6, cy + 5); break;
    case T_FILLELLIPSE: { SelectObject(dc, GetStockObject(GRAY_BRUSH));
                          Ellipse(dc, cx - 5, cy - 4, cx + 6, cy + 5);
                          SelectObject(dc, GetStockObject(NULL_BRUSH)); break; }
    }
    SelectObject(dc, ob);
    SelectObject(dc, old);
    DeleteObject(pen);
}

static void sunken(HDC dc, RECT r) {
    HPEN dk = CreatePen(PS_SOLID, 1, RGB(128, 128, 128));
    HPEN lt = CreatePen(PS_SOLID, 1, RGB(255, 255, 255));
    HPEN old = (HPEN)SelectObject(dc, dk);
    MoveToEx(dc, r.left, r.bottom, NULL); LineTo(dc, r.left, r.top); LineTo(dc, r.right, r.top);
    SelectObject(dc, lt);
    LineTo(dc, r.right, r.bottom); LineTo(dc, r.left, r.bottom);
    SelectObject(dc, old); DeleteObject(dk); DeleteObject(lt);
}

static void on_paint(HDC dc) {
    /* toolbox cells */
    for (int i = 0; i < T_COUNT; i++) {
        int col = i % TB_COLS, row = i / TB_COLS;
        int x = TB_X + col * TB_CELL, y = TB_Y + row * TB_CELL;
        RECT r; SetRect(&r, x, y, x + TB_CELL - 2, y + TB_CELL - 2);
        FillRect(dc, &r, (HBRUSH)GetStockObject(i == g_tool ? WHITE_BRUSH : LTGRAY_BRUSH));
        FrameRect(dc, &r, (HBRUSH)GetStockObject(BLACK_BRUSH));
        paint_tool_icon(dc, i, x + TB_CELL / 2 - 1, y + TB_CELL / 2 - 1);
    }
    /* canvas: sunken frame then blit */
    RECT cf; SetRect(&cf, CANVAS_X - 2, CANVAS_Y - 2, CANVAS_X + g_cw + 1, CANVAS_Y + g_ch + 1);
    sunken(dc, cf);
    BitBlt(dc, CANVAS_X, CANVAS_Y, g_cw, g_ch, g_mdc, 0, 0, SRCCOPY);
    /* palette swatches */
    int py = pal_y();
    for (int k = 0; k < 16; k++) {
        int col = k % PAL_COLS, row = k / PAL_COLS;
        int x = CANVAS_X + col * PAL_CELL, y = py + row * PAL_CELL;
        RECT r; SetRect(&r, x, y, x + PAL_CELL - 1, y + PAL_CELL - 1);
        HBRUSH br = CreateSolidBrush(g_pal[k]);
        FillRect(dc, &r, br); DeleteObject(br);
        FrameRect(dc, &r, (HBRUSH)GetStockObject(GRAY_BRUSH));
    }
    /* FG/BG indicator to the left of the palette */
    RECT bg; SetRect(&bg, 14, py + 4, 34, py + 24);
    RECT fg; SetRect(&fg, 6, py - 2, 26, py + 18);
    HBRUSH bb = CreateSolidBrush(g_bg), fb = CreateSolidBrush(g_fg);
    FillRect(dc, &bg, bb); FrameRect(dc, &bg, (HBRUSH)GetStockObject(BLACK_BRUSH));
    FillRect(dc, &fg, fb); FrameRect(dc, &fg, (HBRUSH)GetStockObject(BLACK_BRUSH));
    DeleteObject(bb); DeleteObject(fb);
}

/* ------------------------------------------------------------ hit test */

static int in_rect(int x, int y, int l, int t, int r, int b) {
    return x >= l && x < r && y >= t && y < b;
}

/* a palette/toolbox click; returns 1 if handled (not a canvas draw). */
static int chrome_click(int cx, int cy, int button) {
    /* toolbox */
    if (in_rect(cx, cy, TB_X, TB_Y, TB_X + TB_COLS * TB_CELL, TB_Y + TB_ROWS * TB_CELL)) {
        int col = (cx - TB_X) / TB_CELL, row = (cy - TB_Y) / TB_CELL;
        int t = row * TB_COLS + col;
        if (col < TB_COLS && t >= 0 && t < T_COUNT) { set_tool(t);
            printf("paint: tool=%d\n", t); fflush(stdout); }
        return 1;
    }
    /* palette */
    int py = pal_y();
    if (in_rect(cx, cy, CANVAS_X, py, CANVAS_X + PAL_COLS * PAL_CELL, py + 2 * PAL_CELL)) {
        int col = (cx - CANVAS_X) / PAL_CELL, row = (cy - py) / PAL_CELL;
        int k = row * PAL_COLS + col;
        if (k >= 0 && k < 16) {
            if (button == 2) g_bg = g_pal[k]; else g_fg = g_pal[k];
            InvalidateRect(g_hwnd, NULL, FALSE);
            printf("paint: %s=%06X\n", button == 2 ? "bg" : "fg",
                   (unsigned)(button == 2 ? g_bg : g_fg)); fflush(stdout);
        }
        return 1;
    }
    return 0;
}

/* map a client point to canvas bitmap coords, clamped. returns 1 if on canvas. */
static int to_canvas(int cx, int cy, int *bx, int *by) {
    int x = cx - CANVAS_X, y = cy - CANVAS_Y;
    if (bx) *bx = x < 0 ? 0 : x >= g_cw ? g_cw - 1 : x;
    if (by) *by = y < 0 ? 0 : y >= g_ch ? g_ch - 1 : y;
    return in_rect(cx, cy, CANVAS_X, CANVAS_Y, CANVAS_X + g_cw, CANVAS_Y + g_ch);
}

static COLORREF stroke_color(void) { return g_button == 2 ? g_bg : g_fg; }

/* ------------------------------------------------------------ wndproc */

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        g_hwnd = h;
        canvas_make(g_cw, g_ch);
        EnableMenuItem(GetMenu(h), ID_UNDO, MF_GRAYED);
        EnableMenuItem(GetMenu(h), ID_CUT, MF_GRAYED);
        EnableMenuItem(GetMenu(h), ID_COPY, MF_GRAYED);
        EnableMenuItem(GetMenu(h), ID_PASTE, MF_GRAYED);
        set_tool(T_PENCIL);
        set_width(1);
        mark("WM_CREATE");
        return 0;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (dc) on_paint(dc);
        EndPaint(h, &ps);
        static int first;
        if (!first) { first = 1; mark("WM_PAINT"); mark("ready"); }
        return 0;
    }

    case WM_LBUTTONDOWN:
    case WM_RBUTTONDOWN: {
        int cx = GET_X_LPARAM(lp), cy = GET_Y_LPARAM(lp);
        int button = msg == WM_RBUTTONDOWN ? 2 : 1;
        if (chrome_click(cx, cy, button)) return 0;
        int bx, by;
        if (!to_canvas(cx, cy, &bx, &by)) return 0;
        g_button = button;
        undo_push();
        if (g_tool == T_FILL) {
            flood_fill(bx, by, stroke_color());
            InvalidateRect(h, NULL, FALSE);
            return 0;
        }
        g_drawing = 1;
        g_x0 = g_lx = bx; g_y0 = g_ly = by;
        SetCapture(h);
        if (g_tool == T_PENCIL || g_tool == T_ERASER)
            draw_dot(bx, by, g_tool == T_ERASER ? g_bg : stroke_color());
        InvalidateRect(h, NULL, FALSE);
        return 0;
    }

    case WM_MOUSEMOVE: {
        if (!g_drawing) return 0;
        int bx, by; to_canvas(GET_X_LPARAM(lp), GET_Y_LPARAM(lp), &bx, &by);
        if (is_shape(g_tool)) {
            BitBlt(g_mdc, 0, 0, g_cw, g_ch, g_udc, 0, 0, SRCCOPY);   /* preview */
            draw_shape(g_tool, g_x0, g_y0, bx, by, stroke_color());
        } else {   /* pencil / eraser: freehand */
            COLORREF c = g_tool == T_ERASER ? g_bg : stroke_color();
            draw_seg(g_lx, g_ly, bx, by, c);
        }
        g_lx = bx; g_ly = by;
        InvalidateRect(h, NULL, FALSE);
        return 0;
    }

    case WM_LBUTTONUP:
    case WM_RBUTTONUP: {
        if (!g_drawing) return 0;
        int bx, by; to_canvas(GET_X_LPARAM(lp), GET_Y_LPARAM(lp), &bx, &by);
        if (is_shape(g_tool)) {
            BitBlt(g_mdc, 0, 0, g_cw, g_ch, g_udc, 0, 0, SRCCOPY);
            draw_shape(g_tool, g_x0, g_y0, bx, by, stroke_color());
        }
        g_drawing = 0;
        ReleaseCapture();
        InvalidateRect(h, NULL, FALSE);
        mark("stroke");
        return 0;
    }

    case WM_COMMAND: {
        int id = (int)LOWORD(wp);
        if (id >= ID_TOOL0 && id < ID_TOOL0 + T_COUNT) {
            set_tool(id - ID_TOOL0);
            printf("paint: tool=%d\n", id - ID_TOOL0); fflush(stdout);
            return 0;
        }
        switch (id) {
        case ID_NEW:
        case ID_CLEAR: {
            undo_push();
            RECT all; SetRect(&all, 0, 0, g_cw, g_ch);
            FillRect(g_mdc, &all, (HBRUSH)GetStockObject(WHITE_BRUSH));
            if (id == ID_NEW) g_file[0] = 0;
            InvalidateRect(h, NULL, FALSE);
            mark("new");
            return 0;
        }
        case ID_OPEN:   do_open(); return 0;
        case ID_SAVE:   do_save(0); return 0;
        case ID_SAVEAS: do_save(1); return 0;
        case ID_UNDO:   undo_apply(); return 0;
        case ID_WIDTH1: set_width(1); return 0;
        case ID_WIDTH3: set_width(3); return 0;
        case ID_WIDTH5: set_width(5); return 0;
        case ID_ABOUT:
            MessageBox(h, "Paint — the todos/0107 gdi32 accessory.", "About Paint", MB_OK);
            return 0;
        case ID_EXIT:   DestroyWindow(h); return 0;
        }
        return 0;
    }

    case WM_DESTROY:
        if (g_mdc) DeleteDC(g_mdc);
        if (g_udc) DeleteDC(g_udc);
        if (g_canvas) DeleteObject(g_canvas);
        if (g_undo) DeleteObject(g_undo);
        mark("WM_DESTROY");
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(int argc, char **argv) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = WndProc;
    wc.lpszClassName = "Paint";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;

    HMENU menu = build_menu();
    HWND hwnd = CreateWindowEx(0, "Paint", "untitled - Paint",
                               WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                               CW_USEDEFAULT, CW_USEDEFAULT,
                               client_w(), client_h() + 20,
                               NULL, menu, NULL, NULL);
    if (!hwnd) return 3;

    ACCEL acc[] = {
        { FVIRTKEY | FCONTROL, 'N', ID_NEW },
        { FVIRTKEY | FCONTROL, 'O', ID_OPEN },
        { FVIRTKEY | FCONTROL, 'S', ID_SAVE },
        { FVIRTKEY | FCONTROL, 'Z', ID_UNDO },
    };
    HACCEL ha = CreateAcceleratorTableA(acc, 4);

    /* a file named on argv opens at startup (the openwith path) */
    if (argc > 1 && argv[1] && argv[1][0]) {
        if (bmp_load(argv[1])) { snprintf(g_file, sizeof g_file, "%s", argv[1]);
            InvalidateRect(hwnd, NULL, TRUE); }
    }

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        if (ha && TranslateAcceleratorW(hwnd, ha, &msg)) continue;
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    mark("bye");
    return (int)msg.wParam;
}
