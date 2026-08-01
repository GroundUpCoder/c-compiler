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
 *               mute checkbox (snd_set_mute writes just the mute key to
 *               ~/.config/sounds — cfgstore.h delta) + a Test button
 *               (PlaySound SystemDefault). Distinct from Sound: that is
 *               the volume knob, this is the scheme.
 *   System    — the 0048 info readout (/usr/share/os-release + the 0043
 *               synthetic /proc/uptime), plain POSIX.
 *   Display   — the screen-density picker (hires-display, os/display.h):
 *               radios choose the VT2 zoom factor (auto/3x/2x/1x/0.75x/
 *               0.5x — sub-1x = denser, more fits) and apply LIVE through
 *               the display cfgstore -> kernel-worker watch -> page
 *               bridge. Wallpaper still lands with todos/0049.
 *   Date/Time — live clock over SetTimer/WM_TIMER (the 0068 timer).
 *   Screen Saver — the 0096 saver config (os/saver.h): pick None/Marquee/
 *               Starfield (radios apply on click), set the idle timeout
 *               (Apply), Preview raises it now (WMP SAVER — the wmctl-saver
 *               gesture; /bin/wm answers, so no WM = silent no-op).
 *   Network   — the Tier 2.5 HTTP bridge switch (ticket #349, os/netcfg.h,
 *               todos/NETWORK.md): enable/disable checkbox + bridge URL
 *               (both cfgstore `net` delta-writes; the kernel embedder
 *               watches the store, so the toggle retargets the next
 *               transfer live — no reboot) + a Test button that fetches
 *               the bridge's /health over the kernel HTTP primitive. The
 *               copy states the seam honestly: the bridge is a program on
 *               the HOST machine the user runs themselves.
 *   Default Programs — the command-alternatives picker (todos/0338 plus
 *               todos/0130's picker leg, over os/cmdalt.h): WHICH
 *               implementation a dispatched command NAME runs. Two lists
 *               (the keys, then the selected key's candidates), Set as
 *               default / Use default writing the SAME ~/.config/cmdalt
 *               delta `cmdalt set`/`cmdalt reset` write, plus the
 *               PATH-shadow warning — this is the screen a user whose
 *               switch "did nothing" is standing on. File associations,
 *               the other half of the Windows applet, stay todos/0130's.
 * Mouse applet: recorded in todos/0089, build opportunistically.
 */

#include <windows.h>
#include <mmsystem.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "../sounds.h"
#include "../saver.h"
#include "../keys.h"
#include "../display.h"
#include "../netcfg.h"
#include "../cmdalt.h"
#include "../wm_proto.h"

/* A config-store write failed — read-only or full $HOME (todos/0234).
 * Every applet uses this one discipline: revert the control to the
 * stored state, then say WHY, so the UI never shows a setting that
 * didn't actually stick. */
static void store_fail(HWND owner, const char *what) {
    char msg[160];
    snprintf(msg, sizeof msg, "Cannot save %s:\n%s", what, strerror(errno));
    MessageBox(owner, msg, "Control Panel", MB_OK | MB_ICONEXCLAMATION);
}

__import int __audio_gain(int gain);             /* host.js; -1 = no mixer */

/* The kernel HTTP primitive (todos/0172, fd-shaped todos/0417) — the
 * Network applet's Test button drives it directly (no curl veneer link). */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);

/* ---------------------------------------------------------- applet table */

enum { APP_SOUND, APP_SOUNDS, APP_SYSTEM, APP_DISPLAY, APP_DATETIME,
       APP_SAVER, APP_KEYBOARD, APP_DEFPROG, APP_NET, APP_N };

static const char *APP_NAME[APP_N] =             /* icon labels (unique!) */
    { "Sound", "Sounds", "System", "Display", "Date/Time", "Screen Saver",
      "Keyboard", "Default Programs", "Network" };
static const char *APP_TITLE[APP_N] =            /* applet window titles */
    { "Sound Properties", "Sounds Properties", "System Properties",
      "Display Properties", "Date/Time Properties",
      "Screen Saver Properties", "Keyboard Properties",
      "Default Programs", "Network Properties" };

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
                       8, 6, 300, 138, h, NULL, NULL, NULL);
        g_label = CreateWindowEx(0, "STATIC", "Volume:", WS_CHILD | WS_VISIBLE,
                                 20, 32, 260, 28, h, (HMENU)ID_LABEL, NULL, NULL);
        g_bar = CreateWindowEx(0, "SCROLLBAR", "", WS_CHILD | WS_VISIBLE, /* SBS_HORZ */
                               20, 68, 196, 18, h, (HMENU)ID_BAR, NULL, NULL);
        SetScrollRange(g_bar, SB_CTL, 0, 200, FALSE);
        CreateWindowEx(0, "BUTTON", "Vol -", WS_CHILD | WS_VISIBLE,
                       224, 62, 64, 30, h, (HMENU)ID_DOWN, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Vol +", WS_CHILD | WS_VISIBLE,
                       224, 100, 64, 30, h, (HMENU)ID_UP, NULL, NULL);
        g_edit = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                                20, 100, 64, 30, h, (HMENU)ID_EDIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Set", WS_CHILD | WS_VISIBLE,
                       92, 100, 56, 30, h, (HMENU)ID_SET, NULL, NULL);
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
                       8, 6, 300, 110, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Enable event sounds",
                       WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       20, 34, 272, 28, h, (HMENU)ID_SNDCHK, NULL, NULL);
        SendMessage(GetDlgItem(h, ID_SNDCHK), BM_SETCHECK, !snd_muted(), 0);
        CreateWindowEx(0, "BUTTON", "Test", WS_CHILD | WS_VISIBLE,
                       20, 72, 72, 30, h, (HMENU)ID_SNDTEST, NULL, NULL);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SNDCHK: {                        /* auto-toggled; apply it */
            HWND chk = GetDlgItem(h, ID_SNDCHK);
            int on = (int)SendMessage(chk, BM_GETCHECK, 0, 0);
            if (snd_set_mute(!on) != 0) {        /* store write failed: revert */
                SendMessage(chk, BM_SETCHECK, !on, 0);
                store_fail(h, "the sound setting");
            }
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

/* one info line per read: "NAME=gucOS" etc + uptime */
static void add_info(HWND parent, int *y) {
    char line[96], text[128];
    FILE *f = fopen("/usr/share/os-release", "r");
    while (f && fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = 0;
        snprintf(text, sizeof text, "%s", line);
        /* 20px-font retune: 28px line box, 30px pitch, wider column. */
        CreateWindowEx(0, "STATIC", text, WS_CHILD | WS_VISIBLE,
                       16, *y, 352, 28, parent, NULL, NULL, NULL);
        *y += 30;
    }
    if (f) fclose(f);
    f = fopen("/proc/uptime", "r");
    if (f) {
        double up = 0;
        if (fscanf(f, "%lf", &up) == 1) {
            snprintf(text, sizeof text, "UPTIME=%ds", (int)up);
            CreateWindowEx(0, "STATIC", text, WS_CHILD | WS_VISIBLE,
                           16, *y, 352, 28, parent, NULL, NULL, NULL);
            *y += 30;
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

/* ------------------------- Display (hires-display: the density picker) */

/* The screen density / resolution setting, the real-OS home for the VT2
 * zoom factor (os/display.h): radios apply on click (the Sounds checkbox
 * rule) by delta-writing `zoom` to ~/.config/display; the kernel worker
 * watches the store and re-posts the value to the page, which reflows the
 * desktop LIVE — sub-1x factors render MORE logical pixels than the pane
 * (everything smaller, more fits), >1x fewer (everything bigger).
 * Wallpaper/appearance still arrive with todos/0049. */

#define ID_DPBASE 600                            /* radios in DP_OPT order */

static const struct { const char *label; const char *value; } DP_OPT[] = {
    { "Automatic (default)", "auto" },
    { "Largest (3x)",        "3" },
    { "Larger (2x)",         "2" },
    { "Native (1x)",         "1" },
    { "Denser (0.75x)",      "0.75" },
    { "Densest (0.5x)",      "0.5" },
};
#define DP_N ((int)(sizeof DP_OPT / sizeof DP_OPT[0]))

/* Sync the radios to the STORED config — WM_CREATE and the write-failure
 * reverts (the saver_sync discipline, todos/0234). A numeric value snaps
 * to the nearest offered factor (the page snaps the same way, so the UI
 * shows what a hand-edited store effectively does); non-numeric = auto. */
static void dp_sync(HWND h) {
    dp_cfg c;
    dp_get(&c);
    int sel = 0;
    double z = atof(c.zoom);
    if (strcasecmp(c.zoom, "auto") != 0 && z > 0) {
        double best = 10;
        for (int i = 1; i < DP_N; i++) {
            double d = atof(DP_OPT[i].value) - z;
            if (d < 0) d = -d;
            if (d < best) { best = d; sel = i; }
        }
    }
    for (int i = 0; i < DP_N; i++)
        SendMessage(GetDlgItem(h, ID_DPBASE + i), BM_SETCHECK, i == sel, 0);
}

static LRESULT CALLBACK display_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "BUTTON", "Screen Density",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 300, 214, h, NULL, NULL, NULL);
        for (int i = 0; i < DP_N; i++)
            CreateWindowEx(0, "BUTTON", DP_OPT[i].label,
                           WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                           20, 34 + i * 30, 272, 28, h,
                           (HMENU)(ID_DPBASE + i), NULL, NULL);
        CreateWindowEx(0, "STATIC", "Wallpaper arrives with todos/0049.",
                       WS_CHILD | WS_VISIBLE, 16, 228, 292, 28, h, NULL, NULL, NULL);
        dp_sync(h);
        return 0;
    case WM_COMMAND: {
        int id = LOWORD(wp);
        if (id >= ID_DPBASE && id < ID_DPBASE + DP_N) {
            /* auto-toggled; apply on click (the Sounds checkbox rule) */
            if (dp_set("zoom", DP_OPT[id - ID_DPBASE].value) != 0) {
                dp_sync(h);                      /* store write failed: revert */
                store_fail(h, "the screen density");
            }
        }
        return 0;
    }
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
                       16, 24, 268, 28, h, (HMENU)ID_CLOCK, NULL, NULL);
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

/* Sync the radios + timeout edit to the STORED config — shared by
 * WM_CREATE and the write-failure reverts (the UI must fall back to what
 * the store really holds, todos/0234). */
static void saver_sync(HWND h) {
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
}

static LRESULT CALLBACK saver_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        CreateWindowEx(0, "BUTTON", "Screen Saver",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 316, 190, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "None",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       20, 34, 240, 28, h, (HMENU)ID_SVNONE, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Marquee",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       20, 64, 240, 28, h, (HMENU)ID_SVMARQ, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Starfield",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       20, 94, 240, 28, h, (HMENU)ID_SVSTAR, NULL, NULL);
        CreateWindowEx(0, "STATIC", "Wait (sec):", WS_CHILD | WS_VISIBLE,
                       20, 128, 140, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                       164, 126, 64, 30, h, (HMENU)ID_SVWAIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Apply", WS_CHILD | WS_VISIBLE,
                       236, 126, 76, 30, h, (HMENU)ID_SVAPPLY, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Preview", WS_CHILD | WS_VISIBLE,
                       20, 160, 96, 30, h, (HMENU)ID_SVPREV, NULL, NULL);
        saver_sync(h);
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SVNONE: case ID_SVMARQ: case ID_SVSTAR:
            /* auto-toggled; apply on click (the Sounds checkbox rule) */
            if (sv_set("saver", SV_RADIO[LOWORD(wp) - ID_SVNONE]) != 0) {
                saver_sync(h);                   /* store write failed: revert */
                store_fail(h, "the screen saver setting");
            }
            return 0;
        case ID_SVAPPLY: {
            char buf[16];
            GetWindowText(GetDlgItem(h, ID_SVWAIT), buf, sizeof buf);
            if (buf[0]) {
                int v = atoi(buf);
                if (v < 0) v = 0;
                snprintf(buf, sizeof buf, "%d", v);
                if (sv_set("timeout", buf) != 0) {
                    saver_sync(h);               /* store write failed: revert */
                    store_fail(h, "the screen saver timeout");
                } else
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

/* ------------------------------ Keyboard (the 0149 keyboard scheme) */

#define ID_KBWIN 500                             /* radios in KS_* order */
#define ID_KBMAC 501
#define ID_KBRL  502

static const char *KB_RADIO[2] = { "windows", "macos" };

/* Sync the radios + checkbox to the STORED config — WM_CREATE and the
 * write-failure reverts (the saver_sync discipline, todos/0234). */
static void kb_sync(HWND h) {
    ks_cfg c;
    ks_get(&c);
    SendMessage(GetDlgItem(h, ID_KBWIN), BM_SETCHECK, c.scheme == KS_WINDOWS, 0);
    SendMessage(GetDlgItem(h, ID_KBMAC), BM_SETCHECK, c.scheme == KS_MACOS, 0);
    SendMessage(GetDlgItem(h, ID_KBRL), BM_SETCHECK, c.readline != 0, 0);
}

static LRESULT CALLBACK keyboard_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "BUTTON", "Keyboard Scheme",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 480, 130, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Windows (Ctrl)",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       20, 34, 300, 28, h, (HMENU)ID_KBWIN, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "macOS (Cmd)",
                       WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON,
                       20, 64, 300, 28, h, (HMENU)ID_KBMAC, NULL, NULL);
        /* the 0150 axis: only the macos table HAS the emacs rows (in the
         * windows table Ctrl is the verb modifier), so this is a
         * macos-scheme refinement — running apps pick either change up
         * within ~1s (the keys.h cached revalidate). The label is 36 chars
         * (~432px at 12px/char) PLUS the ~20px check glyph/gap, so the
         * control is 464px and the group + window widen to hold it. */
        CreateWindowEx(0, "BUTTON", "Emacs editing in text fields (macOS)",
                       WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       20, 94, 464, 28, h, (HMENU)ID_KBRL, NULL, NULL);
        kb_sync(h);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_KBWIN: case ID_KBMAC:
            /* auto-toggled; apply on click (the Sounds checkbox rule) */
            if (ks_set("scheme", KB_RADIO[LOWORD(wp) - ID_KBWIN]) != 0) {
                kb_sync(h);                      /* store write failed: revert */
                store_fail(h, "the keyboard scheme");
            }
            return 0;
        case ID_KBRL: {
            HWND chk = GetDlgItem(h, ID_KBRL);
            int on = (int)SendMessage(chk, BM_GETCHECK, 0, 0);
            if (ks_set("readline", on ? "on" : "off") != 0) {
                kb_sync(h);                      /* store write failed: revert */
                store_fail(h, "the keyboard setting");
            }
            return 0;
        }
        }
        return 0;
    case WM_DESTROY:
        g_applet[APP_KEYBOARD] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------- Default Programs (todos/0130 picker leg, todos/0338)
 *
 * The COMMAND half of Windows' own Default Programs split ("set your
 * default programs" vs "associate a file type"): one row per cmdalt key
 * with its effective value, the candidate implementations for the selected
 * key, and Set as default / Use default over the SAME store `cmdalt set`
 * writes (os/cmdalt.h — this applet is UI over that policy, it forks
 * nothing). The file-association half stays todos/0130's.
 *
 * The warning row is the third of the three PATH-shadow diagnostics: this
 * is the exact screen a user whose switch "did nothing" is standing on. */

#define ID_DPGKEYS 700
#define ID_DPGCAND 701
#define ID_DPGSET  702
#define ID_DPGDEF  703
#define ID_DPGEFF  704
#define ID_DPGWARN 705

#define DPG_MAX 32                               /* rows we keep addressable */

static char dpg_key[DPG_MAX][CA_KEY_MAX];        /* keys, listbox row order */
static char dpg_cand[DPG_MAX][CA_VAL_MAX];       /* candidates for the pick */
static int dpg_nkeys, dpg_ncand;

static int dpg_key_cb(const char *key, const char *value, void *u) {
    HWND lb = (HWND)u;
    char row[CA_KEY_MAX + CA_VAL_MAX + 8];
    if (dpg_nkeys >= DPG_MAX) return 1;
    snprintf(dpg_key[dpg_nkeys++], CA_KEY_MAX, "%s", key);
    snprintf(row, sizeof row, "%s -> %s", key, value);
    SendMessage(lb, LB_ADDSTRING, 0, (LPARAM)row);
    return 0;
}

static int dpg_cand_cb(const char *key, const char *value, void *u) {
    HWND lb = (HWND)u;
    char prog[CA_PATH_MAX], row[CA_VAL_MAX + CA_PATH_MAX + 8];
    (void)key;
    if (dpg_ncand >= DPG_MAX) return 1;
    snprintf(dpg_cand[dpg_ncand++], CA_VAL_MAX, "%s", value);
    ca_prog(value, prog, sizeof prog);
    if (prog[0] && access(prog, 0 /* F_OK */) == 0)
        snprintf(row, sizeof row, "%s - %s", value, prog);
    else
        snprintf(row, sizeof row, "%s - not installed", value);
    SendMessage(lb, LB_ADDSTRING, 0, (LPARAM)row);
    return 0;
}

/* The selected key, or "" when the list is empty. */
static void dpg_selected(HWND h, char *out, size_t sz) {
    int sel = (int)SendMessage(GetDlgItem(h, ID_DPGKEYS), LB_GETCURSEL, 0, 0);
    if (sel >= 0 && sel < dpg_nkeys) snprintf(out, sz, "%s", dpg_key[sel]);
    else if (sz) out[0] = 0;
}

/* Refill the candidate list + the two status lines for the selected key. */
static void dpg_fill_cands(HWND h) {
    char text[CA_STORE_MAX], key[CA_KEY_MAX], line[CA_VAL_MAX + CA_PATH_MAX + 64];
    HWND lb = GetDlgItem(h, ID_DPGCAND);
    SendMessage(lb, LB_RESETCONTENT, 0, 0);
    dpg_ncand = 0;
    dpg_selected(h, key, sizeof key);
    if (!key[0]) {
        SetWindowText(GetDlgItem(h, ID_DPGEFF), "");
        SetWindowText(GetDlgItem(h, ID_DPGWARN), "");
        return;
    }
    ca_load(text, sizeof text);
    ca_candidates(text, key, dpg_cand_cb, lb);
    if (dpg_ncand) SendMessage(lb, LB_SETCURSEL, 0, 0);
    ca_res r;
    ca_resolve(text, key, &r);
    if (r.status == CA_OK) snprintf(line, sizeof line, "%s runs: %s", key, r.prog);
    else if (r.status == CA_MISSING)
        snprintf(line, sizeof line, "%s runs: %s (not installed)", key, r.value);
    else snprintf(line, sizeof line, "%s: nothing configured", key);
    SetWindowText(GetDlgItem(h, ID_DPGEFF), line);
    char shadow[CA_PATH_MAX];
    if (ca_shadow(key, shadow, sizeof shadow)) {
        char msg[CA_PATH_MAX * 2];
        ca_shadow_text(key, shadow, " ", msg, sizeof msg);
        snprintf(line, sizeof line, "Warning: %s", msg);
        SetWindowText(GetDlgItem(h, ID_DPGWARN), line);
    } else {
        SetWindowText(GetDlgItem(h, ID_DPGWARN), "");
    }
}

/* Rebuild both lists from the STORE, carrying the selection by NAME across
 * the refill (the fileman rule — a row index is not an identity). */
static void dpg_sync(HWND h) {
    char text[CA_STORE_MAX], want[CA_KEY_MAX];
    HWND lb = GetDlgItem(h, ID_DPGKEYS);
    dpg_selected(h, want, sizeof want);
    SendMessage(lb, LB_RESETCONTENT, 0, 0);
    dpg_nkeys = 0;
    ca_load(text, sizeof text);
    cfg_keys(text, dpg_key_cb, lb);
    int pick = 0;
    for (int i = 0; i < dpg_nkeys; i++)
        if (want[0] && strcmp(dpg_key[i], want) == 0) pick = i;
    if (dpg_nkeys) SendMessage(lb, LB_SETCURSEL, pick, 0);
    dpg_fill_cands(h);
}

static LRESULT CALLBACK defprog_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "STATIC", "Commands", WS_CHILD | WS_VISIBLE,
                       12, 8, 240, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY,
                       12, 38, 250, 150, h, (HMENU)ID_DPGKEYS, NULL, NULL);
        CreateWindowEx(0, "STATIC", "Implementations", WS_CHILD | WS_VISIBLE,
                       274, 8, 260, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY,
                       274, 38, 274, 150, h, (HMENU)ID_DPGCAND, NULL, NULL);
        CreateWindowEx(0, "STATIC", "", WS_CHILD | WS_VISIBLE,
                       12, 194, 536, 28, h, (HMENU)ID_DPGEFF, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Set as default", WS_CHILD | WS_VISIBLE,
                       12, 226, 190, 30, h, (HMENU)ID_DPGSET, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Use default", WS_CHILD | WS_VISIBLE,
                       212, 226, 160, 30, h, (HMENU)ID_DPGDEF, NULL, NULL);
        CreateWindowEx(0, "STATIC", "", WS_CHILD | WS_VISIBLE,
                       12, 262, 536, 56, h, (HMENU)ID_DPGWARN, NULL, NULL);
        dpg_sync(h);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_DPGKEYS:
            if (HIWORD(wp) == LBN_SELCHANGE) dpg_fill_cands(h);
            return 0;
        case ID_DPGSET: {
            char key[CA_KEY_MAX];
            dpg_selected(h, key, sizeof key);
            int sel = (int)SendMessage(GetDlgItem(h, ID_DPGCAND), LB_GETCURSEL, 0, 0);
            if (!key[0] || sel < 0 || sel >= dpg_ncand) return 0;
            if (ca_set(key, dpg_cand[sel]) != 0) store_fail(h, "the default program");
            dpg_sync(h);
            return 0;
        }
        case ID_DPGDEF: {                        /* drop the user pick */
            char key[CA_KEY_MAX];
            dpg_selected(h, key, sizeof key);
            if (!key[0]) return 0;
            if (ca_reset(key) != 0) store_fail(h, "the default program");
            dpg_sync(h);
            return 0;
        }
        }
        return 0;
    case WM_DESTROY:
        g_applet[APP_DEFPROG] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------------- Network (the #349 Tier 2.5 HTTP bridge) */

#define ID_NETCHK  800
#define ID_NETURL  801
#define ID_NETAPP  802
#define ID_NETTEST 803
#define ID_NETSTAT 804

/* Sync the controls to the STORED config — WM_CREATE and the
 * write-failure reverts (the saver_sync discipline, todos/0234). */
static void net_sync(HWND h) {
    nc_cfg c;
    nc_get(&c);
    SendMessage(GetDlgItem(h, ID_NETCHK), BM_SETCHECK, c.on, 0);
    SetWindowText(GetDlgItem(h, ID_NETURL), c.url);
}

/* Fetch <url>/health over the kernel HTTP primitive and report. Blocks
 * the message loop for at most ~3s (headers deadline) — acceptable for an
 * explicit Test click; the transfer rides whatever path the setting says
 * (bridge on = through the bridge to its own /health, off = direct), so
 * the answer reflects the LIVE configuration. */
static void net_test(HWND h) {
    HWND stat = GetDlgItem(h, ID_NETSTAT);
    nc_cfg c;
    nc_get(&c);
    char url[NC_URL_MAX + 16], msg[NC_URL_MAX + 64];
    size_t n = strlen(c.url);
    while (n && c.url[n - 1] == '/') c.url[--n] = 0;
    snprintf(url, sizeof url, "%s/health", c.url);
    /* "Result:" is a STABLE PREFIX: agent needles prefix-match, so the
     * e2e can wait on this STATIC across every outcome text. */
    SetWindowText(stat, "Result: testing...");
    int fd = __http_open("GET", url, "", 0, 0, 3000, 3000);
    if (fd < 0) {
        snprintf(msg, sizeof msg, "Result: open failed: %s", strerror(errno));
        SetWindowText(stat, msg);
        return;
    }
    int status = 0;
    char hdr[512];
    for (int i = 0; i < 80; i++) {               /* ~4s cap at 50ms steps */
        if (__http_status(fd, &status, hdr, sizeof hdr) >= 0) {
            snprintf(msg, sizeof msg, "Result: bridge answered: HTTP %d", status);
            SetWindowText(stat, msg);
            close(fd);
            return;
        }
        if (errno != EAGAIN && errno != EINTR) break;
        usleep(50 * 1000);
    }
    snprintf(msg, sizeof msg, "Result: no answer: %s", strerror(errno));
    SetWindowText(stat, msg);
    close(fd);
}

static LRESULT CALLBACK net_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        CreateWindowEx(0, "BUTTON", "HTTP Bridge",
                       WS_CHILD | WS_VISIBLE | BS_GROUPBOX,
                       8, 6, 368, 150, h, NULL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Enable HTTP bridge",
                       WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       20, 34, 340, 28, h, (HMENU)ID_NETCHK, NULL, NULL);
        CreateWindowEx(0, "STATIC", "Bridge URL:", WS_CHILD | WS_VISIBLE,
                       20, 74, 132, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                       156, 72, 204, 30, h, (HMENU)ID_NETURL, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Apply URL", WS_CHILD | WS_VISIBLE,
                       20, 112, 124, 30, h, (HMENU)ID_NETAPP, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Test Bridge", WS_CHILD | WS_VISIBLE,
                       152, 112, 132, 30, h, (HMENU)ID_NETTEST, NULL, NULL);
        CreateWindowEx(0, "STATIC", "Result: (not tested)", WS_CHILD | WS_VISIBLE,
                       16, 164, 352, 28, h, (HMENU)ID_NETSTAT, NULL, NULL);
        /* The seam, stated honestly: the bridge is NOT part of this OS.
         * It is a program on the host machine, and in the browser deploy
         * the user must run it themselves (it lends the OS the host's
         * un-CORS-gated network). */
        CreateWindowEx(0, "STATIC", "The bridge is a program on your host machine.",
                       WS_CHILD | WS_VISIBLE, 16, 198, 352, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "STATIC", "You must run it there yourself:",
                       WS_CHILD | WS_VISIBLE, 16, 226, 352, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "STATIC", "  node tools/net-bridge.js",
                       WS_CHILD | WS_VISIBLE, 16, 254, 352, 28, h, NULL, NULL, NULL);
        net_sync(h);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_NETCHK: {                        /* auto-toggled; apply it */
            HWND chk = GetDlgItem(h, ID_NETCHK);
            int on = (int)SendMessage(chk, BM_GETCHECK, 0, 0);
            if (nc_set("bridge", on ? "on" : "off") != 0) {
                net_sync(h);                     /* store write failed: revert */
                store_fail(h, "the network bridge setting");
            }
            return 0;
        }
        case ID_NETAPP: {
            char buf[NC_URL_MAX];
            GetWindowText(GetDlgItem(h, ID_NETURL), buf, sizeof buf);
            if (strncmp(buf, "http://", 7) != 0 && strncmp(buf, "https://", 8) != 0) {
                net_sync(h);                     /* not a URL: revert the edit */
                MessageBox(h, "The bridge URL must start with http:// or https://",
                           "Network Properties", MB_OK | MB_ICONEXCLAMATION);
                return 0;
            }
            if (nc_set("url", buf) != 0) {
                net_sync(h);                     /* store write failed: revert */
                store_fail(h, "the bridge URL");
            }
            return 0;
        }
        case ID_NETTEST:
            net_test(h);
            return 0;
        }
        return 0;
    case WM_DESTROY:
        g_applet[APP_NET] = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* ------------------------------------------------------------- the hub */

typedef LRESULT (CALLBACK *WndProcFn)(HWND, UINT, WPARAM, LPARAM);

static const struct { const char *cls; WndProcFn proc; int w, h; }
APP_DEF[APP_N] = {
    /* 20px-font retune (v133-qa): every applet's window + control geometry
     * was Win95-sized; grown to the 28px text line box / 30px control rhythm
     * and the real 12px/char label advances (group labels clear their frame
     * before the first child row, buttons/statics fit their text). */
    { "CplSound",    sound_proc,    324, 156 },
    { "CplSndScheme", sounds_proc,  324, 126 },
    { "CplSystem",   system_proc,   384, 220 },
    { "CplDisplay",  display_proc,  324, 288 },
    { "CplDateTime", datetime_proc, 300, 76  },
    { "CplSaver",    saver_proc,    336, 212 },
    { "CplKeyboard", keyboard_proc, 496, 150 },
    { "CplDefProg",  defprog_proc,  560, 326 },
    { "CplNetwork",  net_proc,      384, 292 },
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

/* icon cell geometry (hub client space). 20px-font retune (v133-qa): the
 * old 76px label box clipped every wide label ("Screen Saver" is ~144px at
 * 12px/char, "Keyboard" ~96px). The label is now a two-line word-wrapped
 * box (real Win95/XP CPL behaviour) so a 120px cell holds the widest single
 * word AND "Date/Time" (108px, no break point) on one line, while
 * "Screen Saver" wraps to two. */
#define CELL_W  120
#define ICON_W  112
#define ICON_H  96
#define ICON_LBL_TOP 36                 /* art occupies the top ~34px */
/* The hub wraps at HUB_COLS icons per row (#349 added the 9th applet —
 * one row of 9 is 1088px, wider than an 800-1024px screen; the Win95 CPL
 * folder wraps too). 6 columns = 728px, fits the smallest test screens. */
#define HUB_COLS 6
#define CELL_H  104                     /* ICON_H + row gap */
#define HUB_ROWS ((APP_N + HUB_COLS - 1) / HUB_COLS)

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
    case APP_KEYBOARD: {                         /* keyboard: body + keys */
        HBRUSH b = CreateSolidBrush(RGB(160, 160, 160));
        HGDIOBJ ob = SelectObject(dc, b);
        Rectangle(dc, x + 2, y + 9, x + 30, y + 24);
        SelectObject(dc, ob);
        DeleteObject(b);
        HBRUSH k = CreateSolidBrush(RGB(255, 255, 255));
        for (int r = 0; r < 2; r++)
            for (int col = 0; col < 6; col++) {
                RECT key = { x + 5 + col * 4 + r * 2, y + 12 + r * 5,
                             x + 8 + col * 4 + r * 2, y + 15 + r * 5 };
                FillRect(dc, &key, k);
            }
        DeleteObject(k);
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
    case APP_DEFPROG: {                          /* two programs, one ticked */
        HBRUSH w = CreateSolidBrush(RGB(255, 255, 255));
        HGDIOBJ ow = SelectObject(dc, w);
        Rectangle(dc, x + 2, y + 4, x + 18, y + 16);
        Rectangle(dc, x + 2, y + 18, x + 18, y + 30);
        SelectObject(dc, ow);
        DeleteObject(w);
        MoveToEx(dc, x + 21, y + 9, NULL);       /* the tick on the first */
        LineTo(dc, x + 24, y + 13);
        LineTo(dc, x + 30, y + 3);
        break;
    }
    case APP_NET: {                              /* globe: circle + graticule */
        HBRUSH b = CreateSolidBrush(RGB(0, 160, 200));
        HGDIOBJ ob = SelectObject(dc, b);
        Ellipse(dc, x + 2, y + 2, x + 30, y + 30);
        SelectObject(dc, ob);
        DeleteObject(b);
        MoveToEx(dc, x + 2, y + 16, NULL);       /* equator */
        LineTo(dc, x + 30, y + 16);
        MoveToEx(dc, x + 16, y + 2, NULL);       /* meridian */
        LineTo(dc, x + 16, y + 30);
        HGDIOBJ oh = SelectObject(dc, GetStockObject(NULL_BRUSH));
        Ellipse(dc, x + 9, y + 2, x + 23, y + 30);   /* inner meridian ring */
        SelectObject(dc, oh);
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
            RECT lr = { 2, ICON_LBL_TOP, ICON_W - 2, ICON_H - 2 };
            SetBkMode(dc, TRANSPARENT);
            /* Word-wrapped label (20px-font retune): measure the wrapped
             * height first so the navy selection strip hugs the actual text
             * (one line for "Sound", two for "Screen Saver") instead of a
             * fixed 18px box that clipped both. */
            RECT mr = lr;
            DrawText(dc, APP_NAME[i], -1, &mr,
                     DT_CENTER | DT_WORDBREAK | DT_CALCRECT);
            int th = mr.bottom - mr.top;
            if (th > lr.bottom - lr.top) th = lr.bottom - lr.top;
            RECT box = { lr.left, lr.top, lr.right, lr.top + th };
            if (i == g_sel) {                    /* selection = navy strip */
                HBRUSH b = CreateSolidBrush(RGB(0, 0, 128));
                FillRect(dc, &box, b);
                DeleteObject(b);
                SetTextColor(dc, RGB(255, 255, 255));
            } else {
                SetTextColor(dc, RGB(0, 0, 0));
            }
            DrawText(dc, APP_NAME[i], -1, &box, DT_CENTER | DT_WORDBREAK);
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
                                       8 + (i % HUB_COLS) * CELL_W,
                                       8 + (i / HUB_COLS) * CELL_H,
                                       ICON_W, ICON_H,
                                       h, (HMENU)(200 + i), NULL, NULL);
        return 0;
    case WM_KEYDOWN:
        /* grid nav: Left/Right walk the index (wrapping across rows the
         * natural way), Up/Down move a whole row; select_icon's bounds
         * check makes edge moves no-ops */
        switch (wp) {
        case VK_LEFT:  select_icon(g_sel - 1); return 0;
        case VK_RIGHT: select_icon(g_sel + 1); return 0;
        case VK_UP:    select_icon(g_sel - HUB_COLS); return 0;
        case VK_DOWN:  select_icon(g_sel + HUB_COLS); return 0;
        case VK_HOME:  select_icon(0); return 0;
        case VK_END:   select_icon(APP_N - 1); return 0;
        case VK_RETURN: open_applet(g_sel); return 0;
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
    int hubCols = APP_N < HUB_COLS ? APP_N : HUB_COLS;
    g_hub = CreateWindowEx(0, "CtlPanel", "Control Panel",
                           WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT,
                           16 + hubCols * CELL_W - (CELL_W - ICON_W),
                           16 + HUB_ROWS * CELL_H - (CELL_H - ICON_H),
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
