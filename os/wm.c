/* wm.c — /bin/wm, the window-management policy client (todos/0014).
 *
 * Policy lives HERE, out of the kernel: this ordinary wasm process speaks
 * the framed WM protocol (wm_proto.h) over the kernel-owned AF_UNIX
 * endpoint. It subscribes to scene events, places new windows (cascade
 * clear of the taskbar), and draws the taskbar — itself just a borderless
 * SDL window whose surface is an shm kernel surface like any other app's.
 * Buttons: click focuses (restoring if minimized); clicking the focused
 * window's button minimizes it (the Win95 toggle). Maximize (todos/0025)
 * also lives here: EV_TITLE_ACTIVATE (title double-click / wmctl max)
 * toggles between the work area and saved geometry, dispatching on the
 * RESIZABLE bit — configure vs scale-to-fit. A wm restart forgets
 * maximize state (deliberate: restarting the WM tidies the desktop).
 *
 * The Start menu (todos/0028) is a second borderless SDL window in this
 * same process, created on Start-button click and destroyed on selection
 * or dismiss — SDL events dispatch per window by e.*.windowID. Entries
 * come from /etc/menu (seeded): a symlink is spawned directly (the fs
 * resolves it), a one-line text file is an argv line (tty apps ride
 * `term ...`). Children spawn with cwd /root (the wm chdir's at startup —
 * doom finds its WAD by cwd) and are reaped with a WNOHANG poll.
 *
 * The kernel keeps its chrome policy (drag, close box, click-to-focus) as
 * the WM-crashed fallback — killing this process leaves the system usable,
 * and it can simply be started again (`wm &`).
 *
 * Spawned at boot as a kernel service (ppid 0) by os/kernel-worker.js and
 * os/boot.js; seeded by os/image.json.
 */
#include <SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <spawn.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/select.h>
#include "wm_proto.h"

#define BAR_H     28
#define START_W   50    /* the Start button strip at the taskbar's left (0028) */
#define BTN_W     104
#define BTN_GAP   4
#define MAX_WIN   64
#define TITLE_H   28    /* keep placements below the kernel title bar (>= WM_TITLE_H) */

#define MENU_W       150
#define MENU_ENTRY_H 20
#define MENU_PAD     4
#define MAX_MENU     32

typedef struct {
    int32_t sid, pid;
    int32_t x, y, w, h;                /* tracked geometry (EV_MOVED /
                                          EV_CONFIGURED) — the EV_SCREEN
                                          re-clamp needs it (todos/0023) */
    int32_t dst_w, dst_h;              /* on-screen viewport (EV_SCALED,
                                          todos/0024) — the clamp must use
                                          the SCALED size */
    int minimized, focused;
    int resizable;                     /* WMP_F_RESIZABLE at create — the
                                          maximize dispatch bit (todos/0025) */
    int maximized;                     /* maximize state lives HERE, not in
                                          the kernel (todos/0025) */
    int32_t sx, sy, sw, sh;            /* saved geometry for restore: x, y,
                                          and w/h (resizable) or dst (fixed) */
    char title[32];
} win_t;

static int sock = -1;
static int scr_w = 800, scr_h = 500;
static win_t wins[MAX_WIN];
static int nwins = 0;
static int32_t bar_sid = 0;        /* our own taskbar surface */
static int own_pid = 0;
static int place_k = 0;            /* cascade counter */
static SDL_Window *bar_win;
static SDL_Surface *bar_surf;
static int bar_w;

/* Start menu state (todos/0028): a second borderless window, live only
 * while open. Entries are (re)read from /etc/menu at each open. */
typedef struct { char name[32]; int is_link; } menu_ent;
static SDL_Window *menu_win;       /* NULL = closed */
static SDL_Surface *menu_surf;
static int32_t menu_sid = 0;       /* from our own EV_CREATED ("startmenu") */
static menu_ent menu[MAX_MENU];
static int menu_n = 0;
static int menu_hover = -1;
static int nkids = 0;              /* live spawned children (reap on frame) */

/* ---- 5x7 font (classic HD44780-style patterns), A-Z 0-9 - . ---- */
static const uint8_t F_AZ[26][7] = {
    {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11}, {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E},
    {0x0E,0x11,0x10,0x10,0x10,0x11,0x0E}, {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E},
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F}, {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10},
    {0x0E,0x11,0x10,0x17,0x11,0x11,0x0F}, {0x11,0x11,0x11,0x1F,0x11,0x11,0x11},
    {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E}, {0x07,0x02,0x02,0x02,0x02,0x12,0x0C},
    {0x11,0x12,0x14,0x18,0x14,0x12,0x11}, {0x10,0x10,0x10,0x10,0x10,0x10,0x1F},
    {0x11,0x1B,0x15,0x15,0x11,0x11,0x11}, {0x11,0x11,0x19,0x15,0x13,0x11,0x11},
    {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E}, {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10},
    {0x0E,0x11,0x11,0x11,0x15,0x12,0x0D}, {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},
    {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E}, {0x1F,0x04,0x04,0x04,0x04,0x04,0x04},
    {0x11,0x11,0x11,0x11,0x11,0x11,0x0E}, {0x11,0x11,0x11,0x11,0x11,0x0A,0x04},
    {0x11,0x11,0x11,0x15,0x15,0x15,0x0A}, {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11},
    {0x11,0x11,0x11,0x0A,0x04,0x04,0x04}, {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F},
};
static const uint8_t F_09[10][7] = {
    {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E}, {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F}, {0x1F,0x02,0x04,0x02,0x01,0x11,0x0E},
    {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02}, {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    {0x06,0x08,0x10,0x1E,0x11,0x11,0x0E}, {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E}, {0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C},
};
static const uint8_t F_DASH[7] = {0,0,0,0x1F,0,0,0};
static const uint8_t F_DOT[7]  = {0,0,0,0,0,0x0C,0x0C};

static const uint8_t *glyph(char c) {
    if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
    if (c >= 'A' && c <= 'Z') return F_AZ[c - 'A'];
    if (c >= '0' && c <= '9') return F_09[c - '0'];
    if (c == '-') return F_DASH;
    if (c == '.') return F_DOT;
    return NULL;                       /* space / unknown: blank */
}

static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

/* Drawing helpers over any surface (sw x sh) — the taskbar and the Start
 * menu share them (todos/0028). */
static void draw_text_s(uint32_t *px, int sw, int sh, int x, int y,
                        const char *s, uint32_t col) {
    for (; *s; s++, x += 6) {
        if (x + 5 > sw) break;
        const uint8_t *g = glyph(*s);
        if (!g) continue;
        for (int r = 0; r < 7; r++) {
            if (y + r >= sh) break;
            for (int c = 0; c < 5; c++)
                if (g[r] & (0x10 >> c)) px[(y + r) * sw + x + c] = col;
        }
    }
}

static void fill_s(uint32_t *px, int sw, int sh, int x, int y, int w, int h,
                   uint32_t col) {
    for (int j = y; j < y + h; j++)
        for (int i = x; i < x + w; i++)
            if (i >= 0 && i < sw && j >= 0 && j < sh) px[j * sw + i] = col;
}

static void draw_text(uint32_t *px, int x, int y, const char *s, uint32_t col) {
    draw_text_s(px, bar_w, BAR_H, x, y, s, col);
}

static void fill(uint32_t *px, int x, int y, int w, int h, uint32_t col) {
    fill_s(px, bar_w, BAR_H, x, y, w, h, col);
}

/* ---- scene model, driven by protocol events ---- */

static win_t *find(int32_t sid) {
    for (int i = 0; i < nwins; i++) if (wins[i].sid == sid) return &wins[i];
    return NULL;
}

static void place(int32_t sid, int w, int h) {
    /* Cascade, clear of the taskbar strip and the kernel title bar. */
    int span_x = scr_w - w - 24;  if (span_x < 40) span_x = 40;
    int span_y = scr_h - BAR_H - h - TITLE_H - 24; if (span_y < 40) span_y = 40;
    int32_t a[3] = { sid, 12 + (place_k * 28) % span_x,
                     TITLE_H + 8 + (place_k * 24) % span_y };
    place_k++;
    wmp_send(sock, WMP_MOVE, a, 3);    /* fire-and-forget; R_OK skipped */
}

/* The largest aspect-correct dst for w's BUFFER that fits box (bw, bh),
 * with an integer-snap nicety — a scale within 15% of a whole multiple
 * snaps to it (the pixel-art case: gameboy at exactly 2x). The snap may
 * round UP past the box (a drag box is an approximate gesture — desired)
 * unless allow_over is 0 (maximize must never overflow the work area:
 * then an over-box snap falls back to the raw fit). The kernel floors dst
 * dims at 32; preserve aspect by flooring the SCALE, not the dims. Shared
 * by the drag-release answer (0024) and the fixed-size maximize branch
 * (0025). */
static void fit_dst(const win_t *w, int32_t bw, int32_t bh, int allow_over,
                    int32_t *ow, int32_t *oh) {
    float s = (float)bw / (float)w->w;
    float sy = (float)bh / (float)w->h;
    if (sy < s) s = sy;
    float snap = (float)(int)(s + 0.5f);
    if (snap >= 1.0f && s >= snap * 0.85f && s <= snap * 1.15f &&
        (allow_over || ((float)w->w * snap <= (float)bw &&
                        (float)w->h * snap <= (float)bh)))
        s = snap;
    float floor_s = 32.0f / (float)(w->w < w->h ? w->w : w->h);
    if (s < floor_s) s = floor_s;
    *ow = (int32_t)(w->w * s + 0.5f);
    *oh = (int32_t)(w->h * s + 0.5f);
}

/* The user drag-released a fixed-size window's frame at box (bw, bh)
 * (EV_SCALE_REQ, todos/0024): answer with the aspect-fit SET_DST. The
 * echo (EV_SCALED) updates the model. */
static void scale_request(int32_t sid, int32_t bw, int32_t bh) {
    win_t *w = find(sid);
    if (!w || w->w <= 0 || w->h <= 0) return;
    int32_t a[3] = { sid, 0, 0 };
    fit_dst(w, bw, bh, 1, &a[1], &a[2]);
    wmp_send(sock, WMP_SET_DST, a, 3);
}

/* Fill the work area (screen minus taskbar, below the kernel title bar)
 * with w — the maximize half of the 0025 toggle, also re-run on EV_SCREEN
 * while maximized. Dispatch on the RESIZABLE bit (the same bit that makes
 * RESIZE vs SET_DST legal — exclusive modes, todos/0021/0024): resizable
 * gets a real MOVE + RESIZE configure to the work area; fixed-size gets
 * the aspect-fit SET_DST letterbox, centered. Echoes (EV_MOVED /
 * EV_CONFIGURED / EV_SCALED) update the model. */
static void maximize(win_t *w) {
    int32_t work_w = scr_w, work_h = scr_h - BAR_H - TITLE_H;
    if (work_w < 64 || work_h < 64) return;    /* degenerate screen: skip */
    if (w->resizable) {
        int32_t m[3] = { w->sid, 0, TITLE_H };
        wmp_send(sock, WMP_MOVE, m, 3);
        int32_t r[3] = { w->sid, work_w, work_h };
        wmp_send(sock, WMP_RESIZE, r, 3);
    } else {
        int32_t d[3] = { w->sid, 0, 0 };
        fit_dst(w, work_w, work_h, 0, &d[1], &d[2]);
        int32_t m[3] = { w->sid, (work_w - d[1]) / 2,
                         TITLE_H + (work_h - d[2]) / 2 };
        wmp_send(sock, WMP_MOVE, m, 3);
        wmp_send(sock, WMP_SET_DST, d, 3);
    }
}

/* EV_TITLE_ACTIVATE (title double-click or wmctl max, todos/0025): toggle.
 * First activate saves geometry (w/h for resizable, dst for fixed — the
 * mode the branch will clobber) and maximizes; the second restores it. */
static void title_activate(int32_t sid) {
    win_t *w = find(sid);
    if (!w || w->w <= 0 || w->h <= 0) return;
    if (!w->maximized) {
        w->sx = w->x; w->sy = w->y;
        w->sw = w->resizable ? w->w : w->dst_w;
        w->sh = w->resizable ? w->h : w->dst_h;
        w->maximized = 1;
        maximize(w);
    } else {
        w->maximized = 0;
        int32_t m[3] = { w->sid, w->sx, w->sy };
        wmp_send(sock, WMP_MOVE, m, 3);
        int32_t g[3] = { w->sid, w->sw, w->sh };
        wmp_send(sock, w->resizable ? WMP_RESIZE : WMP_SET_DST, g, 3);
    }
}

/* ---- launching + the Start menu (todos/0028) ---- */

/* Spawn an app the desktop way: own pgroup, PATH/HOME env, cwd inherited
 * from the wm (/root — doom finds its WAD by cwd). Children get the wm's
 * std fds (the kernel gives parentless services the system std OFDs, and
 * spawn inherits them), so startup printf's land on the console. */
static void spawn_path(const char *path, char *const argv[]) {
    static char *const envp[] = { "PATH=/bin", "HOME=/root", 0 };
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);           /* 0 = child's own pid */
    pid_t pid;
    if (posix_spawn(&pid, path, 0, &at, (char *const *)argv, envp) == 0) nkids++;
    posix_spawnattr_destroy(&at);
}

/* The wm never blocks in wait: children are polled off the frame tick.
 * (Only ppid-0 processes auto-reap; wm children would zombie otherwise.
 * If the wm dies first, orphans reparent to pid 1, which reaps.) */
static void reap_kids(void) {
    int st;
    while (nkids > 0 && waitpid(-1, &st, WNOHANG) > 0) nkids--;
}

static int entcmp(const void *a, const void *b) {
    return strcmp(((const menu_ent *)a)->name, ((const menu_ent *)b)->name);
}

/* Read /etc/menu: name = filename, symlink vs one-line-command told apart
 * at launch time by lstat. Plain sort for a deterministic layout. */
static void menu_load(void) {
    menu_n = 0;
    DIR *d = opendir("/etc/menu");
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) && menu_n < MAX_MENU) {
        if (de->d_name[0] == '.') continue;
        struct stat st;
        char path[300];
        snprintf(path, sizeof path, "/etc/menu/%s", de->d_name);
        if (lstat(path, &st) != 0) continue;
        menu_ent *e = &menu[menu_n++];
        snprintf(e->name, sizeof e->name, "%s", de->d_name);
        e->is_link = S_ISLNK(st.st_mode);
    }
    closedir(d);
    qsort(menu, menu_n, sizeof menu[0], entcmp);
}

static void menu_dismiss(void) {
    if (!menu_win) return;
    SDL_DestroyWindow(menu_win);
    menu_win = NULL;
    menu_surf = NULL;
    menu_sid = 0;
    menu_hover = -1;
}

/* Selection: a symlink entry is spawned via its /etc/menu path (the fs
 * resolves the link); a regular file's first line is the argv (bare
 * argv[0] resolves in /bin — `term snake` runs snake in a terminal). */
static void menu_launch(int idx) {
    if (idx < 0 || idx >= menu_n) return;
    char path[300];
    snprintf(path, sizeof path, "/etc/menu/%s", menu[idx].name);
    if (menu[idx].is_link) {
        char *argv[2] = { menu[idx].name, 0 };
        spawn_path(path, argv);
        return;
    }
    FILE *f = fopen(path, "r");
    if (!f) return;
    static char line[160];
    line[0] = 0;
    if (!fgets(line, sizeof line, f)) { fclose(f); return; }
    fclose(f);
    line[strcspn(line, "\r\n")] = 0;
    char *argv[9];
    int n = 0;
    for (char *t = strtok(line, " \t"); t && n < 8; t = strtok(NULL, " \t"))
        argv[n++] = t;
    argv[n] = 0;
    if (n == 0) return;
    char full[300];
    if (argv[0][0] == '/') snprintf(full, sizeof full, "%s", argv[0]);
    else snprintf(full, sizeof full, "/bin/%s", argv[0]);
    spawn_path(full, argv);
}

static int menu_h(void) { return 2 * MENU_PAD + menu_n * MENU_ENTRY_H; }

/* Toggle from the Start button. The window parks above the taskbar when
 * its EV_CREATED echo arrives (title "startmenu" — see handle_event). */
static void menu_toggle(void) {
    if (menu_win) { menu_dismiss(); return; }
    menu_load();
    if (menu_n == 0) return;
    menu_win = SDL_CreateWindow("startmenu", MENU_W, menu_h(), SDL_WINDOW_BORDERLESS);
    if (!menu_win) return;
    menu_surf = SDL_GetWindowSurface(menu_win);
    menu_hover = -1;
}

static void menu_click(float fy) {
    int idx = ((int)fy - MENU_PAD) / MENU_ENTRY_H;
    if ((int)fy >= MENU_PAD && idx >= 0 && idx < menu_n) menu_launch(idx);
    menu_dismiss();                    /* selection or a dead-zone click */
}

static void draw_menu(void) {
    if (!menu_win) return;
    int w = MENU_W, h = menu_h();
    uint32_t *px = (uint32_t *)menu_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0),
             sel = rgb(0, 0, 128), seltxt = rgb(255, 255, 255);
    fill_s(px, w, h, 0, 0, w, h, face);
    /* Win95 raised edge: light top/left, dark bottom/right. */
    fill_s(px, w, h, 0, 0, w, 1, hi);
    fill_s(px, w, h, 0, 0, 1, h, hi);
    fill_s(px, w, h, 0, h - 1, w, 1, sh);
    fill_s(px, w, h, w - 1, 0, 1, h, sh);
    for (int i = 0; i < menu_n; i++) {
        int y = MENU_PAD + i * MENU_ENTRY_H;
        if (i == menu_hover)
            fill_s(px, w, h, 2, y, w - 4, MENU_ENTRY_H, sel);
        draw_text_s(px, w, h, 10, y + (MENU_ENTRY_H - 7) / 2, menu[i].name,
                    i == menu_hover ? seltxt : txt);
    }
    SDL_UpdateWindowSurface(menu_win);
}

/* Create the taskbar window at the current screen width. Its EV_CREATED
 * echo (own pid) parks it at the bottom edge — see handle_event. */
static int make_bar(void) {
    bar_w = scr_w;
    bar_win = SDL_CreateWindow("taskbar", bar_w, BAR_H, SDL_WINDOW_BORDERLESS);
    if (!bar_win) return -1;
    bar_surf = SDL_GetWindowSurface(bar_win);
    return 0;
}

/* The screen changed resolution (EV_SCREEN, todos/0023). Re-lay the taskbar
 * by destroy + recreate (there is no client-initiated resize, by 0019's
 * design), give focus back (a create steals it), and re-clamp windows so
 * every title bar stays reachable and clear of the taskbar. Policy: clamp,
 * don't re-cascade — no placement churn on a mere resize. */
static void screen_changed(void) {
    menu_dismiss();                    /* geometry is stale; reopen re-lays */
    if (bar_win) SDL_DestroyWindow(bar_win);
    if (make_bar() != 0) exit(2);
    for (int i = 0; i < nwins; i++)
        if (wins[i].focused && !wins[i].minimized) {
            int32_t a[1] = { wins[i].sid };
            wmp_send(sock, WMP_FOCUS, a, 1);
            break;
        }
    for (int i = 0; i < nwins; i++) {
        win_t *w = &wins[i];
        if (w->maximized) { maximize(w); continue; }   /* re-fit (todos/0025) */
        int nx = w->x, ny = w->y;
        if (nx > scr_w - 40) nx = scr_w - 40;
        if (nx < 40 - w->dst_w) nx = 40 - w->dst_w;   /* on-screen size (0024) */
        if (ny > scr_h - BAR_H - 8) ny = scr_h - BAR_H - 8;
        if (ny < TITLE_H) ny = TITLE_H;
        if (nx != w->x || ny != w->y) {
            int32_t a[3] = { w->sid, nx, ny };
            wmp_send(sock, WMP_MOVE, a, 3);   /* echo updates the model */
        }
    }
}

static void handle_event(wmp_hdr *h) {
    if (h->type == WMP_EV_CREATED) {
        wmp_rec r;
        if (h->plen != sizeof r || wmp_read_all(sock, &r, (int)sizeof r) != 0) exit(1);
        if (r.pid == own_pid) {        /* our own furniture: park by title */
            if (strncmp(r.title, "startmenu", 9) == 0) {   /* todos/0028 */
                menu_sid = r.sid;
                int32_t a[3] = { r.sid, 0, scr_h - BAR_H - menu_h() };
                wmp_send(sock, WMP_MOVE, a, 3);
            } else {                   /* the taskbar: bottom edge */
                bar_sid = r.sid;
                int32_t a[3] = { r.sid, 0, scr_h - BAR_H };
                wmp_send(sock, WMP_MOVE, a, 3);
            }
            return;
        }
        if (r.flags & WMP_F_BORDERLESS) return;   /* not ours to manage */
        if (nwins < MAX_WIN) {
            win_t *w = &wins[nwins++];
            w->sid = r.sid; w->pid = r.pid;
            w->x = r.x; w->y = r.y; w->w = r.w; w->h = r.h;
            w->dst_w = r.dst_w; w->dst_h = r.dst_h;
            w->minimized = (r.flags & WMP_F_MINIMIZED) ? 1 : 0;
            w->focused = (r.flags & WMP_F_FOCUSED) ? 1 : 0;
            w->resizable = (r.flags & WMP_F_RESIZABLE) ? 1 : 0;
            w->maximized = 0;          /* slots are reused: reset (0025) */
            memcpy(w->title, r.title, 32);
            w->title[31] = 0;
        }
        place(r.sid, r.w, r.h);
        return;
    }
    /* All other events lead with the sid; none exceeds 8 words except
     * EV_TITLE (sid + 32-byte title), which reads its pieces directly. */
    int32_t p[8];
    if (h->plen > sizeof p && h->type != WMP_EV_TITLE) { wmp_skip(sock, h->plen); return; }
    switch (h->type) {
    case WMP_EV_DESTROYED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        if (p[0] == menu_sid) menu_sid = 0;               /* defensive (0028) */
        for (int i = 0; i < nwins; i++)
            if (wins[i].sid == p[0]) { wins[i] = wins[--nwins]; break; }
        break;
    }
    case WMP_EV_FOCUS: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        /* Focus moving anywhere but the menu itself dismisses it (0028).
         * The menu's own create-focus echo is exempt — it may even arrive
         * in the same drain as the EV_CREATED that told us its sid. */
        if (menu_win && p[0] != menu_sid) menu_dismiss();
        for (int i = 0; i < nwins; i++) {
            wins[i].focused = wins[i].sid == p[0];
            if (wins[i].focused) wins[i].minimized = 0;   /* focus restores */
        }
        break;
    }
    case WMP_EV_MINIMIZED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        win_t *w = find(p[0]);
        if (w) { w->minimized = p[1] ? 1 : 0; if (w->minimized) w->focused = 0; }
        break;
    }
    case WMP_EV_TITLE: {
        int32_t sid;
        char t[32];
        if (h->plen != 4 + 32 || wmp_read_all(sock, &sid, 4) != 0 ||
            wmp_read_all(sock, t, 32) != 0) exit(1);
        win_t *w = find(sid);
        if (w) { memcpy(w->title, t, 32); w->title[31] = 0; }
        break;
    }
    case WMP_EV_MOVED: {                /* tracked for the EV_SCREEN re-clamp */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        win_t *w = find(p[0]);
        if (w) { w->x = p[1]; w->y = p[2]; }
        break;
    }
    case WMP_EV_CONFIGURED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        win_t *w = find(p[0]);
        /* configure implies resizable: dst tracks the buffer (todos/0024) */
        if (w) { w->w = p[1]; w->h = p[2]; w->dst_w = p[1]; w->dst_h = p[2]; }
        break;
    }
    case WMP_EV_SCALED: {               /* dst viewport changed (todos/0024) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        win_t *w = find(p[0]);
        if (w) { w->dst_w = p[1]; w->dst_h = p[2]; }
        break;
    }
    case WMP_EV_SCALE_REQ: {            /* drag box -> aspect-fit SET_DST */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        scale_request(p[0], p[1], p[2]);
        break;
    }
    case WMP_EV_TITLE_ACTIVATE: {       /* maximize toggle (todos/0025) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        title_activate(p[0]);
        break;
    }
    case WMP_EV_SCREEN: {               /* dynamic resolution (todos/0023) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        scr_w = p[0]; scr_h = p[1];
        screen_changed();
        break;
    }
    default:
        if (wmp_skip(sock, h->plen) != 0) exit(1);
    }
}

/* Drain the socket: replies (fire-and-forget acks) are skipped, events
 * update the model. select() keeps the frame loop non-blocking. */
static void drain_socket(void) {
    for (;;) {
        fd_set rf;
        struct timeval tv = { 0, 0 };
        FD_ZERO(&rf);
        FD_SET(sock, &rf);
        if (select(sock + 1, &rf, NULL, NULL, &tv) <= 0) return;
        wmp_hdr h;
        if (wmp_next(sock, &h) != 0) exit(1);      /* endpoint gone: give up */
        if (h.type >= 0x80) handle_event(&h);
        else if (wmp_skip(sock, h.plen) != 0) exit(1);
    }
}

/* ---- the taskbar ---- */

static void bar_click(float fx) {
    if ((int)fx < START_W) { menu_toggle(); return; }     /* Start (0028) */
    menu_dismiss();                    /* any other taskbar click dismisses */
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (BTN_W + BTN_GAP);
    if (rel < 0 || rel % (BTN_W + BTN_GAP) >= BTN_W || i >= nwins) return;
    int32_t a[1] = { wins[i].sid };
    if (wins[i].focused && !wins[i].minimized) wmp_send(sock, WMP_MINIMIZE, a, 1);
    else wmp_send(sock, WMP_FOCUS, a, 1);
}

static void draw_bar(void) {
    uint32_t *px = (uint32_t *)bar_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0);
    fill(px, 0, 0, bar_w, BAR_H, face);
    fill(px, 0, 0, bar_w, 1, hi);                       /* top edge highlight */
    /* The Start button (todos/0028): raised normally, sunken while open. */
    {
        int down = menu_win != NULL;
        fill(px, 2, 3, START_W - 4, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, 2, 3, START_W - 4, 1, down ? sh : hi);
        fill(px, 2, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, 2, BAR_H - 4, START_W - 4, 1, down ? hi : sh);
        fill(px, START_W - 3, 3, 1, BAR_H - 6, down ? hi : sh);
        draw_text(px, 8, (BAR_H - 7) / 2, "START", txt);
    }
    for (int i = 0; i < nwins; i++) {
        int x = START_W + BTN_GAP + i * (BTN_W + BTN_GAP) + 2;
        if (x + BTN_W > bar_w) break;
        int down = wins[i].focused && !wins[i].minimized;
        /* Win95 button relief: raised normally, sunken when active. */
        fill(px, x, 3, BTN_W, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, x, 3, BTN_W, 1, down ? sh : hi);
        fill(px, x, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, x, BAR_H - 4, BTN_W, 1, down ? hi : sh);
        fill(px, x + BTN_W - 1, 3, 1, BAR_H - 6, down ? hi : sh);
        char label[17];
        int n = 0;
        for (const char *s = wins[i].title; *s && n < 16; s++) label[n++] = *s;
        label[n] = 0;
        draw_text(px, x + 6, (BAR_H - 7) / 2, label,
                  wins[i].minimized ? rgb(80, 80, 80) : txt);
    }
    SDL_UpdateWindowSurface(bar_win);
}

static void frame_cb(void) {
    drain_socket();
    reap_kids();
    /* Two windows, one queue: dispatch by windowID (todos/0028). */
    SDL_WindowID mid = menu_win ? SDL_GetWindowID(menu_win) : 0;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
            if (menu_win && e.button.windowID == mid) menu_click(e.button.y);
            else bar_click(e.button.x);
            mid = menu_win ? SDL_GetWindowID(menu_win) : 0;   /* may toggle */
        } else if (e.type == SDL_EVENT_MOUSE_MOTION) {
            if (menu_win && e.motion.windowID == mid) {
                int idx = ((int)e.motion.y - MENU_PAD) / MENU_ENTRY_H;
                menu_hover = ((int)e.motion.y >= MENU_PAD && idx < menu_n) ? idx : -1;
            }
        } else if (e.type == SDL_EVENT_QUIT) exit(0);
    }
    draw_bar();
    draw_menu();
}

int main(void) {
    own_pid = getpid();
    chdir("/root");                    /* children inherit the cwd (0028) */
    sock = wmp_connect();
    if (sock < 0) { fprintf(stderr, "wm: cannot reach %s\n", WM_SOCK_PATH); return 1; }

    /* Subscribe; the R_OK reply carries the screen dims. */
    if (wmp_send(sock, WMP_SUBSCRIBE, NULL, 0) != 0) return 1;
    wmp_hdr h;
    if (wmp_next_reply(sock, &h) != 0 || h.type != WMP_R_OK || h.plen < 8) return 1;
    int32_t dims[2];
    if (wmp_read_all(sock, dims, 8) != 0) return 1;
    if (wmp_skip(sock, h.plen - 8) != 0) return 1;
    scr_w = dims[0]; scr_h = dims[1];

    /* The snapshot (EV_CREATED per existing surface + EV_FOCUS) follows on
     * the socket; the frame loop's drain consumes it like live events, so
     * pre-existing windows get buttons AND get re-placed — (re)starting
     * the WM deliberately tidies the desktop. */
    SDL_Init(SDL_INIT_VIDEO);
    if (make_bar() != 0) return 2;
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
