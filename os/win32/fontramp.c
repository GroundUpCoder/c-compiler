/* fontramp.c — the C1 multi-face CreateFont acceptance app (ticket #281,
 * todos/WIN32.md font section; the gdidemo/ctldemo precedent).
 *
 * Two modes:
 *   fontramp [FACE] [bold] [italic] [ul] [so]
 *       windowed: a size ramp (12..34px) of a pangram in the requested
 *       face/style, plus a style row (bold / italic / underline /
 *       strikeout / combined) — every visual deterministic, so
 *       `wmctl shot` captures per-face evidence. FACE is passed to
 *       CreateFont verbatim ("mono", "sans", "serif", "Courier New",
 *       ...); "default" passes NULL (the mapper's no-name path).
 *
 *   fontramp probe [FACE] [bold] [italic] [ul] [so] [px N] [text STR]
 *       headless: creates the font, renders STR into a memory DC, and
 *       prints parseable metric lines (tm:/adv:/ext:/ink:) for the e2e
 *       legs in tests/kernel/test_gdi32_e2e.js — relationships between
 *       probes (proportional vs mono advances, bold ink weight, shear
 *       advance identity, /etc override reach) are asserted JS-side,
 *       not baked in here.
 *
 * The ink hash is FNV-1a over the rendered RGBA span — a cheap stable
 * fingerprint: two probes drawing identically hash identically, any
 * visible difference (weight, slant, face) moves it.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RAMP_W 640
#define RAMP_H 420

static const char *g_face = "mono";     /* NULL after "default" */
static int g_bold, g_ital, g_ul, g_so;

static HFONT make_font(int px, int bold, int ital, int ul, int so) {
    return CreateFont(-px, 0, 0, 0, bold ? FW_BOLD : FW_NORMAL,
                      (DWORD)ital, (DWORD)ul, (DWORD)so,
                      DEFAULT_CHARSET, 0, 0, DEFAULT_QUALITY,
                      DEFAULT_PITCH, g_face);
}

/* ============================================================ probe */

static unsigned adv_of(HDC dc, const char *s) {
    SIZE sz;
    GetTextExtentPoint32(dc, s, (int)strlen(s), &sz);
    return (unsigned)sz.cx;
}

static int probe(int px, const char *text) {
    HDC dc = CreateCompatibleDC(NULL);
    HBITMAP bm = CreateCompatibleBitmap(NULL, 560, 80);
    if (!dc || !bm) { fprintf(stderr, "fontramp: no memory DC\n"); return 1; }
    SelectObject(dc, (HGDIOBJ)bm);
    HFONT f = make_font(px, g_bold, g_ital, g_ul, g_so);
    if (!f) { fprintf(stderr, "fontramp: CreateFont failed\n"); return 1; }
    SelectObject(dc, (HGDIOBJ)f);

    TEXTMETRIC tm;
    if (!GetTextMetrics(dc, &tm)) {
        fprintf(stderr, "fontramp: GetTextMetrics failed\n");
        return 1;
    }
    printf("probe: face=%s bold=%d ital=%d ul=%d so=%d px=%d\n",
           g_face ? g_face : "(null)", g_bold, g_ital, g_ul, g_so, px);
    printf("tm: h=%d asc=%d desc=%d avew=%d maxw=%d weight=%d italic=%d "
           "ul=%d so=%d pf=%d\n",
           (int)tm.tmHeight, (int)tm.tmAscent, (int)tm.tmDescent,
           (int)tm.tmAveCharWidth, (int)tm.tmMaxCharWidth, (int)tm.tmWeight,
           (int)tm.tmItalic, (int)tm.tmUnderlined, (int)tm.tmStruckOut,
           (int)tm.tmPitchAndFamily);
    printf("adv: i=%u M=%u x=%u W=%u\n",
           adv_of(dc, "i"), adv_of(dc, "M"), adv_of(dc, "x"), adv_of(dc, "W"));
    SIZE sz;
    GetTextExtentPoint32(dc, text, (int)strlen(text), &sz);
    printf("ext: cx=%d cy=%d\n", (int)sz.cx, (int)sz.cy);

    /* Render + fingerprint (white bg, black ink; the whole 560x80 span). */
    RECT rc;
    SetRect(&rc, 0, 0, 560, 80);
    FillRect(dc, &rc, (HBRUSH)GetStockObject(WHITE_BRUSH));
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(0, 0, 0));
    TextOut(dc, 4, 8, text, (int)strlen(text));
    BITMAP info;
    GetObject((HGDIOBJ)bm, (int)sizeof info, &info);
    const unsigned char *bits = (const unsigned char *)info.bmBits;
    unsigned hash = 2166136261u, ink = 0;
    for (int i = 0; i < 560 * 80 * 4; i++) {
        hash = (hash ^ bits[i]) * 16777619u;
        if ((i & 3) == 0 && bits[i] != 255) ink++;   /* non-white R channel */
    }
    printf("ink: n=%u hash=%08x\n", ink, hash);
    return 0;
}

/* ============================================================ window */

static void draw_ramp(HDC dc) {
    static const int SIZES[] = { 12, 14, 17, 20, 26, 34 };
    static const char PANGRAM[] =
        "The quick brown fox jumps over the lazy dog 0123456789";
    RECT rc;
    SetRect(&rc, 0, 0, RAMP_W, RAMP_H);
    FillRect(dc, &rc, (HBRUSH)GetStockObject(WHITE_BRUSH));
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(0, 0, 0));

    char hdr[128];
    snprintf(hdr, sizeof hdr, "%s%s%s%s%s",
             g_face ? g_face : "(default)",
             g_bold ? " bold" : "", g_ital ? " italic" : "",
             g_ul ? " underline" : "", g_so ? " strikeout" : "");
    HFONT hf = make_font(20, 1, 0, 0, 0);
    HGDIOBJ hprev = SelectObject(dc, (HGDIOBJ)hf);
    TextOut(dc, 12, 8, hdr, (int)strlen(hdr));
    SelectObject(dc, hprev);            /* select out before delete (0211) */
    DeleteObject((HGDIOBJ)hf);

    int y = 44;
    for (int i = 0; i < (int)(sizeof SIZES / sizeof SIZES[0]); i++) {
        int px = SIZES[i];
        char line[160];
        snprintf(line, sizeof line, "%dpx %s", px, PANGRAM);
        HFONT f = make_font(px, g_bold, g_ital, g_ul, g_so);
        HGDIOBJ prev = SelectObject(dc, (HGDIOBJ)f);
        TextOut(dc, 12, y, line, (int)strlen(line));
        SelectObject(dc, prev);
        DeleteObject((HGDIOBJ)f);
        y += px + 12;
    }

    /* Style row: the four axes at 20px, on TOP of the requested spec's
     * family (bold/italic here override the flags, ul/so add rules). */
    static const struct { const char *label; int b, it, ul, so; } STYLES[] = {
        { "regular", 0, 0, 0, 0 }, { "bold", 1, 0, 0, 0 },
        { "italic", 0, 1, 0, 0 },  { "bold-italic", 1, 1, 0, 0 },
        { "underline", 0, 0, 1, 0 }, { "strikeout", 0, 0, 0, 1 },
    };
    int x = 12;
    for (int i = 0; i < (int)(sizeof STYLES / sizeof STYLES[0]); i++) {
        HFONT f = make_font(20, STYLES[i].b, STYLES[i].it,
                            STYLES[i].ul, STYLES[i].so);
        HGDIOBJ prev = SelectObject(dc, (HGDIOBJ)f);
        TextOut(dc, x, y, STYLES[i].label, (int)strlen(STYLES[i].label));
        SIZE sz;
        GetTextExtentPoint32(dc, STYLES[i].label,
                             (int)strlen(STYLES[i].label), &sz);
        x += sz.cx + 18;
        SelectObject(dc, prev);
        DeleteObject((HGDIOBJ)f);
    }
    printf("fontramp: painted\n");
    fflush(stdout);
}

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        draw_ramp(dc);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(int argc, char **argv) {
    int i = 1, doProbe = 0, px = 20;
    const char *text = "Hamburgefonstiv 0123456789";
    if (i < argc && !strcmp(argv[i], "probe")) { doProbe = 1; i++; }
    if (i < argc && strcmp(argv[i], "bold") && strcmp(argv[i], "italic") &&
        strcmp(argv[i], "ul") && strcmp(argv[i], "so") &&
        strcmp(argv[i], "px") && strcmp(argv[i], "text")) {
        g_face = strcmp(argv[i], "default") ? argv[i] : NULL;
        i++;
    }
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "bold")) g_bold = 1;
        else if (!strcmp(argv[i], "italic")) g_ital = 1;
        else if (!strcmp(argv[i], "ul")) g_ul = 1;
        else if (!strcmp(argv[i], "so")) g_so = 1;
        else if (!strcmp(argv[i], "px") && i + 1 < argc) px = atoi(argv[++i]);
        else if (!strcmp(argv[i], "text") && i + 1 < argc) text = argv[++i];
        else { fprintf(stderr, "fontramp: bad arg %s\n", argv[i]); return 2; }
    }
    if (doProbe) return probe(px, text);

    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "FontRamp";
    RegisterClass(&wc);
    char title[96];
    snprintf(title, sizeof title, "Font Ramp - %s%s%s",
             g_face ? g_face : "default",
             g_bold ? " bold" : "", g_ital ? " italic" : "");
    HWND w = CreateWindowEx(0, "FontRamp", title, WS_OVERLAPPED | WS_VISIBLE,
                            CW_USEDEFAULT, CW_USEDEFAULT, RAMP_W, RAMP_H,
                            NULL, NULL, NULL, NULL);
    if (!w) { fprintf(stderr, "fontramp: CreateWindow failed\n"); return 1; }
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return (int)msg.wParam;
}
