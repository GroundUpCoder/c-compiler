/* ctlpanel.c — the control panel (todos/0048, desktop apps wave 1).
 *
 * v1 surface: the MASTER VOLUME (the 0048 kernel addition — AUDIO_GAIN on
 * the 0017 mixer, reached through host.js's __audio_gain import: percent
 * 0..200, negative queries) as a scrollbar + step buttons, and a system
 * info panel read the POSIX way (/usr/share/os-release, /proc/uptime —
 * the 0043 synthetic /proc). The wallpaper picker is 0049's.
 *
 * Agent-drivable (OS.md pillar): `wmctl click "Vol +"`/"Vol -" steps,
 * `wmctl settext EDIT:0 55` + `wmctl click Set` goes absolute, and the
 * volume label reads back via gettext — the e2e drives exactly that. */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__import int __audio_gain(int gain);             /* host.js; -1 = no mixer */

#define ID_LABEL 100
#define ID_BAR   101
#define ID_DOWN  102
#define ID_UP    103
#define ID_EDIT  104
#define ID_SET   105

static HWND g_win, g_label, g_bar, g_edit;
static int g_gain = -1;                          /* mirrored kernel percent */

static void show_gain(void) {
    char buf[48];
    if (g_gain < 0) snprintf(buf, sizeof buf, "Volume: (no mixer)");
    else snprintf(buf, sizeof buf, "Volume: %d%%", g_gain);
    SetWindowText(g_label, buf);
    if (g_gain >= 0) SetScrollPos(g_bar, SB_CTL, g_gain, TRUE);
}

static void set_gain(int pct) {
    if (pct < 0) pct = 0;
    if (pct > 200) pct = 200;
    int r = __audio_gain(pct);
    if (r >= 0) g_gain = r;
    show_gain();
}

/* one info line per read: "NAME=wasm-os" etc + uptime */
static void add_info(HWND parent, int *y) {
    char line[96], text[128];
    FILE *f = fopen("/usr/share/os-release", "r");
    while (f && fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = 0;
        snprintf(text, sizeof text, "%s", line);
        CreateWindowEx(0, "STATIC", text, WS_CHILD | WS_VISIBLE,
                       16, *y, 248, 16, parent, NULL, NULL, NULL);
        *y += 18;
    }
    if (f) fclose(f);
    f = fopen("/proc/uptime", "r");
    if (f) {
        double up = 0;
        if (fscanf(f, "%lf", &up) == 1) {
            snprintf(text, sizeof text, "UPTIME=%ds", (int)up);
            CreateWindowEx(0, "STATIC", text, WS_CHILD | WS_VISIBLE,
                           16, *y, 248, 16, parent, NULL, NULL, NULL);
            *y += 18;
        }
        fclose(f);
    }
}

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        CreateWindowEx(0, "BUTTON", "Sound", WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 264, 88, h, NULL, NULL, NULL);
        g_label = CreateWindowEx(0, "STATIC", "Volume:", WS_CHILD | WS_VISIBLE,
                                 16, 24, 140, 16, h, (HMENU)ID_LABEL, NULL, NULL);
        g_bar = CreateWindowEx(0, "SCROLLBAR", "", WS_CHILD | WS_VISIBLE, /* SBS_HORZ */
                               16, 44, 192, 16, h, (HMENU)ID_BAR, NULL, NULL);
        SetScrollRange(g_bar, SB_CTL, 0, 200, FALSE);
        CreateWindowEx(0, "BUTTON", "Vol -", WS_CHILD | WS_VISIBLE,
                       216, 40, 48, 20, h, (HMENU)ID_DOWN, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Vol +", WS_CHILD | WS_VISIBLE,
                       216, 64, 48, 20, h, (HMENU)ID_UP, NULL, NULL);
        g_edit = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                                16, 66, 60, 20, h, (HMENU)ID_EDIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Set", WS_CHILD | WS_VISIBLE,
                       82, 66, 40, 20, h, (HMENU)ID_SET, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "System", WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 100, 264, 86, h, NULL, NULL, NULL);
        int y = 118;
        add_info(h, &y);
        g_gain = __audio_gain(-1);
        show_gain();
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_DOWN: set_gain(g_gain - 10); return 0;
        case ID_UP:   set_gain(g_gain + 10); return 0;
        case ID_SET: {
            char buf[16];
            GetWindowText(g_edit, buf, sizeof buf);
            int v = atoi(buf);
            if (buf[0]) set_gain(v);
            return 0;
        }
        }
        return 0;
    case WM_HSCROLL: {                           /* the scrollbar notifies only */
        int code = LOWORD(wp), pos = HIWORD(wp);
        if (code == SB_THUMBTRACK || code == SB_THUMBPOSITION) set_gain(pos);
        else if (code == SB_LINEUP || code == SB_PAGEUP) set_gain(g_gain - 10);
        else if (code == SB_LINEDOWN || code == SB_PAGEDOWN) set_gain(g_gain + 10);
        return 0;
    }
    case WM_CLOSE:
        DestroyWindow(h);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "CtlPanel";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    RegisterClass(&wc);
    g_win = CreateWindowEx(0, "CtlPanel", "Control Panel",
                           WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT, 280, 194,
                           NULL, NULL, NULL, NULL);
    if (!g_win) return 1;
    MSG m;
    while (GetMessage(&m, NULL, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    return 0;
}
