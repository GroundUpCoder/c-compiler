/* gdidemo.c — the 0057 gdi32 acceptance app (todos/WIN32.md).
 *
 * Two modes:
 *   gdidemo            windowed: a Petzold-style WM_PAINT scene (shapes,
 *                      text, blits) into a fixed 480x360 surface — every
 *                      visual is deterministic so wmctl shot is a golden.
 *   gdidemo selftest   headless: memory-DC pixel asserts (GDI semantics:
 *                      right/bottom exclusivity, LineTo endpoint, ROP2,
 *                      clip, blits, DIB swizzle, text) + the leak check
 *                      (repeated paint cycles free every object/DC).
 *                      Prints "ok NAME"/"FAIL NAME", exits nonzero on FAIL.
 *
 * Since 0058 the window half is a REAL Win32 app: RegisterClass +
 * CreateWindowEx + the classic blocking GetMessage loop (it was the
 * __gdi_bind_hwnd scaffold over an SDL window before user32 existed).
 * The scene paints once per WM_PAINT; the shm surface persists, so
 * repeated `wmctl shot`s stay bit-exact.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WIN_W 480
#define WIN_H 360

/* ============================================================ the scene
 * Coordinates are load-bearing: tests/kernel/test_gdi32_e2e.js probes
 * exact pixels of this layout. Change them together. */

static void draw_scene(HDC hdc) {
    RECT rc;
    SetRect(&rc, 0, 0, WIN_W, WIN_H);
    FillRect(hdc, &rc, (HBRUSH)GetStockObject(WHITE_BRUSH));

    /* Row 1: the classic shapes. */
    HPEN pen3 = CreatePen(PS_SOLID, 3, RGB(0, 0, 0));
    HBRUSH red = CreateSolidBrush(RGB(220, 40, 40));
    HGDIOBJ oldPen = SelectObject(hdc, (HGDIOBJ)pen3);
    HGDIOBJ oldBrush = SelectObject(hdc, (HGDIOBJ)red);
    Rectangle(hdc, 20, 20, 140, 100);
    SelectObject(hdc, oldPen);

    HBRUSH blue = CreateSolidBrush(RGB(40, 80, 220));
    SelectObject(hdc, (HGDIOBJ)blue);
    Ellipse(hdc, 160, 20, 280, 100);

    HBRUSH green = CreateSolidBrush(RGB(40, 180, 90));
    SelectObject(hdc, (HGDIOBJ)green);
    RoundRect(hdc, 300, 20, 440, 100, 24, 24);

    /* Row 2: polygon, hatch, thick lines. */
    HBRUSH yellow = CreateSolidBrush(RGB(250, 200, 40));
    SelectObject(hdc, (HGDIOBJ)yellow);
    POINT tri[3] = { {80, 130}, {140, 230}, {20, 230} };
    Polygon(hdc, tri, 3);

    HBRUSH hatch = CreateHatchBrush(HS_DIAGCROSS, RGB(150, 40, 150));
    RECT hr;
    SetRect(&hr, 160, 130, 280, 230);
    FillRect(hdc, &hr, hatch);   /* OPAQUE default: gaps fill white */

    HPEN pen5 = CreatePen(PS_SOLID, 5, RGB(180, 30, 30));
    SelectObject(hdc, (HGDIOBJ)pen5);
    MoveToEx(hdc, 300, 130, NULL);
    LineTo(hdc, 440, 230);
    MoveToEx(hdc, 440, 130, NULL);
    LineTo(hdc, 300, 230);

    /* Row 3: text. */
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, RGB(0, 0, 0));
    TextOut(hdc, 20, 245, "Hello, GDI!", 11);
    SetBkMode(hdc, OPAQUE);
    SetBkColor(hdc, RGB(255, 255, 0));
    SetTextColor(hdc, RGB(0, 0, 200));
    TextOut(hdc, 20, 275, "Opaque", 6);
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, RGB(0, 0, 0));
    RECT tr;
    SetRect(&tr, 300, 245, 460, 300);
    DrawText(hdc, "Centered", -1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    /* Row 4: blits — checkerboard via a memory DC. */
    HDC mem = CreateCompatibleDC(hdc);
    HBITMAP bm = CreateCompatibleBitmap(hdc, 40, 40);
    HGDIOBJ oldBm = SelectObject(mem, (HGDIOBJ)bm);
    PatBlt(mem, 0, 0, 40, 40, WHITENESS);
    HBRUSH cbBlue = CreateSolidBrush(RGB(0, 120, 215));
    RECT q;
    SetRect(&q, 0, 0, 20, 20);
    FillRect(mem, &q, cbBlue);
    SetRect(&q, 20, 20, 40, 40);
    FillRect(mem, &q, cbBlue);
    BitBlt(hdc, 20, 310, 40, 40, mem, 0, 0, SRCCOPY);
    StretchBlt(hdc, 80, 310, 80, 40, mem, 0, 0, 40, 40, SRCCOPY);
    SelectObject(mem, oldBm);

    /* Leak discipline: everything created above dies here. */
    DeleteObject((HGDIOBJ)bm);
    DeleteDC(mem);
    SelectObject(hdc, oldBrush);
    DeleteObject((HGDIOBJ)cbBlue);
    DeleteObject((HGDIOBJ)pen5);
    DeleteObject((HGDIOBJ)hatch);
    DeleteObject((HGDIOBJ)yellow);
    DeleteObject((HGDIOBJ)green);
    DeleteObject((HGDIOBJ)blue);
    DeleteObject((HGDIOBJ)red);
    DeleteObject((HGDIOBJ)pen3);
}

/* ============================================================ window mode */

static int g_painted;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        if (!hdc) return 0;
        draw_scene(hdc);
        EndPaint(hwnd, &ps);
        if (!g_painted) {
            g_painted = 1;
            printf("gdidemo: painted\n");
            fflush(stdout);
        }
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

static int run_window(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = WndProc;
    wc.lpszClassName = "gdidemo";
    if (!RegisterClass(&wc)) return 3;
    HWND hwnd = CreateWindowEx(0, "gdidemo", "GDI Demo", WS_OVERLAPPED | WS_VISIBLE,
                               CW_USEDEFAULT, CW_USEDEFAULT, WIN_W, WIN_H,
                               NULL, NULL, NULL, NULL);
    if (!hwnd) return 3;
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return (int)msg.wParam;
}

/* ============================================================ selftest */

static int g_fails, g_checks;

static void check(const char *name, int cond) {
    g_checks++;
    if (cond) printf("ok %s\n", name);
    else { printf("FAIL %s\n", name); g_fails++; }
}

static HDC mkdc(int w, int h, HBITMAP *bmOut) {
    HDC dc = CreateCompatibleDC(NULL);
    HBITMAP bm = CreateCompatibleBitmap(NULL, w, h);
    SelectObject(dc, (HGDIOBJ)bm);
    PatBlt(dc, 0, 0, w, h, WHITENESS);
    *bmOut = bm;
    return dc;
}

static void selftest(void) {
    HBITMAP bm;
    HDC dc;

    /* --- Rectangle: right/bottom exclusive, pen + brush --- */
    dc = mkdc(40, 30, &bm);
    HPEN blackPen = (HPEN)GetStockObject(BLACK_PEN);
    HBRUSH redBr = CreateSolidBrush(RGB(200, 0, 0));
    SelectObject(dc, (HGDIOBJ)blackPen);
    HGDIOBJ oldBr = SelectObject(dc, (HGDIOBJ)redBr);
    Rectangle(dc, 5, 5, 20, 15);
    check("rect_border_topleft", GetPixel(dc, 5, 5) == RGB(0, 0, 0));
    check("rect_interior", GetPixel(dc, 10, 10) == RGB(200, 0, 0));
    check("rect_border_right", GetPixel(dc, 19, 10) == RGB(0, 0, 0));
    check("rect_right_exclusive", GetPixel(dc, 20, 10) == RGB(255, 255, 255));
    check("rect_border_bottom", GetPixel(dc, 10, 14) == RGB(0, 0, 0));
    check("rect_bottom_exclusive", GetPixel(dc, 10, 15) == RGB(255, 255, 255));
    SelectObject(dc, oldBr);
    DeleteObject((HGDIOBJ)redBr);

    /* --- LineTo: draws up to but NOT including the endpoint --- */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    MoveToEx(dc, 2, 2, NULL);
    LineTo(dc, 10, 2);
    check("lineto_start", GetPixel(dc, 2, 2) == RGB(0, 0, 0));
    check("lineto_body", GetPixel(dc, 9, 2) == RGB(0, 0, 0));
    check("lineto_end_excluded", GetPixel(dc, 10, 2) == RGB(255, 255, 255));
    POINT cur;
    MoveToEx(dc, 0, 0, &cur);
    check("lineto_updates_pos", cur.x == 10 && cur.y == 2);

    /* --- ROP2: XOR pen over white --- */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    HPEN redPen = CreatePen(PS_SOLID, 1, RGB(255, 0, 0));
    HGDIOBJ oldPen = SelectObject(dc, (HGDIOBJ)redPen);
    SetROP2(dc, R2_XORPEN);
    MoveToEx(dc, 0, 5, NULL);
    LineTo(dc, 10, 5);
    check("rop2_xor", GetPixel(dc, 5, 5) == RGB(0, 255, 255));
    MoveToEx(dc, 0, 5, NULL);
    LineTo(dc, 10, 5);            /* XOR twice = restore */
    check("rop2_xor_restores", GetPixel(dc, 5, 5) == RGB(255, 255, 255));
    SetROP2(dc, R2_COPYPEN);
    SelectObject(dc, oldPen);
    DeleteObject((HGDIOBJ)redPen);

    /* --- Clip --- */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    IntersectClipRect(dc, 0, 0, 10, 10);
    RECT full;
    SetRect(&full, 0, 0, 40, 30);
    FillRect(dc, &full, (HBRUSH)GetStockObject(BLACK_BRUSH));
    check("clip_inside_painted", GetPixel(dc, 5, 5) == RGB(0, 0, 0));
    check("clip_outside_reads_invalid", GetPixel(dc, 15, 5) == CLR_INVALID);
    SelectClipRgn(dc, NULL);
    check("clip_reset", GetPixel(dc, 15, 5) == RGB(255, 255, 255));

    /* --- GetPixel out of bounds --- */
    check("getpixel_oob_neg", GetPixel(dc, -1, 0) == CLR_INVALID);
    check("getpixel_oob_pos", GetPixel(dc, 40, 0) == CLR_INVALID);

    /* --- Ellipse / Polygon interiors --- */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    HBRUSH blueBr = CreateSolidBrush(RGB(0, 0, 200));
    oldBr = SelectObject(dc, (HGDIOBJ)blueBr);
    Ellipse(dc, 0, 0, 20, 20);
    check("ellipse_center", GetPixel(dc, 10, 10) == RGB(0, 0, 200));
    check("ellipse_corner_untouched", GetPixel(dc, 0, 0) == RGB(255, 255, 255));
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    POINT tri[3] = { {10, 2}, {18, 18}, {2, 18} };
    Polygon(dc, tri, 3);
    check("polygon_interior", GetPixel(dc, 10, 12) == RGB(0, 0, 200));
    check("polygon_outside", GetPixel(dc, 2, 4) == RGB(255, 255, 255));
    SelectObject(dc, oldBr);
    DeleteObject((HGDIOBJ)blueBr);

    /* --- BitBlt copy between DCs --- */
    HBITMAP bm2;
    HDC dc2 = mkdc(16, 16, &bm2);
    SetPixel(dc2, 3, 4, RGB(1, 2, 3));
    BitBlt(dc, 0, 0, 16, 16, dc2, 0, 0, SRCCOPY);
    check("bitblt_copy", GetPixel(dc, 3, 4) == RGB(1, 2, 3));

    /* --- BitBlt overlap on one buffer (staged source) --- */
    PatBlt(dc2, 0, 0, 16, 16, WHITENESS);
    SetPixel(dc2, 0, 0, RGB(10, 0, 0));
    SetPixel(dc2, 1, 0, RGB(0, 20, 0));
    SetPixel(dc2, 2, 0, RGB(0, 0, 30));
    BitBlt(dc2, 2, 0, 10, 10, dc2, 0, 0, SRCCOPY);   /* shift right by 2 */
    check("bitblt_overlap", GetPixel(dc2, 2, 0) == RGB(10, 0, 0) &&
                            GetPixel(dc2, 3, 0) == RGB(0, 20, 0) &&
                            GetPixel(dc2, 4, 0) == RGB(0, 0, 30));

    /* --- StretchBlt 2x nearest-neighbor --- */
    PatBlt(dc2, 0, 0, 16, 16, WHITENESS);
    SetPixel(dc2, 0, 0, RGB(5, 6, 7));
    SetPixel(dc2, 1, 1, RGB(8, 9, 10));
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    StretchBlt(dc, 0, 0, 4, 4, dc2, 0, 0, 2, 2, SRCCOPY);
    check("stretchblt_2x", GetPixel(dc, 0, 0) == RGB(5, 6, 7) &&
                           GetPixel(dc, 1, 1) == RGB(5, 6, 7) &&
                           GetPixel(dc, 2, 2) == RGB(8, 9, 10) &&
                           GetPixel(dc, 3, 3) == RGB(8, 9, 10));

    /* --- PatBlt rops --- */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    PatBlt(dc, 0, 0, 4, 4, BLACKNESS);
    check("patblt_blackness", GetPixel(dc, 1, 1) == RGB(0, 0, 0));
    PatBlt(dc, 0, 0, 4, 4, DSTINVERT);
    check("patblt_dstinvert", GetPixel(dc, 1, 1) == RGB(255, 255, 255));

    /* --- DIB round-trip (B<->R swizzle, bottom-up) --- */
    PatBlt(dc2, 0, 0, 16, 16, WHITENESS);
    SetPixel(dc2, 0, 0, RGB(10, 20, 30));
    static unsigned int dib[16 * 16];
    BITMAPINFO bmi;
    memset(&bmi, 0, sizeof bmi);
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = 16;
    bmi.bmiHeader.biHeight = 16;   /* bottom-up */
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    int got = GetDIBits(NULL, bm2, 0, 16, dib, &bmi, DIB_RGB_COLORS);
    check("getdibits_lines", got == 16);
    /* pixel (0,0) is the TOP row -> bottom-up DIB row 15; B,G,R order */
    check("getdibits_swizzle", dib[15 * 16 + 0] == ((10u << 16) | (20u << 8) | 30u));
    HBITMAP bm3;
    HDC dc3 = mkdc(16, 16, &bm3);
    check("setdibits_lines", SetDIBits(NULL, bm3, 0, 16, dib, &bmi, DIB_RGB_COLORS) == 16);
    check("setdibits_roundtrip", GetPixel(dc3, 0, 0) == RGB(10, 20, 30));

    /* --- Text (needs the image font; loads lazily) --- */
    SIZE sz1, sz3;
    int fontOk = GetTextExtentPoint32(dc, "M", 1, &sz1) &&
                 GetTextExtentPoint32(dc, "MMM", 3, &sz3);
    check("text_extent", fontOk && sz1.cx > 0 && sz3.cx == 3 * sz1.cx && sz1.cy > 0);
    TEXTMETRIC tm;
    check("text_metrics", GetTextMetrics(dc, &tm) &&
                          tm.tmHeight == tm.tmAscent + tm.tmDescent &&
                          tm.tmAscent > 0);
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(0, 0, 0));
    TextOut(dc, 1, 1, "X", 1);
    int ink = 0;
    for (int y = 0; y < 30 && !ink; y++)
        for (int x = 0; x < 40; x++)
            if (GetPixel(dc, x, y) != RGB(255, 255, 255)) { ink = 1; break; }
    check("text_ink", ink);
    RECT cr;
    SetRect(&cr, 0, 0, 100, 100);
    int th = DrawText(dc, "Hi", -1, &cr, DT_CALCRECT | DT_SINGLELINE);
    check("drawtext_calcrect", th == tm.tmHeight && cr.bottom == th &&
                               cr.right > 0 && cr.right <= 100);

    /* --- UTF-8 text (0211): measure/draw step by CODE POINT, not byte.
     * Mono font: "é" (2 bytes) is ONE glyph advance, "λ…" (5 bytes) two.
     * A code point the face lacks renders .notdef (still one advance). */
    SIZE szA, szU, szL;
    int u8Ok = GetTextExtentPoint32(dc, "e", 1, &szA) &&
               GetTextExtentPoint32(dc, "\xC3\xA9", 2, &szU) &&        /* é */
               GetTextExtentPoint32(dc, "\xCE\xBB\xE2\x80\xA6", 5, &szL); /* λ… */
    check("utf8_extent_cp", u8Ok && szU.cx == szA.cx && szL.cx == 2 * szA.cx);
    /* "é?" side by side: the two mono cells must have ink AND differ —
     * pre-0211 every non-ASCII byte drew '?', making the cells identical. */
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    TextOut(dc, 1, 1, "\xC3\xA9?", 3);
    int inkU = 0, diffU = 0;
    for (int y = 0; y < 30; y++)
        for (int x = 1; x < 1 + szA.cx; x++) {
            if (GetPixel(dc, x, y) != RGB(255, 255, 255)) inkU++;
            if (GetPixel(dc, x, y) != GetPixel(dc, x + szA.cx, y)) diffU = 1;
        }
    check("utf8_draws_real_glyph", inkU > 0 && diffU);
    /* face lacks U+55E8 → .notdef tofu box: one advance, ink, not '?' */
    SIZE szX;
    check("utf8_notdef_extent",
          GetTextExtentPoint32(dc, "\xE5\x97\xA8", 3, &szX) && szX.cx > 0);
    PatBlt(dc, 0, 0, 40, 30, WHITENESS);
    TextOut(dc, 1, 1, "\xE5\x97\xA8?", 4);
    int inkN = 0, diffN = 0;
    for (int y = 0; y < 30; y++)
        for (int x = 1; x < 1 + szX.cx; x++) {
            if (GetPixel(dc, x, y) != RGB(255, 255, 255)) inkN++;
            if (GetPixel(dc, x, y) != GetPixel(dc, x + szX.cx, y)) diffN = 1;
        }
    check("utf8_notdef_ink", inkN > 0 && diffN);

    /* --- Object management --- */
    check("delete_selected_bitmap_refused", DeleteObject((HGDIOBJ)bm) == FALSE);
    check("stock_delete_noop", DeleteObject(GetStockObject(BLACK_PEN)) == TRUE);
    HGDIOBJ notBitmap = GetStockObject(BLACK_PEN);
    check("select_bitmap_type_checked",
          SelectObject(dc, (HGDIOBJ)GetStockObject(WHITE_BRUSH)) != NULL &&
          SelectObject(dc2, notBitmap) != NULL);
    check("muldiv", MulDiv(10, 3, 2) == 15 && MulDiv(1, 1, 2) == 1);

    DeleteDC(dc3);
    DeleteObject((HGDIOBJ)bm3);
    DeleteDC(dc2);
    DeleteObject((HGDIOBJ)bm2);
    DeleteDC(dc);
    DeleteObject((HGDIOBJ)bm);

    /* --- Leak discipline: paint cycles return the counts to baseline --- */
    int objBase = __gdi_object_count();
    int dcBase = __gdi_dc_count();
    for (int i = 0; i < 200; i++) {
        HBITMAP b;
        HDC d = mkdc(64, 48, &b);
        HPEN p = CreatePen(PS_SOLID, 2, RGB(i & 255, 0, 0));
        HBRUSH br = CreateSolidBrush(RGB(0, i & 255, 0));
        HFONT ft = CreateFont(-12, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                              0, 0, DEFAULT_QUALITY, DEFAULT_PITCH, "mono");
        HGDIOBJ op = SelectObject(d, (HGDIOBJ)p);
        HGDIOBJ ob = SelectObject(d, (HGDIOBJ)br);
        HGDIOBJ of = SelectObject(d, (HGDIOBJ)ft);
        Rectangle(d, 2, 2, 60, 40);
        Ellipse(d, 5, 5, 30, 30);
        TextOut(d, 4, 4, "leak", 4);
        SelectObject(d, op);
        SelectObject(d, ob);
        SelectObject(d, of);
        DeleteObject((HGDIOBJ)ft);
        DeleteObject((HGDIOBJ)br);
        DeleteObject((HGDIOBJ)p);
        DeleteDC(d);
        DeleteObject((HGDIOBJ)b);
    }
    check("leak_objects", __gdi_object_count() == objBase);
    check("leak_dcs", __gdi_dc_count() == dcBase);

    if (g_fails) {
        printf("SELFTEST: %d/%d FAILED\n", g_fails, g_checks);
        exit(1);
    }
    printf("SELFTEST: %d/%d PASS\n", g_checks, g_checks);
    exit(0);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) selftest();
    return run_window();
}
