/* ctlpanel.c — the Control Panel (todos/0048 v1; todos/0089 v2 applet hub).
 *
 * v2 shape: the main window is the Win95 Control Panel FOLDER — a grid of
 * labelled applet icons — and every applet opens as its own sibling
 * top-level window (the .cpl model), so applets stay isolated and
 * independently agent-drivable (OS.md pillar). Closing an applet's kernel
 * 'x' closes just that applet (the 0089 per-window SDL_EVENT_WINDOW_
 * CLOSE_REQUESTED); closing the hub quits the whole panel.
 *
 * Activation is SINGLE-CLICK (the IE4 web-view model — a 0089 decision):
 * one `wmctl click "Sound"` = one open, no synthetic double-click dance.
 * Keyboard on the hub: Left/Right (Home/End) move the selection, Enter
 * opens it.
 *
 * Applets:
 *   Sound     — the 0048 master-volume controls lifted verbatim (kernel
 *               AUDIO_GAIN via host.js __audio_gain: percent 0..200,
 *               negative queries). `wmctl click "Vol +"`/"Vol -" steps,
 *               settext EDIT:0 + click Set goes absolute, the label reads
 *               back via gettext — the e2e drives exactly that.
 *   Sounds    — the event-sound scheme (todos/0094, os/sounds.h): enable/
 *               mute checkbox (snd_set_mute writes ~/.config/sounds with
 *               the effective table carried forward) + a Test button
 *               (PlaySound SystemDefault). Distinct from Sound: that is
 *               the volume knob, this is the scheme.
 *   System    — the 0048 info readout (/usr/share/os-release + the 0043
 *               synthetic /proc/uptime), plain POSIX.
 *   Display   — a stub naming todos/0049 (the wallpaper picker lands
 *               there; this window is its Control Panel home).
 *   Date/Time — live clock over SetTimer/WM_TIMER (the 0068 timer).
 *   Screen Saver — the 0096 saver config (os/saver.h): pick None/Marquee/
 *               Starfield (radios apply on click), set the idle timeout
 *               (Apply), Preview raises it now (WMP SAVER — the wmctl-saver
 *               gesture; /bin/wm answers, so no WM = silent no-op).
 * Mouse/Keyboard applets: recorded in todos/0089, build opportunistically.
 */

#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "../sounds.h"
#include "../saver.h"
#include "../wm_proto.h"

__import int __audio_gain(int gain);             /* host.js; -1 = no mixer */

/* ---------------------------------------------------------- applet table */

enum { APP_SOUND, APP_SOUNDS, APP_SYSTEM, APP_DISPLAY, APP_DATETIME,
       APP_SAVER, APP_N };

static const char *APP_NAME[APP_N] =             /* icon labels (unique!) */
    { "Sound", "Sounds", "System", "Display", "Date/Time", "Screen Saver" };
static const char *APP_TITLE[APP_N] =            /* applet window titles */
    { "Sound Properties", "Sounds Properties", "System Properties",
      "Display Properties", "Date/Time Properties",
      "Screen Saver Properties" };

static HWND g_hub;
static HWND g_icon[APP_N];
static HWND g_applet[APP_N];                     /* one instance per applet */
static int g_sel;                                /* hub selection index */

/* ------------------------------------------------- Sound (0048 verbatim) */

#define ID_LABEL 100
#define ID_BAR   101
#define ID_DOWN  102
#define ID_UP    103
#define ID_EDIT  104
#define ID_SET   105

static HWND g_label, g_bar, g_edit;
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

static LRESULT CALLBACK sound_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        /* the 0048 volume group, coordinates unchanged (groupbox renamed:
         * "Sound" must stay unique to the hub icon for agent_find) */
        CreateWindowEx(0, "BUTTON", "Master Volume",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
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
    case WM_DESTROY:
        g_applet[APP_SOUND] = NULL;
        g_label = g_bar = g_edit = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------------------------- Sounds (the 0094 event scheme) */

#define ID_SNDCHK  200
#define ID_SNDTEST 201

static LRESULT CALLBACK sounds_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "BUTTON", "Event Sounds",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 264, 88, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Enable event sounds",
                       WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       16, 26, 200, 16, h, (HMENU)ID_SNDCHK, NULL, NULL);
        SendMessage(GetDlgItem(h, ID_SNDCHK), BM_SETCHECK, !snd_muted(), 0);
        CreateWindowEx(0, "BUTTON", "Test", WS_CHILD | WS_VISIBLE,
                       16, 56, 60, 22, h, (HMENU)ID_SNDTEST, NULL, NULL);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SNDCHK: {                        /* auto-toggled; apply it */
            HWND chk = GetDlgItem(h, ID_SNDCHK);
            int on = (int)SendMessage(chk, BM_GETCHECK, 0, 0);
            if (snd_set_mute(!on) != 0)          /* store write failed: revert */
                SendMessage(chk, BM_SETCHECK, !on, 0);
            return 0;
        }
        case ID_SNDTEST:
            PlaySoundA("SystemDefault", NULL, SND_ALIAS | SND_ASYNC);
            return 0;
        }
        return 0;
    case WM_DESTROY:
        g_applet[APP_SOUNDS] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------------------------------------ System (0048 verbatim) */

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

static LRESULT CALLBACK system_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        int y = 12;
        add_info(h, &y);
        return 0;
    }
    case WM_DESTROY:
        g_applet[APP_SYSTEM] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* -------------------------------------------------- Display (0049 stub) */

static LRESULT CALLBACK display_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "STATIC", "Wallpaper and appearance settings",
                       WS_CHILD | WS_VISIBLE, 16, 14, 248, 16, h, NULL, NULL, NULL);
        CreateWindowEx(0, "STATIC", "arrive with todos/0049.",
                       WS_CHILD | WS_VISIBLE, 16, 32, 248, 16, h, NULL, NULL, NULL);
        return 0;
    case WM_DESTROY:
        g_applet[APP_DISPLAY] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* --------------------------------------- Date/Time (SetTimer acceptance) */

#define ID_CLOCK 300

static void clock_update(HWND h) {
    char buf[64];
    time_t t = time(NULL);
    struct tm *tm = localtime(&t);
    if (tm) strftime(buf, sizeof buf, "%Y-%m-%d %H:%M:%S", tm);
    else snprintf(buf, sizeof buf, "(no clock)");
    SetWindowText(GetDlgItem(h, ID_CLOCK), buf);
}

static LRESULT CALLBACK datetime_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "STATIC", "", WS_CHILD | WS_VISIBLE,
                       16, 20, 200, 16, h, (HMENU)ID_CLOCK, NULL, NULL);
        clock_update(h);
        SetTimer(h, 1, 1000, NULL);
        return 0;
    case WM_TIMER:
        clock_update(h);
        return 0;
    case WM_DESTROY:
        KillTimer(h, 1);
        g_applet[APP_DATETIME] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ---------------------------------- Screen Saver (the 0096 saver config) */

#define ID_SVNONE  400                           /* radio ids in sv_names order */
#define ID_SVMARQ  401
#define ID_SVSTAR  402
#define ID_SVWAIT  403
#define ID_SVAPPLY 404
#define ID_SVPREV  405

static const char *SV_RADIO[3] = { "none", "marquee", "starfield" };

static LRESULT CALLBACK saver_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        CreateWindowEx(0, "BUTTON", "Screen Saver",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 264, 148, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "None",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       16, 26, 120, 16, h, (HMENU)ID_SVNONE, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Marquee",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       16, 46, 120, 16, h, (HMENU)ID_SVMARQ, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Starfield",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       16, 66, 120, 16, h, (HMENU)ID_SVSTAR, NULL, NULL);
        CreateWindowEx(0, "STATIC", "Wait (sec):", WS_CHILD | WS_VISIBLE,
                       16, 96, 68, 16, h, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                       90, 92, 50, 20, h, (HMENU)ID_SVWAIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Apply", WS_CHILD | WS_VISIBLE,
                       146, 92, 50, 20, h, (HMENU)ID_SVAPPLY, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Preview", WS_CHILD | WS_VISIBLE,
                       16, 122, 70, 22, h, (HMENU)ID_SVPREV, NULL, NULL);
        sv_cfg c;
        sv_get(&c);
        int sel = ID_SVNONE;
        if (strcasecmp(c.saver, "marquee") == 0) sel = ID_SVMARQ;
        else if (strcasecmp(c.saver, "starfield") == 0) sel = ID_SVSTAR;
        for (int id = ID_SVNONE; id <= ID_SVSTAR; id++)
            SendMessage(GetDlgItem(h, id), BM_SETCHECK, id == sel, 0);
        char buf[16];
        snprintf(buf, sizeof buf, "%d", c.timeout);
        SetWindowText(GetDlgItem(h, ID_SVWAIT), buf);
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SVNONE: case ID_SVMARQ: case ID_SVSTAR:
            /* auto-toggled; apply on click (the Sounds checkbox rule) */
            sv_set("saver", SV_RADIO[LOWORD(wp) - ID_SVNONE]);
            return 0;
        case ID_SVAPPLY: {
            char buf[16];
            GetWindowText(GetDlgItem(h, ID_SVWAIT), buf, sizeof buf);
            if (buf[0]) {
                int v = atoi(buf);
                if (v < 0) v = 0;
                snprintf(buf, sizeof buf, "%d", v);
                sv_set("timeout", buf);
                SetWindowText(GetDlgItem(h, ID_SVWAIT), buf);
            }
            return 0;
        }
        case ID_SVPREV: {                        /* WMP SAVER: raise it now */
            int fd = wmp_connect();
            if (fd >= 0) {
                wmp_cmd(fd, WMP_SAVER, NULL, 0);   /* no WM: silent no-op */
                close(fd);
            }
            return 0;
        }
        }
        return 0;
    case WM_DESTROY:
        g_applet[APP_SAVER] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------------------------------------------------- the hub */

typedef LRESULT (CALLBACK *WndProcFn)(HWND, UINT, WPARAM, LPARAM);

static const struct { const char *cls; WndProcFn proc; int w, h; }
APP_DEF[APP_N] = {
    { "CplSound",    sound_proc,    280, 102 },
    { "CplSndScheme", sounds_proc,  280, 102 },
    { "CplSystem",   system_proc,   280, 82  },
    { "CplDisplay",  display_proc,  280, 62  },
    { "CplDateTime", datetime_proc, 232, 56  },
    { "CplSaver",    saver_proc,    280, 162 },
};

static void open_applet(int i) {
    if (i < 0 || i >= APP_N) return;
    if (g_applet[i]) return;                     /* one instance per applet */
    g_applet[i] = CreateWindowEx(0, APP_DEF[i].cls, APP_TITLE[i],
                                 WS_OVERLAPPED | WS_VISIBLE,
                                 CW_USEDEFAULT, CW_USEDEFAULT,
                                 APP_DEF[i].w, APP_DEF[i].h,
                                 NULL, NULL, NULL, NULL);
}

static void select_icon(int i) {
    if (i < 0 || i >= APP_N || i == g_sel) return;
    int old = g_sel;
    g_sel = i;
    InvalidateRect(g_icon[old], NULL, TRUE);
    InvalidateRect(g_icon[i], NULL, TRUE);
}

/* icon cell geometry (hub client space) */
#define CELL_W  84
#define ICON_W  76
#define ICON_H  60

static int icon_index(HWND h) {
    for (int i = 0; i < APP_N; i++)
        if (g_icon[i] == h) return i;
    return -1;
}

/* 32x32 pictograms at (x,y) — simple Win95-ish shapes, stock-quality art
 * is a non-goal. Created objects are deleted per paint (leak counters). */
static void draw_art(HDC dc, int i, int x, int y) {
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(0, 0, 0));
    HGDIOBJ op = SelectObject(dc, pen);
    switch (i) {
    case APP_SOUND: {                            /* speaker + waves */
        HBRUSH b = CreateSolidBrush(RGB(160, 160, 160));
        HGDIOBJ ob = SelectObject(dc, b);
        Rectangle(dc, x + 3, y + 12, x + 11, y + 21);
        POINT cone[4] = { { x + 10, y + 12 }, { x + 18, y + 4 },
                          { x + 18, y + 28 }, { x + 10, y + 20 } };
        Polygon(dc, cone, 4);
        SelectObject(dc, ob);
        DeleteObject(b);
        MoveToEx(dc, x + 22, y + 10, NULL);
        LineTo(dc, x + 25, y + 16);
        LineTo(dc, x + 22, y + 22);
        MoveToEx(dc, x + 26, y + 7, NULL);
        LineTo(dc, x + 30, y + 16);
        LineTo(dc, x + 26, y + 25);
        break;
    }
    case APP_SOUNDS: {                           /* musical note */
        HBRUSH b = CreateSolidBrush(RGB(0, 0, 128));
        HGDIOBJ ob = SelectObject(dc, b);
        Ellipse(dc, x + 6, y + 21, x + 15, y + 28);   /* note head */
        SelectObject(dc, ob);
        DeleteObject(b);
        MoveToEx(dc, x + 14, y + 24, NULL);      /* stem */
        LineTo(dc, x + 14, y + 6);
        LineTo(dc, x + 24, y + 9);               /* flag */
        MoveToEx(dc, x + 14, y + 12, NULL);
        LineTo(dc, x + 24, y + 15);
        break;
    }
    case APP_SYSTEM: {                           /* monitor + base */
        HBRUSH b = CreateSolidBrush(RGB(0, 0, 128));
        HGDIOBJ ob = SelectObject(dc, b);
        Rectangle(dc, x + 2, y + 4, x + 30, y + 24);
        SelectObject(dc, ob);
        DeleteObject(b);
        MoveToEx(dc, x + 12, y + 24, NULL);      /* stand */
        LineTo(dc, x + 12, y + 27);
        MoveToEx(dc, x + 20, y + 24, NULL);
        LineTo(dc, x + 20, y + 27);
        MoveToEx(dc, x + 8, y + 28, NULL);
        LineTo(dc, x + 24, y + 28);
        break;
    }
    case APP_DISPLAY: {                          /* monitor with a scene */
        HBRUSH sky = CreateSolidBrush(RGB(0, 160, 200));
        HGDIOBJ ob = SelectObject(dc, sky);
        Rectangle(dc, x + 2, y + 4, x + 30, y + 24);
        SelectObject(dc, ob);
        DeleteObject(sky);
        HBRUSH sun = CreateSolidBrush(RGB(255, 210, 0));
        RECT r = { x + 20, y + 7, x + 26, y + 13 };
        FillRect(dc, &r, sun);
        DeleteObject(sun);
        HBRUSH grass = CreateSolidBrush(RGB(0, 140, 60));
        RECT g = { x + 3, y + 18, x + 29, y + 23 };
        FillRect(dc, &g, grass);
        DeleteObject(grass);
        MoveToEx(dc, x + 8, y + 28, NULL);
        LineTo(dc, x + 24, y + 28);
        break;
    }
    case APP_SAVER: {                            /* dark monitor, stars */
        HBRUSH b = CreateSolidBrush(RGB(0, 0, 0));
        HGDIOBJ ob = SelectObject(dc, b);
        Rectangle(dc, x + 2, y + 4, x + 30, y + 24);
        SelectObject(dc, ob);
        DeleteObject(b);
        HBRUSH st = CreateSolidBrush(RGB(255, 255, 255));
        static const int pts[5][2] =
            { { 7, 9 }, { 14, 15 }, { 21, 8 }, { 24, 18 }, { 10, 19 } };
        for (int k = 0; k < 5; k++) {
            RECT r = { x + pts[k][0], y + pts[k][1],
                       x + pts[k][0] + 2, y + pts[k][1] + 2 };
            FillRect(dc, &r, st);
        }
        DeleteObject(st);
        MoveToEx(dc, x + 8, y + 28, NULL);       /* the stand */
        LineTo(dc, x + 24, y + 28);
        break;
    }
    case APP_DATETIME: {                         /* clock face + hands */
        HBRUSH b = CreateSolidBrush(RGB(255, 255, 255));
        HGDIOBJ ob = SelectObject(dc, b);
        Ellipse(dc, x + 2, y + 2, x + 30, y + 30);
        SelectObject(dc, ob);
        DeleteObject(b);
        MoveToEx(dc, x + 16, y + 16, NULL);      /* hands: 12 and 3 */
        LineTo(dc, x + 16, y + 6);
        MoveToEx(dc, x + 16, y + 16, NULL);
        LineTo(dc, x + 24, y + 16);
        break;
    }
    }
    SelectObject(dc, op);
    DeleteObject(pen);
}

static LRESULT CALLBACK icon_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    int i = icon_index(h);
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (dc && i >= 0) {
            draw_art(dc, i, (ICON_W - 32) / 2, 2);
            RECT lr = { 2, 38, ICON_W - 2, 56 };
            SetBkMode(dc, TRANSPARENT);
            if (i == g_sel) {                    /* selection = navy strip */
                HBRUSH b = CreateSolidBrush(RGB(0, 0, 128));
                FillRect(dc, &lr, b);
                DeleteObject(b);
                SetTextColor(dc, RGB(255, 255, 255));
            } else {
                SetTextColor(dc, RGB(0, 0, 0));
            }
            DrawText(dc, APP_NAME[i], -1, &lr,
                     DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        }
        if (dc) EndPaint(h, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN:
        select_icon(i);
        return 0;
    case WM_LBUTTONUP:
        /* single-click activation — one agent click (down+up) = one open */
        open_applet(i);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static LRESULT CALLBACK hub_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        for (int i = 0; i < APP_N; i++)
            g_icon[i] = CreateWindowEx(0, "CplIcon", APP_NAME[i],
                                       WS_CHILD | WS_VISIBLE,
                                       8 + i * CELL_W, 8, ICON_W, ICON_H,
                                       h, (HMENU)(200 + i), NULL, NULL);
        return 0;
    case WM_KEYDOWN:
        /* one row today: Up/Down alias Left/Right until a second row */
        switch (wp) {
        case VK_LEFT: case VK_UP:    select_icon(g_sel - 1); return 0;
        case VK_RIGHT: case VK_DOWN: select_icon(g_sel + 1); return 0;
        case VK_HOME:                select_icon(0); return 0;
        case VK_END:                 select_icon(APP_N - 1); return 0;
        case VK_RETURN:              open_applet(g_sel); return 0;
        }
        return 0;
    case WM_CLOSE:                               /* hub close = quit the panel */
        DestroyWindow(h);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* `ctlpanel <Applet>` opens that applet alongside the hub (todos/0091 —
 * the desktop context menu's Display Properties shortcut). Names match
 * the icon labels, case-insensitively. */
static int applet_by_name(const char *name) {
    for (int i = 0; i < APP_N; i++) {
        const char *a = APP_NAME[i], *b = name;
        while (*a && *b) {
            int ca = *a >= 'A' && *a <= 'Z' ? *a + 32 : *a;
            int cb = *b >= 'A' && *b <= 'Z' ? *b + 32 : *b;
            if (ca != cb) break;
            a++; b++;
        }
        if (!*a && !*b) return i;
    }
    return -1;
}

int main(int argc, char **argv) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = hub_proc;
    wc.lpszClassName = "CtlPanel";
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);   /* folder white */
    RegisterClass(&wc);
    wc.lpfnWndProc = icon_proc;
    wc.lpszClassName = "CplIcon";
    RegisterClass(&wc);
    for (int i = 0; i < APP_N; i++) {
        wc.lpfnWndProc = APP_DEF[i].proc;
        wc.lpszClassName = APP_DEF[i].cls;
        wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
        RegisterClass(&wc);
    }
    g_hub = CreateWindowEx(0, "CtlPanel", "Control Panel",
                           WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT,
                           16 + APP_N * CELL_W - (CELL_W - ICON_W), ICON_H + 16,
                           NULL, NULL, NULL, NULL);
    if (!g_hub) return 1;
    if (argc > 1) open_applet(applet_by_name(argv[1]));   /* todos/0091 */
    MSG m;
    while (GetMessage(&m, NULL, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    return 0;
}
