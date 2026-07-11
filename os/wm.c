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
 * The Start menu (todos/0028, restyled Win95-classic by todos/0078) is a
 * set of borderless SDL windows in this same process, created on
 * Start-button click (or the Ctrl+Esc chord / `wmctl menu` — WMP EV_MENU,
 * the EV_CYCLE pattern) and destroyed on selection or dismiss — SDL
 * events dispatch per window by e.*.windowID. Entries come from /etc/menu
 * if that directory exists, else the baked default /usr/share/menu
 * (todos/0040 — systemd-style /etc: user overrides only,
 * first-existing-dir wins). Subdirectories are program GROUPS: hovering
 * (or clicking / arrow-Right on) a group row cascades a flyout column
 * open to the right — each column is its own window titled
 * "startmenu"/"startmenu2"/... so the EV_CREATED park can tell them
 * apart. Only the ROOT column ever holds keyboard focus (flyouts hand it
 * back at their create echo, the Aero-Peek precedent — otherwise closing
 * a flyout would bounce focus to an app and the focus rule would dismiss
 * the whole menu); keys are routed by menu-open state, not windowID, so
 * arrows/Enter/type-ahead/Esc drive the DEEPEST column regardless. Below
 * the programs list the root column has a separator + fixed section
 * (SETTINGS -> /bin/ctlpanel, RUN... -> the run dialog; Shut Down joins
 * when todos/0051 lands) and the Win95 sidebar band. The RUN... builtin
 * is one more borderless window ("startrun") with a text field; Enter
 * spawns `/bin/sh -c <input>` the same desktop way. Children spawn with
 * cwd /root (the wm chdir's at startup — doom finds its WAD by cwd) and
 * are reaped with a WNOHANG poll.
 *
 * Aero Peek (todos/0063): hovering a taskbar button raises a live
 * thumbnail popup — another borderless window in this process, fed by
 * kernel WMP_THUMB replies (deterministic box-filter downscale of the
 * app's front buffer), refreshed on a frame-tick timer while hovered.
 * Clicking the preview focuses the window; motion elsewhere on the bar,
 * any click, EV_SCREEN, or an idle timeout dismisses it (the wm only
 * sees motion over its own windows, so "pointer parked over an app"
 * needs the timeout backstop).
 *
 * The desktop layer (todos/0029) is a third borderless window: fullscreen,
 * pinned to the BOTTOM z layer at create (SET_LAYER -1, todos/0038 — the
 * taskbar and Start menu ride the TOP layer, so app windows can neither
 * cover the bar nor sink under the desktop), teal fill + an
 * icon grid from /root/Desktop (re-read on a coarse frame-tick timer).
 * Double-click (SDL event timestamps) launches. Free side effect:
 * desktop clicks — invisible to the WM before (kernel hit-test returned
 * 'desktop' to the embedder only) — are ordinary client clicks on this
 * layer now, so they dismiss the Start menu. Icons are selectable and
 * movable (todos/0077): click / ctrl-click / shift-range / marquee build
 * a selection set, drags move it snapped to the grid with positions
 * persisted in /root/Desktop/.icons, and arrows/Enter/Esc/Ctrl+A drive
 * it from the keyboard — the desktop takes kernel focus on click to make
 * that possible (the kernel's borderless exemption is policy-overridable
 * by the WM asking).
 *
 * Launching is ONE mechanism (activate(), todos/0066), shared by the menu
 * and the desktop (and fileman): a file the kernel can exec — wasm magic
 * `\0asm` or a `#!` script (todos/0065), told apart by peeking the first
 * bytes, through symlinks — spawns directly; anything else opens through
 * the openwith associations (openwith.h, todos/0072): extension map first,
 * then the default.gui program (notepad in the baked store). Launcher
 * entries are ordinary executable scripts (`#!/bin/sh` + a command line),
 * not a private format — the old first-line-argv menu convention is gone
 * (its seeded user, menu/snake, became a real script in image.json v36).
 *
 * Context menus (todos/0091): right-click raises a two-window popup (root
 * "ctxmenu" + at most one "ctxmenu2" flyout — the v1 depth cap) built from
 * fixed item lists. Empty desktop: New >, Sort by >, Refresh, Display
 * (ctlpanel's Display applet); an icon: Open (the 0092 file ops grow
 * here); a taskbar button: Restore/Minimize/Maximize/Close over the
 * chrome ops this process already owns, inapplicable rows grayed. Same
 * furniture rules as the Start menu: top layer, root holds kernel focus
 * (flyouts hand it back), focus-leave/outside-click/Esc dismiss, arrows/
 * Enter drive it. The Start strip and empty bar stay reserved for the
 * 0101 taskbar-strip menu; window title bars for 0102.
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
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <spawn.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/select.h>
#include "wm_proto.h"
#include "openwith.h"
#include "fileops.h"

#define BAR_H     28
#define START_W   50    /* the Start button strip at the taskbar's left (0028) */
#define BTN_W     104   /* preferred button width; shrinks on overflow (0031) */
#define BTN_MIN   24    /* ...but never below a clickable floor */
#define BTN_GAP   4
#define CLOCK_W   45    /* right-aligned HH.MM cell: 8 + 5*6-1 + 8 (0031) */
#define MAX_WIN   64
#define TITLE_H   28    /* keep placements below the kernel title bar (>= WM_TITLE_H) */

#define MENU_W       150    /* list width; a flyout column's full width */
#define MENU_BAND_W  18     /* Win95 sidebar band, root column only (0078) */
#define MENU_ENTRY_H 20
#define MENU_PAD     4
#define MENU_SEP_H   8      /* separator groove above the fixed section */
#define MAX_MENU     32
#define MENU_DEPTH   4      /* root + up to 3 cascading flyouts (0078) */
#define MENU_FIXED   2      /* fixed rows below the separator (root only) */

#define RUN_W        240    /* the RUN... dialog (todos/0078) */
#define RUN_H        70
#define RUN_MAX      100

#define DESK_MARGIN  16     /* the icon grid (todos/0029) */
#define CELL_W       84
#define CELL_H       64
#define ICON_W       24
#define MAX_DESK     64
#define DBLCLICK_NS  500000000ULL   /* 500ms, the SDL click-count window */
#define DRAG_SLOP    4      /* px of button-held travel before a press
                               becomes a marquee or icon drag (todos/0077) */

#define CTX_W        120    /* context menu popup (todos/0091) */
#define CTX_MAX      8

#define PEEK_W       160    /* Aero Peek popup (todos/0063) */
#define PEEK_H       120
#define PEEK_PAD     6      /* face border around the thumbnail */
#define PEEK_REFRESH 30     /* frame ticks between live THUMB refreshes */
#define PEEK_IDLE    150    /* ticks without a hover before auto-dismiss —
                               the wm only sees motion over its OWN windows,
                               so a pointer parked over an app window can't
                               tell us to close; this backstop does */

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
    uint32_t stamp;                    /* focus recency (EV_FOCUS/CREATED) —
                                          the cycling order (todos/0032) */
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

/* Start menu state (todos/0028, cascading columns since todos/0078): one
 * borderless window per open column, live only while open. Entries are
 * (re)read at each open from /etc/menu if present, else /usr/share/menu
 * (todos/0040); subdirectories are groups that cascade flyout columns. */
typedef struct { char name[32]; int is_link; int is_dir; } menu_ent;
typedef struct {
    SDL_Window *win;               /* NULL = column not live */
    SDL_Surface *surf;
    int32_t sid;                   /* EV_CREATED echo ("startmenu[N]") */
    char dir[300];                 /* the directory this column lists */
    menu_ent ents[MAX_MENU];
    int n;
    int hover;                     /* pointer/keyboard cursor row, -1 none */
    int open_child;                /* row whose flyout is open, -1 none */
    int x, y, w, h;                /* screen geometry (the park target) */
} menu_col;
static menu_col mcol[MENU_DEPTH];
static int mdepth = 0;             /* live columns; 0 = menu closed */
static char menu_dir[32];          /* which directory the root open picked */
static const char *menu_fixed[MENU_FIXED] = { "SETTINGS", "RUN..." };
static int nkids = 0;              /* live spawned children (reap on frame) */

/* RUN... dialog state (todos/0078): one more borderless window with a
 * text field; Enter spawns `/bin/sh -c <input>` the desktop way. */
static SDL_Window *run_win;        /* NULL = closed */
static SDL_Surface *run_surf;
static int32_t run_sid = 0;        /* EV_CREATED echo ("startrun") */
static char run_buf[RUN_MAX + 1];
static int run_len = 0;

/* Desktop layer state (todos/0029, selection & manipulation todos/0077):
 * fullscreen, bottom of z, recreated on EV_SCREEN like the taskbar.
 * menu_ent is the same shape (name + is_link). Icons live in grid CELLS
 * (column-major auto-flow, todos/0029); todos/0077 adds free placement —
 * a cell per icon, persisted in /root/Desktop/.icons ("col row name"
 * lines, rewritten on every drag-drop; entries absent from the file
 * auto-flow into the free cells, so a fresh Desktop looks exactly like
 * the pre-0077 grid). Selection is a bitmask over desk[] (MAX_DESK is
 * 64 by design); the desktop takes kernel focus on click so modifier
 * and navigation keys reach it. */
static SDL_Window *desk_win;
static SDL_Surface *desk_surf;
static int32_t desk_sid = 0;
static menu_ent desk[MAX_DESK];
static int desk_col[MAX_DESK], desk_row[MAX_DESK];   /* grid cells (0077) */
static int desk_n = 0;
static uint64_t desk_selmask = 0;  /* selection set, bit i = desk[i] (0077) */
static int desk_anchor = -1;       /* shift-range anchor + keyboard cursor */
static int desk_focused = 0;       /* the desktop holds kernel focus (0077) */
static int desk_dirty = 1;         /* redraw only when contents change */
static int desk_last_idx = -1;     /* double-click tracking (event timestamps) */
static uint64_t desk_last_ns = 0;
static int desk_tick = 0;          /* coarse /root/Desktop re-read timer */
static int mod_ctrl = 0, mod_shift = 0;   /* held modifiers, tracked from
                                             key events by KEYSYM — pointer
                                             records carry no mod word; reset
                                             when the desktop loses focus so
                                             a keyup that went elsewhere can't
                                             wedge them (todos/0077) */
/* Press/drag state (todos/0077). desk_drag: 0 idle, 1 marquee (press began
 * on empty desktop), 2 icon-move (press began on a selected icon). */
static int desk_press = 0;         /* left button is down on the desktop */
static int desk_press_idx = -1;    /* icon under the press, -1 = empty */
static int desk_press_x, desk_press_y;
static int desk_cur_x, desk_cur_y; /* latest drag point */
static int desk_drag = 0;
static int desk_collapse = 0;      /* plain press on an already-selected icon:
                                      collapse the set to it on a drag-less
                                      release (the Win95 mouseup rule) */
static uint32_t zctr = 0;          /* focus-recency counter (todos/0032) */

/* Context menu state (todos/0091): a two-window popup — root + at most one
 * flyout (the recorded v1 depth cap) — built from fixed item lists, not a
 * directory like the Start menu. Same furniture pattern as the menu
 * columns: borderless top-layer windows parked at their EV_CREATED echo
 * ("ctxmenu"/"ctxmenu2"), dismissed when kernel focus leaves them. */
enum {                             /* command ids (ctx_activate dispatch) */
    CM_NONE = 0,
    CM_SUB_NEW, CM_SUB_SORT,       /* rows that cascade the flyout */
    CM_REFRESH, CM_DISPLAY,        /* desktop */
    CM_PASTE,                      /* desktop (0092: the fileops clipboard) */
    CM_NEW_FOLDER, CM_NEW_FILE, CM_SORT_NAME,      /* flyout rows */
    CM_OPEN,                       /* icon */
    CM_CUT, CM_COPY,               /* icon (0092: the selection set) */
    CM_RESTORE, CM_MINIMIZE, CM_MAXIMIZE, CM_CLOSE /* taskbar button */
};
#define CTF_SEP   1                /* separator groove row */
#define CTF_GRAY  2                /* disabled: drawn gray, never fires */
#define CTF_SUB   4                /* cascades the flyout (root only) */
typedef struct { const char *label; int id; int flags; } ctx_ent;

static SDL_Window *ctx_win[2];     /* [0] root, [1] flyout; NULL = closed */
static SDL_Surface *ctx_surf[2];
static int32_t ctx_sid[2];         /* EV_CREATED echoes */
static ctx_ent ctx_ents[2][CTX_MAX];
static int ctx_nent[2];
static int ctx_hover[2];           /* pointer/keyboard cursor row, -1 none */
static int ctx_x[2], ctx_y[2], ctx_h[2];
static int ctx_depth = 0;          /* 0 closed, 1 root, 2 flyout open */
static int ctx_child = -1;         /* root row whose flyout is open */
static int32_t ctx_target = 0;     /* taskbar menu: the acted-on window */
static int ctx_icon = -1;          /* icon menu: desk[] index */
static void ctx_dismiss(void);     /* defined with the rest (0091) */

/* Aero Peek state (todos/0063): hovering a taskbar button raises a live
 * thumbnail popup — a fourth borderless window in this process, fed by
 * kernel THUMB replies (the only R_SHOT this process ever requests, so the
 * drain can claim every R_SHOT for it). */
static SDL_Window *peek_win;       /* NULL = closed */
static SDL_Surface *peek_surf;
static int32_t peek_sid = 0;       /* our popup's surface (EV_CREATED echo) */
static int32_t peek_for = 0;       /* the previewed window */
static int peek_x = 0;             /* popup left edge (from the hovered button) */
static int peek_pending = 0;       /* THUMB in flight */
static int peek_tick = 0;          /* live-refresh countdown */
static int peek_idle = 0;          /* hover-loss auto-dismiss countdown */
static int peek_dirty = 0;         /* fresh thumb: repaint */
static uint8_t peek_px[(PEEK_W - 2 * PEEK_PAD) * (PEEK_H - 2 * PEEK_PAD) * 4];
static int peek_tw = 0, peek_th = 0;

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

/* Vertical text for the sidebar band (todos/0078): glyphs rotated 90 deg
 * so the label reads bottom-up, Win95-style. (x, y) is the BOTTOM of the
 * run; each glyph spans 7px wide (rows -> x) and 5px tall (cols -> -y). */
static void draw_vtext_s(uint32_t *px, int sw, int sh, int x, int y,
                         const char *s, uint32_t col) {
    for (; *s; s++, y -= 6) {
        const uint8_t *g = glyph(*s);
        if (!g) continue;
        for (int r = 0; r < 7; r++)
            for (int c = 0; c < 5; c++)
                if (g[r] & (0x10 >> c)) {
                    int xx = x + r, yy = y - c;
                    if (xx >= 0 && xx < sw && yy >= 0 && yy < sh)
                        px[yy * sw + xx] = col;
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
 * spawn inherits them), so startup printf's land on the console.
 * PATH puts /usr/local/bin first (todos/0040): user-installed binaries
 * deliberately win over system ones. */
static void spawn_path(const char *path, char *const argv[]) {
    static char *const envp[] = { "PATH=/usr/local/bin:/bin", "HOME=/root", 0 };
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

/* One "activate a path" (todos/0066), shared by the Start menu and the
 * desktop grid (fileman keeps its copy in step): anything runnable after
 * symlink resolution — ow_is_runnable peeks through links, so a menu link
 * to a binary still spawns via the link path — runs directly (launchers
 * are ordinary #!/bin/sh scripts); anything else opens through the
 * openwith associations in the GUI context (todos/0072). */
static void activate(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) return;            /* gone, or a dangling link */
    if (S_ISREG(st.st_mode) && ow_is_runnable(path)) {
        const char *name = strrchr(path, '/');
        name = name ? name + 1 : path;
        char *argv[2] = { (char *)name, 0 };
        spawn_path(path, argv);
        return;
    }
    char cmd[OW_CMD_MAX], buf[512], prog[300];
    char *argv[10];
    ow_resolve(path, 1 /* GUI context */, cmd, sizeof cmd);
    if (ow_build(cmd, path, argv, 10, buf, sizeof buf, prog, sizeof prog) > 0)
        spawn_path(prog, argv);
}

static int entcmp(const void *a, const void *b) {
    const menu_ent *ea = (const menu_ent *)a, *eb = (const menu_ent *)b;
    if (ea->is_dir != eb->is_dir) return eb->is_dir - ea->is_dir;   /* groups first (0078) */
    return strcmp(ea->name, eb->name);
}

/* Read a launcher directory: name = filename, symlink vs plain file told
 * apart by lstat; directories (or links to one) are menu GROUPS (0078).
 * Groups-first + alpha sort for a deterministic layout. Shared by the
 * Start menu (/etc/menu) and the desktop grid (/root/Desktop). */
static int load_entries(const char *dir, menu_ent *dst, int max) {
    int n = 0;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *de;
    while ((de = readdir(d)) && n < max) {
        if (de->d_name[0] == '.') continue;
        struct stat st;
        char path[300];
        snprintf(path, sizeof path, "%s/%s", dir, de->d_name);
        if (lstat(path, &st) != 0) continue;
        menu_ent *e = &dst[n++];
        memset(e, 0, sizeof *e);
        snprintf(e->name, sizeof e->name, "%s", de->d_name);
        e->is_link = S_ISLNK(st.st_mode);
        if (S_ISDIR(st.st_mode)) e->is_dir = 1;
        else if (e->is_link) {         /* a link to a directory cascades too */
            struct stat st2;
            e->is_dir = stat(path, &st2) == 0 && S_ISDIR(st2.st_mode);
        }
    }
    closedir(d);
    qsort(dst, n, sizeof dst[0], entcmp);
    return n;
}

/* ---- the RUN... dialog (todos/0078) ---- */

static void run_dismiss(void) {
    if (!run_win) return;
    SDL_DestroyWindow(run_win);
    run_win = NULL;
    run_surf = NULL;
    run_sid = 0;
}

/* The window parks bottom-left above the taskbar when its EV_CREATED echo
 * arrives (title "startrun" — see handle_event); create-focus routes the
 * keyboard here. */
static void run_open(void) {
    if (run_win) return;
    run_len = 0;
    run_buf[0] = 0;
    run_win = SDL_CreateWindow("startrun", RUN_W, RUN_H, SDL_WINDOW_BORDERLESS);
    if (!run_win) return;
    run_surf = SDL_GetWindowSurface(run_win);
}

/* Enter hands the line to /bin/sh -c — full shell semantics (PATH lookup,
 * args, pipes) for free, spawned the same desktop way as menu entries. */
static void run_key(int sym) {
    if (sym == SDLK_ESCAPE) { run_dismiss(); return; }
    if (sym == SDLK_RETURN) {
        if (run_len > 0) {
            char *argv[4] = { (char *)"sh", (char *)"-c", run_buf, 0 };
            spawn_path("/bin/sh", argv);
        }
        run_dismiss();
        return;
    }
    if (sym == SDLK_BACKSPACE) {
        if (run_len > 0) run_buf[--run_len] = 0;
        return;
    }
    if (sym >= 32 && sym < 127 && run_len < RUN_MAX) {
        run_buf[run_len++] = (char)sym;
        run_buf[run_len] = 0;
    }
}

static void draw_run(void) {
    if (!run_win) return;
    uint32_t *px = (uint32_t *)run_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0);
    fill_s(px, RUN_W, RUN_H, 0, 0, RUN_W, RUN_H, face);
    fill_s(px, RUN_W, RUN_H, 0, 0, RUN_W, 1, hi);       /* raised edge */
    fill_s(px, RUN_W, RUN_H, 0, 0, 1, RUN_H, hi);
    fill_s(px, RUN_W, RUN_H, 0, RUN_H - 1, RUN_W, 1, sh);
    fill_s(px, RUN_W, RUN_H, RUN_W - 1, 0, 1, RUN_H, sh);
    draw_text_s(px, RUN_W, RUN_H, 8, 10, "RUN", txt);
    /* Sunken white input box: dark top/left. */
    fill_s(px, RUN_W, RUN_H, 8, 26, RUN_W - 16, 22, hi);
    fill_s(px, RUN_W, RUN_H, 8, 26, RUN_W - 16, 1, sh);
    fill_s(px, RUN_W, RUN_H, 8, 26, 1, 22, sh);
    /* The tail of the input that fits, plus a block caret. */
    int maxn = (RUN_W - 16 - 12 - 6) / 6;
    const char *s = run_len > maxn ? run_buf + (run_len - maxn) : run_buf;
    draw_text_s(px, RUN_W, RUN_H, 12, 33, s, txt);
    fill_s(px, RUN_W, RUN_H, 12 + (int)strlen(s) * 6, 32, 2, 10, txt);
    SDL_UpdateWindowSurface(run_win);
}

/* ---- the Start menu columns (todos/0078) ---- */

/* Row bookkeeping: the root column appends the fixed section (SETTINGS,
 * RUN...) after a separator groove; flyout columns are pure entries. */
static int col_rows(const menu_col *c, int depth) {
    return c->n + (depth == 0 ? MENU_FIXED : 0);
}

static int menu_row_y(const menu_col *c, int depth, int i) {
    int y = MENU_PAD + i * MENU_ENTRY_H;
    if (depth == 0 && i >= c->n) y += MENU_SEP_H;
    return y;
}

/* Row under local y, or -1 (padding / the separator groove). */
static int menu_row_hit(const menu_col *c, int depth, int y) {
    int base = y - MENU_PAD;
    if (base < 0) return -1;
    int i = base / MENU_ENTRY_H;
    if (depth == 0 && base >= c->n * MENU_ENTRY_H) {
        if (base < c->n * MENU_ENTRY_H + MENU_SEP_H) return -1;
        i = c->n + (base - c->n * MENU_ENTRY_H - MENU_SEP_H) / MENU_ENTRY_H;
    }
    return i < col_rows(c, depth) ? i : -1;
}

/* Close columns depth.. (deepest first). Flyouts never hold kernel focus
 * (see the EV_CREATED hand-back), so this can't bounce focus to an app. */
static void menu_close_from(int depth) {
    for (int d = mdepth - 1; d >= depth; d--) {
        if (mcol[d].win) SDL_DestroyWindow(mcol[d].win);
        mcol[d].win = NULL;
        mcol[d].surf = NULL;
        mcol[d].sid = 0;
    }
    if (mdepth > depth) mdepth = depth;
    if (depth > 0) mcol[depth - 1].open_child = -1;
}

static void menu_dismiss(void) { menu_close_from(0); }

/* Open the column at `depth` listing `dir`. Root parks bottom-left above
 * the taskbar; flyouts park at (px, py) clamped on-screen. The window
 * parks when its EV_CREATED echo arrives (title "startmenu" for the root,
 * "startmenu<depth+1>" deeper — see handle_event). Returns 1 if live. */
static int menu_open_col(int depth, const char *dir, int px, int py) {
    if (depth >= MENU_DEPTH) return 0;
    menu_col *c = &mcol[depth];
    c->n = load_entries(dir, c->ents, MAX_MENU);
    if (depth > 0 && c->n == 0) return 0;      /* an empty group: nothing */
    snprintf(c->dir, sizeof c->dir, "%s", dir);
    c->hover = -1;
    c->open_child = -1;
    c->w = (depth == 0 ? MENU_BAND_W : 0) + MENU_W;
    c->h = 2 * MENU_PAD + col_rows(c, depth) * MENU_ENTRY_H +
           (depth == 0 ? MENU_SEP_H : 0);
    if (depth == 0) {
        c->x = 0;
        c->y = scr_h - BAR_H - c->h;
    } else {
        c->x = px;
        c->y = py;
        if (c->x + c->w > scr_w) c->x = scr_w - c->w;
        if (c->y + c->h > scr_h - BAR_H) c->y = scr_h - BAR_H - c->h;
        if (c->y < 0) c->y = 0;
    }
    char title[16];
    if (depth == 0) strcpy(title, "startmenu");
    else snprintf(title, sizeof title, "startmenu%d", depth + 1);
    c->win = SDL_CreateWindow(title, c->w, c->h, SDL_WINDOW_BORDERLESS);
    if (!c->win) return 0;
    c->surf = SDL_GetWindowSurface(c->win);
    c->sid = 0;
    mdepth = depth + 1;
    return 1;
}

/* Cascade the flyout for group row i of column `depth` open, replacing
 * any open sibling flyout. The first flyout row aligns with the group
 * row's text (Win95), clamped to the work area. */
static void menu_open_flyout(int depth, int i) {
    menu_col *c = &mcol[depth];
    if (depth + 1 >= MENU_DEPTH) return;
    if (c->open_child == i && depth + 1 < mdepth) return;   /* already up */
    menu_close_from(depth + 1);
    char path[600];
    snprintf(path, sizeof path, "%s/%s", c->dir, c->ents[i].name);
    if (menu_open_col(depth + 1, path,
                      c->x + c->w - 3,
                      c->y + menu_row_y(c, depth, i) - MENU_PAD))
        c->open_child = i;
}

/* Activate row i of column `depth`: groups cascade, the fixed section
 * runs its builtin, everything else is the shared activate() (todos/0066)
 * — a menu entry is a symlink or an executable launcher script; a stray
 * non-runnable file just opens through its association. */
static void menu_row_activate(int depth, int i) {
    menu_col *c = &mcol[depth];
    if (i < 0 || i >= col_rows(c, depth)) return;
    if (depth == 0 && i >= c->n) {             /* the fixed section (0078) */
        int j = i - c->n;
        menu_dismiss();
        if (j == 0) activate("/bin/ctlpanel"); /* SETTINGS */
        else run_open();                       /* RUN... */
        return;
    }
    if (c->ents[i].is_dir) { menu_open_flyout(depth, i); return; }
    char path[600];
    snprintf(path, sizeof path, "%s/%s", c->dir, c->ents[i].name);
    activate(path);
    menu_dismiss();
}

/* Toggle from the Start button, the Ctrl+Esc chord, or `wmctl menu` (all
 * ride EV_MENU or call here directly). /etc/menu wins if the DIRECTORY
 * exists (even empty — first-existing-dir, no union merge; todos/0040);
 * the baked /usr/share/menu is the default. The fixed section keeps the
 * menu useful even over an empty programs list. */
static void menu_toggle(void) {
    ctx_dismiss();                     /* one popup at a time (todos/0091) */
    if (mdepth > 0) { menu_dismiss(); return; }
    DIR *d = opendir("/etc/menu");
    if (d) { closedir(d); strcpy(menu_dir, "/etc/menu"); }
    else strcpy(menu_dir, "/usr/share/menu");
    menu_open_col(0, menu_dir, 0, 0);
}

static int menu_col_for(SDL_WindowID id) {
    for (int d = 0; d < mdepth; d++)
        if (mcol[d].win && SDL_GetWindowID(mcol[d].win) == id) return d;
    return -1;
}

static int menu_owns_sid(int32_t sid) {
    for (int d = 0; d < mdepth; d++) if (mcol[d].sid == sid) return 1;
    return 0;
}

static void menu_click(int depth, float fy) {
    int i = menu_row_hit(&mcol[depth], depth, (int)fy);
    if (i < 0) { menu_dismiss(); return; }     /* a dead-zone click */
    mcol[depth].hover = i;
    menu_row_activate(depth, i);
}

/* Hover-open (0078): a group row cascades its flyout; hovering a
 * DIFFERENT group replaces it. Non-group hovers leave an open flyout
 * alone — forgiving diagonal travel toward the flyout, no timers. */
static void menu_motion(int depth, float fy) {
    menu_col *c = &mcol[depth];
    int i = menu_row_hit(c, depth, (int)fy);
    c->hover = i;
    if (i >= 0 && i < c->n && c->ents[i].is_dir && c->open_child != i)
        menu_open_flyout(depth, i);
}

/* Keyboard navigation (todos/0078): arrows walk the DEEPEST column,
 * Right/Enter cascade into a group, Left backs out one level, Esc closes
 * everything, printable keys type-ahead to the next matching row. The
 * root column holds kernel focus the whole time, so every key while the
 * menu is open lands here regardless of pointer position. */
static void menu_key(int sym) {
    int depth = mdepth - 1;
    menu_col *c = &mcol[depth];
    int rows = col_rows(c, depth);
    if (sym == SDLK_ESCAPE) { menu_dismiss(); return; }
    if (sym == SDLK_DOWN || sym == SDLK_UP) {
        int d = sym == SDLK_DOWN ? 1 : -1;
        c->hover = c->hover < 0 ? (d > 0 ? 0 : rows - 1)
                                : (c->hover + d + rows) % rows;
        return;
    }
    if (sym == SDLK_LEFT) {
        if (depth > 0) menu_close_from(depth);
        return;
    }
    if (sym == SDLK_RIGHT) {
        if (c->hover >= 0 && c->hover < c->n && c->ents[c->hover].is_dir) {
            menu_open_flyout(depth, c->hover);
            if (mdepth > depth + 1) mcol[depth + 1].hover = 0;
        }
        return;
    }
    if (sym == SDLK_RETURN) {
        int was = mdepth;
        menu_row_activate(depth, c->hover);
        if (mdepth > was) mcol[mdepth - 1].hover = 0;   /* entered a group */
        return;
    }
    if (sym >= 32 && sym < 127) {              /* type-ahead */
        char lc = (char)(sym >= 'A' && sym <= 'Z' ? sym + 32 : sym);
        for (int k = 1; k <= rows; k++) {
            int i = (c->hover + k + rows) % rows;      /* hover -1 starts at 0 */
            char f = i < c->n ? c->ents[i].name[0] : menu_fixed[i - c->n][0];
            if (f >= 'A' && f <= 'Z') f = (char)(f + 32);
            if (f == lc) { c->hover = i; break; }
        }
    }
}

static void draw_menu_col(int depth) {
    menu_col *c = &mcol[depth];
    if (!c->win) return;
    int w = c->w, h = c->h;
    int x0 = depth == 0 ? MENU_BAND_W : 0;
    uint32_t *px = (uint32_t *)c->surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0),
             sel = rgb(0, 0, 128), seltxt = rgb(255, 255, 255);
    fill_s(px, w, h, 0, 0, w, h, face);
    /* Win95 raised edge: light top/left, dark bottom/right. */
    fill_s(px, w, h, 0, 0, w, 1, hi);
    fill_s(px, w, h, 0, 0, 1, h, hi);
    fill_s(px, w, h, 0, h - 1, w, 1, sh);
    fill_s(px, w, h, w - 1, 0, 1, h, sh);
    if (depth == 0) {
        /* The Win95 sidebar band: navy strip, bottom-up label (0078). */
        fill_s(px, w, h, 1, 1, MENU_BAND_W - 1, h - 2, sel);
        draw_vtext_s(px, w, h, 5, h - 8, "WASM OS", seltxt);
    }
    int rows = col_rows(c, depth);
    for (int i = 0; i < rows; i++) {
        int y = menu_row_y(c, depth, i);
        int hl = i == c->hover || (i < c->n && i == c->open_child);
        if (hl) fill_s(px, w, h, x0 + 2, y, w - x0 - 4, MENU_ENTRY_H, sel);
        const char *name = i < c->n ? c->ents[i].name : menu_fixed[i - c->n];
        draw_text_s(px, w, h, x0 + 10, y + (MENU_ENTRY_H - 7) / 2, name,
                    hl ? seltxt : txt);
        if (i < c->n && c->ents[i].is_dir) {   /* the flyout arrow */
            int ax = w - 10, ay = y + (MENU_ENTRY_H - 7) / 2;
            for (int t = 0; t < 4; t++)
                fill_s(px, w, h, ax + t, ay + t, 1, 7 - 2 * t,
                       hl ? seltxt : txt);
        }
    }
    if (depth == 0) {                          /* the separator groove */
        int sy = MENU_PAD + c->n * MENU_ENTRY_H + MENU_SEP_H / 2 - 1;
        fill_s(px, w, h, x0 + 4, sy, w - x0 - 8, 1, sh);
        fill_s(px, w, h, x0 + 4, sy + 1, w - x0 - 8, 1, hi);
    }
    SDL_UpdateWindowSurface(c->win);
}

/* ---- the desktop layer (todos/0029; selection & drag todos/0077) ---- */

/* Icons flow down the left edge, column-major (Win95), clear of the
 * taskbar strip. */
static int desk_per_col(void) {
    int rows = (scr_h - BAR_H - 2 * DESK_MARGIN) / CELL_H;
    return rows < 1 ? 1 : rows;
}

static int desk_cols(void) {
    int cols = (scr_w - DESK_MARGIN) / CELL_W;
    return cols < 1 ? 1 : cols;
}

/* Resolve entry cells (todos/0077): saved positions from .icons win when
 * they exist, are in bounds for the CURRENT grid, and don't collide;
 * everything else auto-flows column-major into the free cells — with no
 * .icons file this reproduces the 0029 layout exactly. Display-only: an
 * out-of-bounds saved cell (transient small screen) falls back to
 * auto-flow without rewriting the file. */
static void desk_place(const menu_ent *ents, int n, int *col, int *row) {
    int rows = desk_per_col(), cols = desk_cols();
    uint8_t used[4096];
    int cap = cols * rows;
    if (cap > (int)sizeof used) cap = (int)sizeof used;
    memset(used, 0, (size_t)cap);
    for (int i = 0; i < n; i++) col[i] = -1;
    FILE *f = fopen("/root/Desktop/.icons", "r");
    if (f) {
        char line[320];
        while (fgets(line, sizeof line, f)) {
            int c, r, off = -1;
            if (sscanf(line, "%d %d %n", &c, &r, &off) < 2 || off < 0) continue;
            char *name = line + off;
            size_t l = strlen(name);
            while (l > 0 && (name[l - 1] == '\n' || name[l - 1] == '\r')) name[--l] = 0;
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
            if (c * rows + r >= cap || used[c * rows + r]) continue;
            for (int i = 0; i < n; i++)
                if (col[i] < 0 && strcmp(ents[i].name, name) == 0) {
                    col[i] = c; row[i] = r;
                    used[c * rows + r] = 1;
                    break;
                }
        }
        fclose(f);
    }
    int k = 0;
    for (int i = 0; i < n; i++) {
        if (col[i] >= 0) continue;
        while (k < cap && used[k]) k++;
        if (k >= cap) { col[i] = 0; row[i] = 0; continue; }   /* grid full: pile */
        col[i] = k / rows; row[i] = k % rows;
        used[k++] = 1;
    }
}

/* Persist the whole layout (todos/0077): every current entry gets a line,
 * pinning the on-screen arrangement; files added later still auto-flow
 * (they're not in the file). Stale lines for removed files just stop
 * matching. Rewritten only on an actual drag-drop. */
static void desk_save(void) {
    FILE *f = fopen("/root/Desktop/.icons", "w");
    if (!f) return;
    for (int i = 0; i < desk_n; i++)
        fprintf(f, "%d %d %s\n", desk_col[i], desk_row[i], desk[i].name);
    fclose(f);
}

static void desk_load(void) {
    if (desk_press) return;            /* never reshuffle under a drag (0077) */
    menu_ent fresh[MAX_DESK];
    int fcol[MAX_DESK], frow[MAX_DESK];
    int n = load_entries("/root/Desktop", fresh, MAX_DESK);
    desk_place(fresh, n, fcol, frow);
    if (n == desk_n && memcmp(fresh, desk, (size_t)n * sizeof fresh[0]) == 0 &&
        memcmp(fcol, desk_col, (size_t)n * sizeof fcol[0]) == 0 &&
        memcmp(frow, desk_row, (size_t)n * sizeof frow[0]) == 0) return;
    memcpy(desk, fresh, (size_t)n * sizeof fresh[0]);
    memcpy(desk_col, fcol, (size_t)n * sizeof fcol[0]);
    memcpy(desk_row, frow, (size_t)n * sizeof frow[0]);
    desk_n = n;
    /* The entry set (or layout) changed under us: selection indexes are
     * stale — clear rather than mis-highlight (todos/0077). Our own
     * .icons rewrite resolves to the cells already shown, so the memcmp
     * above keeps the selection across the post-drag re-read tick. */
    desk_selmask = 0;
    desk_anchor = -1;
    desk_dirty = 1;
}

/* Fullscreen borderless window; its EV_CREATED echo parks it at (0,0),
 * pins it to the BOTTOM z layer, and gives focus back (see handle_event).
 * The compositor's own background never shows again while the wm lives —
 * which is the point: every "desktop" click is a client click now. */
static int make_desk(void) {
    desk_press = 0;                    /* a recreate drops any drag (0077) */
    desk_drag = 0;
    desk_load();
    desk_win = SDL_CreateWindow("desktop", scr_w, scr_h, SDL_WINDOW_BORDERLESS);
    if (!desk_win) return -1;
    desk_surf = SDL_GetWindowSurface(desk_win);
    desk_dirty = 1;
    return 0;
}

/* Icon under a desktop point, or -1. The whole cell is the click target;
 * cells are per-icon since free placement (todos/0077). */
static int desk_hit(int x, int y) {
    if (x < DESK_MARGIN || y < DESK_MARGIN || y >= scr_h - BAR_H) return -1;
    int col = (x - DESK_MARGIN) / CELL_W;
    int row = (y - DESK_MARGIN) / CELL_H;
    if (row >= desk_per_col()) return -1;
    for (int i = 0; i < desk_n; i++)
        if (desk_col[i] == col && desk_row[i] == row) return i;
    return -1;
}

/* Double-click: the same activate() the Start menu uses (todos/0066) —
 * runnable files (wasm, #! launchers, links to them) spawn, anything else
 * opens through the openwith associations (todos/0072). */
static void desk_launch(int idx) {
    if (idx < 0 || idx >= desk_n) return;
    char path[300];
    snprintf(path, sizeof path, "/root/Desktop/%s", desk[idx].name);
    activate(path);
}

/* Desktop mousedown (todos/0029 double-click, todos/0077 selection):
 * launch on a quick second click on the SAME icon (own timestamp check —
 * the global SDL click counter accumulates across windows, so it can't
 * be trusted alone; a held modifier suppresses the pair, so ctrl-click
 * ctrl-click toggles twice). Otherwise build the selection set: plain
 * click selects one (a click on an already-selected icon defers to
 * mouseup so a drag can move the whole set), ctrl-click toggles,
 * shift-click ranges from the anchor (entry order — the sorted order,
 * documented), empty-area press clears and arms the marquee. */
static void desk_down(float fx, float fy, uint64_t t) {
    int x = (int)fx, y = (int)fy;
    int idx = desk_hit(x, y);
    if (idx >= 0 && idx == desk_last_idx && !mod_ctrl && !mod_shift &&
        t >= desk_last_ns && t - desk_last_ns <= DBLCLICK_NS) {
        desk_last_idx = -1;            /* a third click starts over */
        desk_launch(idx);
        return;
    }
    desk_last_idx = idx;
    desk_last_ns = t;
    desk_press = 1;
    desk_press_idx = idx;
    desk_press_x = desk_cur_x = x;
    desk_press_y = desk_cur_y = y;
    desk_drag = 0;
    desk_collapse = 0;
    if (idx < 0) {
        if (!mod_ctrl && !mod_shift && desk_selmask) {
            desk_selmask = 0;
            desk_anchor = -1;
            desk_dirty = 1;
        }
        return;                        /* marquee arms past DRAG_SLOP */
    }
    uint64_t bit = 1ULL << idx;
    if (mod_ctrl) {
        desk_selmask ^= bit;
        desk_anchor = (desk_selmask & bit) ? idx : -1;
    } else if (mod_shift) {
        int a = desk_anchor >= 0 ? desk_anchor : idx;
        int lo = a < idx ? a : idx, hi = a < idx ? idx : a;
        desk_selmask = 0;
        for (int i = lo; i <= hi; i++) desk_selmask |= 1ULL << i;
        desk_anchor = a;
    } else if (!(desk_selmask & bit)) {
        desk_selmask = bit;
        desk_anchor = idx;
    } else {
        desk_collapse = 1;             /* collapse on a drag-less mouseup */
        desk_anchor = idx;
    }
    desk_dirty = 1;
}

/* Button-held travel past DRAG_SLOP turns the press into a marquee (from
 * empty desktop) or an icon move (from an icon). Motion with the button
 * bit CLEAR means the mouseup happened off this surface (the kernel
 * hit-tests per event — no capture): finish at the last point. */
static void desk_up(float fx, float fy);
static void desk_motion(float fx, float fy, uint32_t state) {
    if (!desk_press) return;
    if (!(state & 1)) { desk_up(fx, fy); return; }
    desk_cur_x = (int)fx;
    desk_cur_y = (int)fy;
    if (!desk_drag) {
        int dx = desk_cur_x - desk_press_x, dy = desk_cur_y - desk_press_y;
        if (dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return;
        desk_drag = desk_press_idx < 0 ? 1 : 2;
        if (desk_drag == 2)            /* a ctrl-toggle-off then drag still
                                          moves the pressed icon */
            desk_selmask |= 1ULL << desk_press_idx;
        desk_collapse = 0;
    }
    desk_dirty = 1;
}

/* Release: marquee intersects icon TILES into the set (ctrl adds, plain
 * replaces); an icon drag moves the whole selected set by the snapped
 * CELL delta — all-or-nothing (any target out of bounds or occupied by an
 * unselected icon reverts the whole move, so a drop never overlaps or
 * silently reflows) — and persists the layout; a drag-less release on an
 * already-selected icon collapses the set to it (the Win95 rule). */
static void desk_up(float fx, float fy) {
    if (!desk_press) return;
    desk_press = 0;
    int x = (int)fx, y = (int)fy;
    if (desk_drag == 1) {
        int x0 = x < desk_press_x ? x : desk_press_x;
        int x1 = x < desk_press_x ? desk_press_x : x;
        int y0 = y < desk_press_y ? y : desk_press_y;
        int y1 = y < desk_press_y ? desk_press_y : y;
        uint64_t m = 0;
        for (int i = 0; i < desk_n; i++) {
            int ix = DESK_MARGIN + desk_col[i] * CELL_W + (CELL_W - ICON_W) / 2;
            int iy = DESK_MARGIN + desk_row[i] * CELL_H + 6;
            if (x0 < ix + ICON_W && x1 > ix && y0 < iy + ICON_W && y1 > iy)
                m |= 1ULL << i;
        }
        desk_selmask = mod_ctrl ? desk_selmask | m : m;
        desk_anchor = -1;
        for (int i = 0; i < desk_n; i++)
            if (desk_selmask >> i & 1) { desk_anchor = i; break; }
    } else if (desk_drag == 2) {
        float fdc = (float)(x - desk_press_x) / CELL_W;
        float fdr = (float)(y - desk_press_y) / CELL_H;
        int dc = (int)(fdc + (fdc >= 0 ? 0.5f : -0.5f));
        int dr = (int)(fdr + (fdr >= 0 ? 0.5f : -0.5f));
        if (dc != 0 || dr != 0) {
            int rows = desk_per_col(), cols = desk_cols(), ok = 1;
            for (int i = 0; i < desk_n && ok; i++) {
                if (!(desk_selmask >> i & 1)) continue;
                int nc = desk_col[i] + dc, nr = desk_row[i] + dr;
                if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) { ok = 0; break; }
                for (int j = 0; j < desk_n; j++)
                    if (!(desk_selmask >> j & 1) &&
                        desk_col[j] == nc && desk_row[j] == nr) { ok = 0; break; }
            }
            if (ok) {
                for (int i = 0; i < desk_n; i++)
                    if (desk_selmask >> i & 1) {
                        desk_col[i] += dc;
                        desk_row[i] += dr;
                    }
                desk_save();
            }
        }
    } else if (desk_collapse && desk_press_idx >= 0) {
        desk_selmask = 1ULL << desk_press_idx;
        desk_anchor = desk_press_idx;
    }
    desk_drag = 0;
    desk_collapse = 0;
    desk_dirty = 1;
}

/* Keyboard on the focused desktop (todos/0077): arrows walk the grid
 * (nearest icon in the pressed direction — least perpendicular offset,
 * then least forward distance), Enter launches an unambiguous SINGLE
 * selection (Enter on a multi-selection is a deliberate no-op: never
 * silently spawn N windows — the multi-launch guard), Esc clears,
 * Ctrl+A selects all. */
static void desk_arrow(int dx, int dy) {
    if (desk_n == 0) return;
    int cur = desk_anchor, best = -1, bp = 0, bs = 0;
    if (cur < 0 || !(desk_selmask >> cur & 1)) {
        for (int i = 0; i < desk_n; i++)       /* nothing current: top-left */
            if (best < 0 || desk_col[i] < desk_col[best] ||
                (desk_col[i] == desk_col[best] && desk_row[i] < desk_row[best]))
                best = i;
    } else {
        for (int i = 0; i < desk_n; i++) {
            if (i == cur) continue;
            int pc = (desk_col[i] - desk_col[cur]) * dx +
                     (desk_row[i] - desk_row[cur]) * dy;
            int sc = (desk_col[i] - desk_col[cur]) * dy +
                     (desk_row[i] - desk_row[cur]) * dx;
            if (sc < 0) sc = -sc;
            if (pc <= 0) continue;
            if (best < 0 || sc < bs || (sc == bs && pc < bp)) {
                best = i; bp = pc; bs = sc;
            }
        }
        if (best < 0) return;          /* nothing that way: stay put */
    }
    desk_selmask = 1ULL << best;
    desk_anchor = best;
    desk_dirty = 1;
}

static void desk_key(int sym) {
    if (sym == SDLK_ESCAPE) {
        if (desk_selmask) { desk_selmask = 0; desk_anchor = -1; desk_dirty = 1; }
        return;
    }
    if (sym == SDLK_RETURN) {
        if (desk_selmask && !(desk_selmask & (desk_selmask - 1))) {
            int i = 0;
            while (!(desk_selmask >> i & 1)) i++;
            desk_launch(i);
        }
        return;
    }
    if (mod_ctrl && (sym == 'a' || sym == 'A')) {
        desk_selmask = desk_n >= 64 ? ~0ULL : (1ULL << desk_n) - 1;
        if (desk_n > 0 && desk_anchor < 0) desk_anchor = 0;
        desk_dirty = 1;
        return;
    }
    if (sym == SDLK_LEFT) desk_arrow(-1, 0);
    else if (sym == SDLK_RIGHT) desk_arrow(1, 0);
    else if (sym == SDLK_UP) desk_arrow(0, -1);
    else if (sym == SDLK_DOWN) desk_arrow(0, 1);
}

/* 1px outline (marquee + drag ghosts, todos/0077). */
static void rect_s(uint32_t *px, int sw, int sh, int x, int y, int w, int h,
                   uint32_t col) {
    fill_s(px, sw, sh, x, y, w, 1, col);
    fill_s(px, sw, sh, x, y + h - 1, w, 1, col);
    fill_s(px, sw, sh, x, y, 1, h, col);
    fill_s(px, sw, sh, x + w - 1, y, 1, h, col);
}

static void draw_desk(void) {
    if (!desk_win || !desk_dirty) return;
    desk_dirty = 0;
    int w = scr_w, h = scr_h;
    uint32_t *px = (uint32_t *)desk_surf->pixels;
    uint32_t teal = rgb(0, 128, 128), white = rgb(255, 255, 255),
             navy = rgb(0, 0, 128), black = rgb(0, 0, 0);
    fill_s(px, w, h, 0, 0, w, h, teal);
    for (int i = 0; i < desk_n; i++) {
        int cx = DESK_MARGIN + desk_col[i] * CELL_W;
        int cy = DESK_MARGIN + desk_row[i] * CELL_H;
        int ix = cx + (CELL_W - ICON_W) / 2, iy = cy + 6;
        /* Flat-rect glyph: white tile, navy center block; links get a
         * black launcher notch at the bottom-left (the Win95 arrow). */
        fill_s(px, w, h, ix, iy, ICON_W, ICON_W, white);
        fill_s(px, w, h, ix + 6, iy + 6, ICON_W - 12, ICON_W - 12, navy);
        if (desk[i].is_link)
            fill_s(px, w, h, ix + 2, iy + ICON_W - 8, 6, 6, black);
        int len = (int)strlen(desk[i].name);
        if (len > 13) len = 13;
        int lx = cx + (CELL_W - len * 6) / 2, ly = cy + ICON_W + 10;
        /* Selection highlight: the 0029 navy label strip, per-set (0077). */
        if (desk_selmask >> i & 1)
            fill_s(px, w, h, lx - 2, ly - 2, len * 6 + 3, 11, navy);
        char label[14];
        memcpy(label, desk[i].name, (size_t)len);
        label[len] = 0;
        draw_text_s(px, w, h, lx, ly, label, white);
    }
    if (desk_drag == 1) {              /* the marquee rubber-band (0077) */
        int x0 = desk_cur_x < desk_press_x ? desk_cur_x : desk_press_x;
        int y0 = desk_cur_y < desk_press_y ? desk_cur_y : desk_press_y;
        int rw = desk_cur_x - desk_press_x, rh = desk_cur_y - desk_press_y;
        if (rw < 0) rw = -rw;
        if (rh < 0) rh = -rh;
        rect_s(px, w, h, x0, y0, rw + 1, rh + 1, white);
    } else if (desk_drag == 2) {       /* drop ghosts: cell outlines (0077) */
        int pdx = desk_cur_x - desk_press_x, pdy = desk_cur_y - desk_press_y;
        for (int i = 0; i < desk_n; i++)
            if (desk_selmask >> i & 1)
                rect_s(px, w, h, DESK_MARGIN + desk_col[i] * CELL_W + pdx,
                       DESK_MARGIN + desk_row[i] * CELL_H + pdy,
                       CELL_W, CELL_H, white);
    }
    SDL_UpdateWindowSurface(desk_win);
}

/* ---- context menus (todos/0091) ---- */

static void ctx_close_flyout(void) {
    if (ctx_depth < 2) return;
    if (ctx_win[1]) SDL_DestroyWindow(ctx_win[1]);
    ctx_win[1] = NULL;
    ctx_surf[1] = NULL;
    ctx_sid[1] = 0;
    ctx_depth = 1;
    ctx_child = -1;
}

static void ctx_dismiss(void) {
    ctx_close_flyout();
    if (ctx_depth < 1) return;
    if (ctx_win[0]) SDL_DestroyWindow(ctx_win[0]);
    ctx_win[0] = NULL;
    ctx_surf[0] = NULL;
    ctx_sid[0] = 0;
    ctx_depth = 0;
    ctx_target = 0;
    ctx_icon = -1;
}

static void ctx_add(int d, const char *label, int id, int flags) {
    if (ctx_nent[d] >= CTX_MAX) return;
    ctx_ents[d][ctx_nent[d]].label = label;
    ctx_ents[d][ctx_nent[d]].id = id;
    ctx_ents[d][ctx_nent[d]].flags = flags;
    ctx_nent[d]++;
}

static int ctx_row_y(int d, int i) {
    int y = MENU_PAD;
    for (int k = 0; k < i; k++)
        y += (ctx_ents[d][k].flags & CTF_SEP) ? MENU_SEP_H : MENU_ENTRY_H;
    return y;
}

/* Row under local y, or -1 (padding / a separator). */
static int ctx_row_hit(int d, int y) {
    int ry = MENU_PAD;
    for (int i = 0; i < ctx_nent[d]; i++) {
        int rh = (ctx_ents[d][i].flags & CTF_SEP) ? MENU_SEP_H : MENU_ENTRY_H;
        if (y >= ry && y < ry + rh)
            return (ctx_ents[d][i].flags & CTF_SEP) ? -1 : i;
        ry += rh;
    }
    return -1;
}

/* Create the popup window for depth d anchored at (px, py), clamped to
 * the work area (a py past the bottom — the taskbar anchor — lands the
 * menu exactly above the bar). Parks at its EV_CREATED echo. */
static int ctx_openwin(int d, int px, int py) {
    int h = 2 * MENU_PAD;
    for (int i = 0; i < ctx_nent[d]; i++)
        h += (ctx_ents[d][i].flags & CTF_SEP) ? MENU_SEP_H : MENU_ENTRY_H;
    ctx_h[d] = h;
    ctx_x[d] = px;
    ctx_y[d] = py;
    if (ctx_x[d] + CTX_W > scr_w) ctx_x[d] = scr_w - CTX_W;
    if (ctx_x[d] < 0) ctx_x[d] = 0;
    if (ctx_y[d] + h > scr_h - BAR_H) ctx_y[d] = scr_h - BAR_H - h;
    if (ctx_y[d] < 0) ctx_y[d] = 0;
    ctx_hover[d] = -1;
    ctx_win[d] = SDL_CreateWindow(d ? "ctxmenu2" : "ctxmenu", CTX_W, h,
                                  SDL_WINDOW_BORDERLESS);
    if (!ctx_win[d]) return -1;
    ctx_surf[d] = SDL_GetWindowSurface(ctx_win[d]);
    ctx_sid[d] = 0;
    ctx_depth = d + 1;
    return 0;
}

/* Cascade the flyout for root row i (NEW / SORT BY), replacing any open
 * one. First row aligns with the group row, the Start-menu convention. */
static void ctx_open_flyout(int i) {
    if (ctx_child == i && ctx_depth > 1) return;   /* already up */
    ctx_close_flyout();
    ctx_nent[1] = 0;
    if (ctx_ents[0][i].id == CM_SUB_NEW) {
        ctx_add(1, "FOLDER", CM_NEW_FOLDER, 0);
        ctx_add(1, "TEXT FILE", CM_NEW_FILE, 0);
    } else if (ctx_ents[0][i].id == CM_SUB_SORT) {
        ctx_add(1, "NAME", CM_SORT_NAME, 0);
    } else return;
    if (ctx_openwin(1, ctx_x[0] + CTX_W - 3,
                    ctx_y[0] + ctx_row_y(0, i) - MENU_PAD) == 0)
        ctx_child = i;
}

/* Right-click empty desktop (Win95): New >, Sort by >, Refresh, then the
 * Display Properties shortcut into the Control Panel applet (0089). */
static void ctx_open_desktop(int x, int y) {
    ctx_dismiss();
    ctx_nent[0] = 0;
    ctx_add(0, "NEW", CM_SUB_NEW, CTF_SUB);
    ctx_add(0, "SORT BY", CM_SUB_SORT, CTF_SUB);
    ctx_add(0, "REFRESH", CM_REFRESH, 0);
    ctx_add(0, "PASTE", CM_PASTE, fo_clip_has() ? 0 : CTF_GRAY);   /* 0092 */
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "DISPLAY", CM_DISPLAY, 0);
    ctx_openwin(0, x, y);
}

/* Right-click a desktop icon: Open + Cut/Copy of the selection set
 * (todos/0092 — the same format-2 clipboard file list fileman pastes;
 * Delete arrives with the Recycle Bin, 0093, Rename with 0103). */
static void ctx_open_icon(int idx, int x, int y) {
    ctx_dismiss();
    ctx_icon = idx;
    ctx_nent[0] = 0;
    ctx_add(0, "OPEN", CM_OPEN, 0);
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "CUT", CM_CUT, 0);
    ctx_add(0, "COPY", CM_COPY, 0);
    ctx_openwin(0, x, y);
}

/* Cut/Copy every selected icon's path onto the clipboard (fileops.h
 * format-2 file list over the ONE kernel slot, todos/0090 — fileman and
 * other wm instances paste it). */
static void desk_clip(int cut) {
    static char bufs[MAX_DESK][300];   /* off the 64KB wasm stack */
    const char *paths[MAX_DESK];
    int n = 0;
    for (int i = 0; i < desk_n && i < MAX_DESK; i++) {
        if (!(desk_selmask >> i & 1)) continue;
        snprintf(bufs[n], sizeof bufs[n], "/root/Desktop/%s", desk[i].name);
        paths[n] = bufs[n];
        n++;
    }
    if (n && fo_clip_set(cut, paths, n) != 0)
        fprintf(stderr, "wm: clipboard set failed: %s\n", strerror(errno));
}

/* Paste the clipboard file list onto the desktop: cut moves (slot
 * cleared after a clean run — a cut pastes once), copy duplicates with
 * the "Copy of" clash uniquifier. Errors go to the service log — this
 * process has no dialog furniture (fileman surfaces them, 0092). */
static void desk_paste(void) {
    static char cl[FO_CLIP_MAX];
    int cut = 0;
    int n = fo_clip_load(cl, sizeof cl, &cut);
    int ok = 1;
    for (int i = 0; i < n; i++) {
        const char *src = fo_clip_path(cl, i);
        const char *base = strrchr(src, '/');
        base = base ? base + 1 : src;
        char dst[FO_PATH_MAX];
        int rc;
        if (cut) {
            snprintf(dst, sizeof dst, "/root/Desktop/%s", base);
            rc = fo_move(src, dst);
        } else {
            rc = fo_paste_dest("/root/Desktop", base, dst, sizeof dst);
            if (rc == 0) rc = fo_copy(src, dst);
        }
        if (rc != 0) {
            fprintf(stderr, "wm: paste '%s' failed: %s\n", src, strerror(errno));
            ok = 0;
            break;
        }
    }
    if (n > 0 && cut && ok) fo_clip_clear();
    desk_load();
    desk_dirty = 1;
}

/* Right-click a taskbar button: the Win95 window menu over the chrome ops
 * this process already owns. Inapplicable rows gray (state snapshot at
 * open — the popup is transient by design). */
static void ctx_open_bar(const win_t *w, int bx) {
    ctx_dismiss();
    ctx_target = w->sid;
    ctx_nent[0] = 0;
    ctx_add(0, "RESTORE", CM_RESTORE,
            (w->minimized || w->maximized) ? 0 : CTF_GRAY);
    ctx_add(0, "MINIMIZE", CM_MINIMIZE, w->minimized ? CTF_GRAY : 0);
    ctx_add(0, "MAXIMIZE", CM_MAXIMIZE,
            (w->maximized || w->minimized) ? CTF_GRAY : 0);
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "CLOSE", CM_CLOSE, 0);
    ctx_openwin(0, bx, scr_h);         /* clamp parks it above the bar */
}

/* New > Folder / Text File: create under /root/Desktop with a Win95-style
 * uniquifier ("New Folder", "New Folder 2", ...); the reload puts the icon
 * up without waiting for the coarse desk_tick. */
static void ctx_new_entry(int is_dir) {
    char path[300];
    for (int k = 1; k <= 99; k++) {
        if (k == 1)
            snprintf(path, sizeof path, "/root/Desktop/%s",
                     is_dir ? "New Folder" : "New File.txt");
        else if (is_dir)
            snprintf(path, sizeof path, "/root/Desktop/New Folder %d", k);
        else
            snprintf(path, sizeof path, "/root/Desktop/New File %d.txt", k);
        struct stat st;
        if (lstat(path, &st) == 0) continue;     /* taken: next suffix */
        if (is_dir) mkdir(path, 0755);
        else {
            FILE *f = fopen(path, "w");
            if (f) fclose(f);
        }
        break;
    }
    desk_load();
    desk_dirty = 1;
}

/* Fire row i of column d. Grayed/separator rows never fire; sub rows
 * cascade. Real commands snapshot their argument, dismiss, then act —
 * dismissal first so a spawned child's create-focus finds no popup. */
static void ctx_activate(int d, int i) {
    if (i < 0 || i >= ctx_nent[d]) return;
    ctx_ent *e = &ctx_ents[d][i];
    if (e->flags & (CTF_SEP | CTF_GRAY)) return;
    if (e->flags & CTF_SUB) { ctx_open_flyout(i); return; }
    int id = e->id;
    int32_t target = ctx_target;
    int icon = ctx_icon;
    ctx_dismiss();
    switch (id) {
    case CM_REFRESH:
        desk_load();
        desk_dirty = 1;
        break;
    case CM_SORT_NAME:                 /* forget placements: auto-flow is
                                          the sorted 0029 layout */
        unlink("/root/Desktop/.icons");
        desk_load();
        desk_dirty = 1;
        break;
    case CM_NEW_FOLDER: ctx_new_entry(1); break;
    case CM_NEW_FILE: ctx_new_entry(0); break;
    case CM_DISPLAY: {
        char *argv[3] = { (char *)"ctlpanel", (char *)"Display", 0 };
        spawn_path("/bin/ctlpanel", argv);
        break;
    }
    case CM_OPEN: desk_launch(icon); break;
    case CM_CUT: desk_clip(1); break;            /* 0092 */
    case CM_COPY: desk_clip(0); break;
    case CM_PASTE: desk_paste(); break;
    case CM_RESTORE: {
        win_t *w = find(target);
        if (!w) break;
        if (w->minimized) {            /* focus restores (the 0014 rule) */
            int32_t a[1] = { target };
            wmp_send(sock, WMP_FOCUS, a, 1);
        } else if (w->maximized) title_activate(target);
        break;
    }
    case CM_MINIMIZE: {
        int32_t a[1] = { target };
        wmp_send(sock, WMP_MINIMIZE, a, 1);
        break;
    }
    case CM_MAXIMIZE:
        if (find(target)) title_activate(target);
        break;
    case CM_CLOSE: {                   /* request-close, like the 'x' box */
        int32_t a[1] = { target };
        wmp_send(sock, WMP_CLOSE_REQ, a, 1);
        break;
    }
    }
}

static void ctx_click(int d, float fy) {
    int i = ctx_row_hit(d, (int)fy);
    if (i < 0) { ctx_dismiss(); return; }        /* dead-zone click */
    if (ctx_ents[d][i].flags & CTF_GRAY) return; /* disabled: stays open */
    ctx_hover[d] = i;
    ctx_activate(d, i);
}

/* Hover-open like the Start menu (0078): a sub row cascades its flyout,
 * a different sub row replaces it, plain rows leave it alone. */
static void ctx_motion(int d, float fy) {
    int i = ctx_row_hit(d, (int)fy);
    ctx_hover[d] = i;
    if (d == 0 && i >= 0 && (ctx_ents[0][i].flags & CTF_SUB) &&
        ctx_child != i)
        ctx_open_flyout(i);
}

/* Keyboard on the open context menu: arrows walk enabled rows of the
 * DEEPEST column, Right/Enter cascade a sub row, Left backs out of the
 * flyout, Esc dismisses — the menu_key pattern (0078). */
static void ctx_key(int sym) {
    int d = ctx_depth - 1;
    int n = ctx_nent[d];
    if (sym == SDLK_ESCAPE) { ctx_dismiss(); return; }
    if (sym == SDLK_DOWN || sym == SDLK_UP) {
        int dir = sym == SDLK_DOWN ? 1 : -1;
        int i = ctx_hover[d];
        for (int k = 0; k < n; k++) {
            i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
            if (!(ctx_ents[d][i].flags & CTF_SEP)) break;
        }
        ctx_hover[d] = i;
        return;
    }
    if (sym == SDLK_RIGHT) {
        if (d == 0 && ctx_hover[0] >= 0 &&
            (ctx_ents[0][ctx_hover[0]].flags & CTF_SUB)) {
            ctx_open_flyout(ctx_hover[0]);
            if (ctx_depth > 1) ctx_hover[1] = 0;
        }
        return;
    }
    if (sym == SDLK_LEFT) {
        if (d == 1) ctx_close_flyout();
        return;
    }
    if (sym == SDLK_RETURN) {
        int was = ctx_depth;
        ctx_activate(d, ctx_hover[d]);
        if (ctx_depth > was) ctx_hover[1] = 0;   /* entered the flyout */
    }
}

static int ctx_col_for(SDL_WindowID id) {
    for (int d = 0; d < ctx_depth; d++)
        if (ctx_win[d] && SDL_GetWindowID(ctx_win[d]) == id) return d;
    return -1;
}

static int ctx_owns_sid(int32_t sid) {
    for (int d = 0; d < ctx_depth; d++) if (ctx_sid[d] == sid) return 1;
    return 0;
}

static void draw_ctx(int d) {
    if (d >= ctx_depth || !ctx_win[d]) return;
    int w = CTX_W, h = ctx_h[d];
    uint32_t *px = (uint32_t *)ctx_surf[d]->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0),
             gray = rgb(128, 128, 128),
             sel = rgb(0, 0, 128), seltxt = rgb(255, 255, 255);
    fill_s(px, w, h, 0, 0, w, h, face);
    fill_s(px, w, h, 0, 0, w, 1, hi);            /* raised edge */
    fill_s(px, w, h, 0, 0, 1, h, hi);
    fill_s(px, w, h, 0, h - 1, w, 1, sh);
    fill_s(px, w, h, w - 1, 0, 1, h, sh);
    int y = MENU_PAD;
    for (int i = 0; i < ctx_nent[d]; i++) {
        ctx_ent *e = &ctx_ents[d][i];
        if (e->flags & CTF_SEP) {                /* the groove */
            fill_s(px, w, h, 4, y + MENU_SEP_H / 2 - 1, w - 8, 1, sh);
            fill_s(px, w, h, 4, y + MENU_SEP_H / 2, w - 8, 1, hi);
            y += MENU_SEP_H;
            continue;
        }
        int grayed = e->flags & CTF_GRAY;
        int hl = !grayed &&
                 (i == ctx_hover[d] || (d == 0 && i == ctx_child));
        if (hl) fill_s(px, w, h, 2, y, w - 4, MENU_ENTRY_H, sel);
        draw_text_s(px, w, h, 10, y + (MENU_ENTRY_H - 7) / 2, e->label,
                    grayed ? gray : hl ? seltxt : txt);
        if (e->flags & CTF_SUB) {                /* the flyout arrow */
            int ax = w - 10, ay = y + (MENU_ENTRY_H - 7) / 2;
            for (int t = 0; t < 4; t++)
                fill_s(px, w, h, ax + t, ay + t, 1, 7 - 2 * t,
                       hl ? seltxt : txt);
        }
        y += MENU_ENTRY_H;
    }
    SDL_UpdateWindowSurface(ctx_win[d]);
}

/* ---- Aero Peek (todos/0063) ---- */

static void peek_dismiss(void) {
    if (peek_win) SDL_DestroyWindow(peek_win);
    peek_win = NULL;
    peek_surf = NULL;
    peek_sid = 0;
    peek_for = 0;
    peek_tw = peek_th = 0;
    peek_dirty = 0;
    /* peek_pending stays set: an in-flight THUMB reply must still be
     * consumed off the socket (replies arrive in request order). */
}

/* Ask the kernel for a fresh thumbnail of the previewed window. */
static void peek_request(void) {
    if (peek_pending || !peek_for) return;
    int32_t a[3] = { peek_for, PEEK_W - 2 * PEEK_PAD, PEEK_H - 2 * PEEK_PAD };
    if (wmp_send(sock, WMP_THUMB, a, 3) == 0) peek_pending = 1;
}

static void draw_peek(void) {
    if (!peek_win) return;
    uint32_t *px = (uint32_t *)peek_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255), sh = rgb(96, 96, 96);
    fill_s(px, PEEK_W, PEEK_H, 0, 0, PEEK_W, PEEK_H, face);
    fill_s(px, PEEK_W, PEEK_H, 0, 0, PEEK_W, 1, hi);      /* raised edge */
    fill_s(px, PEEK_W, PEEK_H, 0, 0, 1, PEEK_H, hi);
    fill_s(px, PEEK_W, PEEK_H, 0, PEEK_H - 1, PEEK_W, 1, sh);
    fill_s(px, PEEK_W, PEEK_H, PEEK_W - 1, 0, 1, PEEK_H, sh);
    for (int y = 0; y < peek_th; y++)
        for (int x = 0; x < peek_tw; x++) {
            const uint8_t *p = peek_px + (y * peek_tw + x) * 4;
            px[((PEEK_H - peek_th) / 2 + y) * PEEK_W + (PEEK_W - peek_tw) / 2 + x] =
                rgb(p[0], p[1], p[2]);
        }
    SDL_UpdateWindowSurface(peek_win);
}

/* A THUMB reply landed (drain_socket routes every R_SHOT here). Payload:
 * sid, w, h, then w*h*4 rgba. Keep it only if the popup is still up for
 * that window at a size that fits the static buffer. */
static void peek_consume(wmp_hdr *h) {
    peek_pending = 0;
    int32_t head[3];
    if (h->plen < 12 || wmp_read_all(sock, head, 12) != 0) exit(1);
    uint32_t n = h->plen - 12;
    int keep = peek_win && head[0] == peek_for &&
               head[1] > 0 && head[1] <= PEEK_W - 2 * PEEK_PAD &&
               head[2] > 0 && head[2] <= PEEK_H - 2 * PEEK_PAD &&
               (uint32_t)(head[1] * head[2] * 4) == n;
    if (!keep) { if (wmp_skip(sock, n) != 0) exit(1); return; }
    if (wmp_read_all(sock, peek_px, (int)n) != 0) exit(1);
    peek_tw = head[1];
    peek_th = head[2];
    peek_dirty = 1;
}

/* Raise the popup for wins[] entry `sid`, centered over its button. Its
 * EV_CREATED echo ("peek") parks it above the bar on the TOP layer and
 * hands focus straight back to whatever had it. */
static void peek_show(int32_t sid, int btn_x, int bw) {
    if (peek_win && peek_for == sid) return;     /* already up: just hold */
    peek_dismiss();
    peek_for = sid;
    peek_x = btn_x + bw / 2 - PEEK_W / 2;
    if (peek_x > scr_w - PEEK_W) peek_x = scr_w - PEEK_W;
    if (peek_x < 0) peek_x = 0;
    peek_win = SDL_CreateWindow("peek", PEEK_W, PEEK_H, SDL_WINDOW_BORDERLESS);
    if (!peek_win) { peek_for = 0; return; }
    peek_surf = SDL_GetWindowSurface(peek_win);
    peek_tick = 0;
    peek_request();
    draw_peek();                       /* bare face until the thumb lands */
}

/* EV_CYCLE (todos/0032): walk focus. dir > 0 focuses the LEAST recently
 * used window — repeated presses tour the whole ring in LRU order (each
 * FOCUS echo restamps, so the walk converges instead of ping-ponging);
 * dir < 0 focuses the PREVIOUS window (second most recent — the quick
 * toggle, and the inverse of one forward step). Minimized windows are
 * skipped. */
static void cycle(int dir) {
    win_t *cur = NULL, *pick = NULL;
    for (int i = 0; i < nwins; i++)
        if (!wins[i].minimized && (!cur || wins[i].stamp > cur->stamp))
            cur = &wins[i];
    if (!cur) return;
    for (int i = 0; i < nwins; i++) {
        win_t *w = &wins[i];
        if (w->minimized || w == cur) continue;
        if (dir > 0 ? (!pick || w->stamp < pick->stamp)
                    : (!pick || w->stamp > pick->stamp)) pick = w;
    }
    if (!pick) return;
    int32_t a[1] = { pick->sid };
    wmp_send(sock, WMP_FOCUS, a, 1);
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
    run_dismiss();                     /* likewise (todos/0078) */
    peek_dismiss();                    /* likewise (todos/0063) */
    ctx_dismiss();                     /* likewise (todos/0091) */
    if (desk_win) SDL_DestroyWindow(desk_win);   /* recreate at the new size */
    desk_win = NULL;
    if (bar_win) SDL_DestroyWindow(bar_win);
    if (make_desk() != 0) exit(2);
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
            if (strncmp(r.title, "startmenu", 9) == 0) {   /* 0028/0078 */
                int depth = r.title[9] ? r.title[9] - '1' : 0;
                if (depth < 0 || depth >= mdepth || !mcol[depth].win) return;
                menu_col *c = &mcol[depth];
                c->sid = r.sid;
                int32_t a[3] = { r.sid, c->x, c->y };
                wmp_send(sock, WMP_MOVE, a, 3);
                /* Top layer like the bar (todos/0038) — created later, so
                 * the stable sort keeps the menu above it. */
                int32_t ly[2] = { r.sid, 1 };
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                if (depth > 0 && mcol[0].sid) {
                    /* Flyouts must not hold focus: closing one on a
                     * hover re-target would bounce focus to an app and
                     * the EV_FOCUS rule would dismiss the whole menu.
                     * The ROOT column keeps the keyboard (the Aero-Peek
                     * hand-back precedent, todos/0078). */
                    int32_t f[1] = { mcol[0].sid };
                    wmp_send(sock, WMP_FOCUS, f, 1);
                }
            } else if (strncmp(r.title, "startrun", 9) == 0) {   /* 0078 */
                if (!run_win) return;          /* dismissed before the echo */
                run_sid = r.sid;
                int32_t a[3] = { r.sid, 6, scr_h - BAR_H - RUN_H - 6 };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer, like the menu */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
            } else if (strncmp(r.title, "peek", 5) == 0) {   /* todos/0063 */
                if (!peek_win) return;         /* dismissed before the echo */
                peek_sid = r.sid;
                int32_t a[3] = { r.sid, peek_x, scr_h - BAR_H - PEEK_H - 4 };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer, like the bar */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                /* A hover preview must not steal focus from the app. */
                for (int i = 0; i < nwins; i++)
                    if (wins[i].focused && !wins[i].minimized) {
                        int32_t f[1] = { wins[i].sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                        break;
                    }
            } else if (strncmp(r.title, "desktop", 8) == 0) {   /* todos/0029 */
                desk_sid = r.sid;
                int32_t a[3] = { r.sid, 0, 0 };
                wmp_send(sock, WMP_MOVE, a, 3);
                /* Bottom layer (todos/0038, was RESTACK place=1): pinned —
                 * a lowered app window can no longer sink under it. */
                int32_t ly[2] = { r.sid, -1 };
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                /* Creating furniture steals focus (create-focus is kernel
                 * mechanism); hand it back to the focused app window. */
                for (int i = 0; i < nwins; i++)
                    if (wins[i].focused && !wins[i].minimized) {
                        int32_t f[1] = { wins[i].sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                        break;
                    }
            } else if (strncmp(r.title, "ctxmenu", 7) == 0) {   /* 0091 */
                int d = r.title[7] ? 1 : 0;
                if (d >= ctx_depth || !ctx_win[d]) return;   /* dismissed */
                ctx_sid[d] = r.sid;
                int32_t a[3] = { r.sid, ctx_x[d], ctx_y[d] };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer, like the menu */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                if (d > 0 && ctx_sid[0]) {
                    /* The flyout must not hold focus — the root column
                     * keeps the keyboard (the Start-menu rule, 0078). */
                    int32_t f[1] = { ctx_sid[0] };
                    wmp_send(sock, WMP_FOCUS, f, 1);
                }
            } else {                   /* the taskbar: bottom edge */
                bar_sid = r.sid;
                int32_t a[3] = { r.sid, 0, scr_h - BAR_H };
                wmp_send(sock, WMP_MOVE, a, 3);
                /* Always-on-top (todos/0038): windows dragged onto the strip
                 * slide UNDER the bar; its buttons stay clickable. */
                int32_t ly[2] = { r.sid, 1 };
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
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
            w->stamp = ++zctr;         /* newest (create focuses; 0032) */
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
        for (int d = 0; d < MENU_DEPTH; d++)              /* defensive (0028) */
            if (p[0] == mcol[d].sid) mcol[d].sid = 0;
        if (p[0] == run_sid) run_sid = 0;                 /* likewise (0078) */
        for (int d = 0; d < 2; d++)                       /* likewise (0091) */
            if (p[0] == ctx_sid[d]) ctx_sid[d] = 0;
        if (p[0] == peek_for) peek_dismiss();             /* preview target gone */
        if (p[0] == desk_sid) { desk_sid = 0; desk_focused = 0; }   /* (0077) */
        /* Compact, don't swap-remove: taskbar buttons keep launch order
         * across any close (todos/0031 — the Win95 behavior). */
        for (int i = 0; i < nwins; i++)
            if (wins[i].sid == p[0]) {
                memmove(&wins[i], &wins[i + 1], (size_t)(nwins - i - 1) * sizeof wins[0]);
                nwins--;
                break;
            }
        break;
    }
    case WMP_EV_FOCUS: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        /* Focus moving anywhere but the menu's own columns dismisses it
         * (0028). A column's create-focus echo is exempt — it may even
         * arrive in the same drain as the EV_CREATED that told us its
         * sid (EV_CREATED is emitted first, so the sid is known). The
         * run dialog follows the same rule, gated on its echo having
         * landed: between run_open() and the echo, the focus fall from
         * the menu teardown must not kill it (todos/0078). The root-echo
         * gate matters here too since 0091: menu_toggle's ctx_dismiss
         * makes focus fall to an app window, and that EV_FOCUS must not
         * kill the menu it just opened. */
        if (mdepth > 0 && mcol[0].sid && !menu_owns_sid(p[0])) menu_dismiss();
        if (run_win && run_sid && p[0] != run_sid) run_dismiss();
        /* Focus leaving the context menu dismisses it — outside-click on
         * any app window lands here (todos/0091). Gated on the root echo
         * having arrived, the run-dialog precedent. */
        if (ctx_depth > 0 && ctx_sid[0] && !ctx_owns_sid(p[0])) ctx_dismiss();
        /* Desktop focus tracking (todos/0077): keys route to the icon grid
         * only while it holds focus; losing it also resets the tracked
         * modifiers (their keyups would land elsewhere). */
        if (desk_sid) {
            desk_focused = p[0] == desk_sid;
            if (!desk_focused) mod_ctrl = mod_shift = 0;
        }
        for (int i = 0; i < nwins; i++) {
            wins[i].focused = wins[i].sid == p[0];
            if (wins[i].focused) {
                wins[i].minimized = 0;                    /* focus restores */
                wins[i].stamp = ++zctr;                   /* recency (0032) */
            }
        }
        break;
    }
    case WMP_EV_CYCLE: {               /* window cycling (todos/0032) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        cycle(p[0]);
        break;
    }
    case WMP_EV_MENU: {                /* Start chord / wmctl menu (0078) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        menu_toggle();
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
        else if (h.type == WMP_R_SHOT) peek_consume(&h);   /* THUMB (0063) */
        else if (wmp_skip(sock, h.plen) != 0) exit(1);
    }
}

/* ---- the taskbar ---- */

/* Current button width: BTN_W until the row would run past the clock,
 * then shrink to fit (Win95 overflow, todos/0031). Drawing and click
 * mapping share this. */
static int btn_width(void) {
    if (nwins == 0) return BTN_W;
    int avail = bar_w - START_W - BTN_GAP - 2 - CLOCK_W;
    int w = avail / nwins - BTN_GAP;
    if (w > BTN_W) w = BTN_W;
    if (w < BTN_MIN) w = BTN_MIN;
    return w;
}

/* Taskbar hover (todos/0063 Aero Peek): motion over a drawn button raises
 * the live thumbnail popup for its window; anywhere else on the bar drops
 * it. The Start menu wins conflicts — no previews while it's open. */
static void bar_motion(float fx) {
    if (mdepth > 0) return;
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if (rel >= 0 && rel % (bw + BTN_GAP) < bw && i < nwins &&
        x + bw <= bar_w - CLOCK_W) {   /* same overflow gate as draw_bar */
        peek_show(wins[i].sid, x, bw);
        peek_idle = 0;                 /* still hovering: hold the popup */
    } else peek_dismiss();
}

static void bar_click(float fx) {
    peek_dismiss();                    /* a click acts; the preview drops */
    if ((int)fx < START_W) { menu_toggle(); return; }     /* Start (0028) */
    menu_dismiss();                    /* any other taskbar click dismisses */
    ctx_dismiss();                     /* likewise (todos/0091) */
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    if (rel < 0 || rel % (bw + BTN_GAP) >= bw || i >= nwins) return;
    int32_t a[1] = { wins[i].sid };
    if (wins[i].focused && !wins[i].minimized) wmp_send(sock, WMP_MINIMIZE, a, 1);
    else wmp_send(sock, WMP_FOCUS, a, 1);
}

/* Taskbar right-click (todos/0091): a drawn button raises the Win95 window
 * menu; the Start strip and the empty bar stay reserved (the taskbar-strip
 * menu is todos/0101). Same geometry math as bar_click/bar_motion. */
static void bar_rclick(float fx) {
    peek_dismiss();
    menu_dismiss();
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if ((int)fx < START_W || rel < 0 || rel % (bw + BTN_GAP) >= bw ||
        i >= nwins || x + bw > bar_w - CLOCK_W) {   /* overflow gate too */
        ctx_dismiss();
        return;
    }
    ctx_open_bar(&wins[i], x);
}

static void draw_bar(void) {
    uint32_t *px = (uint32_t *)bar_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0);
    fill(px, 0, 0, bar_w, BAR_H, face);
    fill(px, 0, 0, bar_w, 1, hi);                       /* top edge highlight */
    /* The Start button (todos/0028): raised normally, sunken while open. */
    {
        int down = mdepth > 0;
        fill(px, 2, 3, START_W - 4, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, 2, 3, START_W - 4, 1, down ? sh : hi);
        fill(px, 2, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, 2, BAR_H - 4, START_W - 4, 1, down ? hi : sh);
        fill(px, START_W - 3, 3, 1, BAR_H - 6, down ? hi : sh);
        draw_text(px, 8, (BAR_H - 7) / 2, "START", txt);
    }
    int bw = btn_width();              /* overflow shrink (todos/0031) */
    for (int i = 0; i < nwins; i++) {
        int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
        if (x + bw > bar_w - CLOCK_W) break;   /* never under the clock */
        int down = wins[i].focused && !wins[i].minimized;
        /* Win95 button relief: raised normally, sunken when active. */
        fill(px, x, 3, bw, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, x, 3, bw, 1, down ? sh : hi);
        fill(px, x, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, x, BAR_H - 4, bw, 1, down ? hi : sh);
        fill(px, x + bw - 1, 3, 1, BAR_H - 6, down ? hi : sh);
        char label[17];
        int n = 0, maxn = (bw - 10) / 6;
        if (maxn > 16) maxn = 16;
        for (const char *s = wins[i].title; *s && n < maxn; s++) label[n++] = *s;
        label[n] = 0;
        draw_text(px, x + 6, (BAR_H - 7) / 2, label,
                  wins[i].minimized ? rgb(80, 80, 80) : txt);
    }
    /* The clock (todos/0031): right-aligned HH.MM, local time; draw_bar
     * runs per frame, so it updates on the minute by construction. */
    {
        time_t now = time(NULL);
        struct tm *tm = localtime(&now);
        char hhmm[6];
        snprintf(hhmm, sizeof hhmm, "%02d.%02d", tm->tm_hour, tm->tm_min);
        draw_text(px, bar_w - CLOCK_W + 8, (BAR_H - 7) / 2, hhmm, txt);
    }
    SDL_UpdateWindowSurface(bar_win);
}

static void frame_cb(void) {
    drain_socket();
    reap_kids();
    /* Coarse /root/Desktop watch (todos/0029): one readdir per second-ish
     * of frame ticks — no watch API exists or is needed. */
    if (++desk_tick >= 60) { desk_tick = 0; desk_load(); }
    /* Many windows, one queue: dispatch by windowID (0028/0029/0063/0078).
     * Menu columns and the run dialog come and go inside handlers, so
     * their ids are resolved per event (menu_col_for), not cached. */
    SDL_WindowID did = desk_win ? SDL_GetWindowID(desk_win) : 0;
    SDL_WindowID pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
            int md = menu_col_for(e.button.windowID);
            int cd = ctx_col_for(e.button.windowID);
            if (md >= 0) menu_click(md, e.button.y);
            else if (cd >= 0) ctx_click(cd, e.button.y);   /* 0091 */
            else if (run_win && e.button.windowID == SDL_GetWindowID(run_win)) {
                /* a click inside the run dialog: nothing to hit */
            } else if (desk_win && e.button.windowID == did) {
                menu_dismiss();        /* a desktop click dismisses (0029) */
                run_dismiss();         /* likewise (todos/0078) */
                peek_dismiss();        /* likewise (todos/0063) */
                if (e.button.button == 1) {
                    ctx_dismiss();     /* likewise (todos/0091) */
                    /* Click-to-focus for the desktop (todos/0077): the
                     * kernel exempts borderless surfaces, so the policy
                     * asks — modifier keyups and grid navigation keys
                     * must reach this process. */
                    if (desk_sid) {
                        int32_t f[1] = { desk_sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                    }
                    desk_down(e.button.x, e.button.y, e.button.timestamp);
                } else if (e.button.button == 3) {
                    /* Right-click (todos/0091): an icon gets its menu —
                     * selecting it alone first unless already in the set
                     * (the Win95 rule) — empty desktop gets the New/Sort/
                     * Refresh/Display one. No drag, no dblclick pairing. */
                    int x = (int)e.button.x, y = (int)e.button.y;
                    int idx = desk_hit(x, y);
                    if (idx >= 0) {
                        if (!(desk_selmask >> idx & 1)) {
                            desk_selmask = 1ULL << idx;
                            desk_anchor = idx;
                            desk_dirty = 1;
                        }
                        ctx_open_icon(idx, x, y);
                    } else {
                        if (desk_selmask) {
                            desk_selmask = 0;
                            desk_anchor = -1;
                            desk_dirty = 1;
                        }
                        ctx_open_desktop(x, y);
                    }
                }
            } else if (peek_win && e.button.windowID == pkid) {
                int32_t f[1] = { peek_for };   /* click the preview: activate */
                wmp_send(sock, WMP_FOCUS, f, 1);
                peek_dismiss();
            } else if (e.button.button == 3) bar_rclick(e.button.x);
            else bar_click(e.button.x);
            pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;   /* may drop */
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_UP) {
            if (desk_win && e.button.windowID == did && e.button.button == 1)
                desk_up(e.button.x, e.button.y);   /* marquee/drag end (0077) */
        } else if (e.type == SDL_EVENT_MOUSE_MOTION) {
            int md = menu_col_for(e.motion.windowID);
            int cd = ctx_col_for(e.motion.windowID);
            if (md >= 0) menu_motion(md, e.motion.y);
            else if (cd >= 0) ctx_motion(cd, e.motion.y);   /* 0091 */
            else if (desk_win && e.motion.windowID == did) {
                peek_dismiss();        /* pointer left the bar (0063) */
                desk_motion(e.motion.x, e.motion.y, e.motion.state);
            } else if (peek_win && e.motion.windowID == pkid) {
                peek_idle = 0;         /* hovering the preview holds it */
            } else if (!(run_win && e.motion.windowID == SDL_GetWindowID(run_win))) {
                bar_motion(e.motion.x);
                pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;
            }
        } else if (e.type == SDL_EVENT_KEY_DOWN || e.type == SDL_EVENT_KEY_UP) {
            /* Modifier tracking (todos/0077): by keysym, both edges —
             * pointer records carry no mod word, so ctrl/shift-click
             * reads these. */
            int down = e.type == SDL_EVENT_KEY_DOWN;
            int k = (int)e.key.key;
            if (k == SDLK_LCTRL || k == SDLK_RCTRL) mod_ctrl = down;
            else if (k == SDLK_LSHIFT || k == SDLK_RSHIFT) mod_shift = down;
            /* Keyboard (todos/0078): an open context menu owns the keys
             * first (its root holds focus — todos/0091); then the Start
             * menu, the run dialog, and the focused desktop's icon grid
             * (todos/0077), in that order. */
            if (down) {
                if (ctx_depth > 0) ctx_key(k);
                else if (mdepth > 0) menu_key(k);
                else if (run_win) run_key(k);
                else if (desk_focused) desk_key(k);
            }
        } else if (e.type == SDL_EVENT_QUIT) exit(0);
    }
    /* Aero Peek housekeeping (todos/0063): keep the thumbnail live while
     * the popup is up; drop it once nothing has hovered it for a while. */
    if (peek_win) {
        if (++peek_idle >= PEEK_IDLE) peek_dismiss();
        else if (++peek_tick >= PEEK_REFRESH) { peek_tick = 0; peek_request(); }
    }
    draw_bar();
    for (int d = 0; d < mdepth; d++) draw_menu_col(d);
    for (int d = 0; d < ctx_depth; d++) draw_ctx(d);       /* 0091 */
    draw_run();
    draw_desk();
    if (peek_dirty) { peek_dirty = 0; draw_peek(); }
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
    if (make_desk() != 0) return 2;    /* bottom of z; created first (0029) */
    if (make_bar() != 0) return 2;
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
