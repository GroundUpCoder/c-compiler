/* fontramp — bughunt probe app (NOT for merge): draws a text ramp at many
 * CreateFont pixel sizes through the gdi32/freetype pipeline, AA and
 * NONANTIALIASED, so aliasing artifacts can be screenshot-inspected per size. */
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define WIN_W 980
#define WIN_H 760

static const int SIZES[] = { 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32 };
#define NSIZES ((int)(sizeof SIZES / sizeof SIZES[0]))

static void draw(HDC dc) {
    RECT r; SetRect(&r, 0, 0, WIN_W, WIN_H);
    HBRUSH white = (HBRUSH)GetStockObject(WHITE_BRUSH);
    FillRect(dc, &r, white);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(0, 0, 0));
    int y = 8;
    for (int m = 0; m < 2; m++) {              /* 0 = AA, 1 = mono */
        for (int i = 0; i < NSIZES; i++) {
            int px = SIZES[i];
            HFONT f = CreateFont(-px, 0, 0, 0, FW_NORMAL, 0, 0, 0,
                                 DEFAULT_CHARSET, 0, 0,
                                 m ? NONANTIALIASED_QUALITY : DEFAULT_QUALITY,
                                 0, "");
            HGDIOBJ of = SelectObject(dc, (HGDIOBJ)f);
            char line[160];
            snprintf(line, sizeof line,
                     "%2d%s Sphinx of black quartz judge my vow 0123456789 Illegal Immmlll",
                     px, m ? "M" : "A");
            TextOut(dc, 8, y, line, (int)strlen(line));
            SelectObject(dc, of);
            DeleteObject((HGDIOBJ)f);
            y += px + 6;
        }
        y += 10;
    }
}

static int g_painted;

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        draw(dc);
        EndPaint(h, &ps);
        if (!g_painted) { g_painted = 1; printf("fontramp: painted\n"); fflush(stdout); }
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = WndProc;
    wc.lpszClassName = "fontramp";
    if (!RegisterClass(&wc)) return 3;
    HWND hwnd = CreateWindowEx(0, "fontramp", "Font Ramp", WS_OVERLAPPED | WS_VISIBLE,
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
