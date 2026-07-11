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
 * Aero Snap (todos/0095) extends that: the kernel reports the pointer
 * crossing screen-edge zones mid-title-drag (EV_SNAP_EDGE — this process
 * raises a translucent preview window over the target rect, the 0063
 * alpha tier) and the drop (EV_SNAP_DROP — commit: left/right halves,
 * corner quarters, top = the 0025 maximize; edge 0 on a snapped or
 * maximized window restores its floating SIZE at the drop point, the
 * drag-off rule — Win7 restores mid-drag, at-release keeps the kernel
 * drag untouched, a recorded simplification). Win+arrow rides
 * EV_SNAP_KEY (the EV_CYCLE chord pattern; also `wmctl snap`):
 * Left/Right snap the focused window to halves (pressing toward its own
 * edge wraps across the screen), Up maximizes, Down restores a snapped/
 * maximized window and minimizes a floating one. Snap state and the
 * saved floating rect live per-window HERE — like maximize, a wm
 * restart forgets them. Fixed-size windows letterbox into their half or
 * quarter with the same aspect-fit SET_DST maximize uses.
 *
 * The Start menu (todos/0028, Win95-classic by todos/0078, restyled into
 * the Win7 TWO-PANE stage by todos/0098) is a set of borderless SDL
 * windows in this same process, created on Start-button click (or the
 * Ctrl+Esc chord / `wmctl menu` — WMP EV_MENU, the EV_CYCLE pattern) and
 * destroyed on selection or dismiss — SDL events dispatch per window by
 * e.*.windowID. The ROOT window ("startmenu") is a fixed-size two-pane
 * panel: a LEFT pane of pinned entries (~/.config/pinned) + MRU recents
 * (~/.config/recent, pushed by activate() on every real launch, capped at
 * RECENT_MAX) + an "All Programs" row, with a live SEARCH box at its foot;
 * a RIGHT pane holding the fixed places (SETTINGS -> /bin/ctlpanel,
 * RUN... -> the run dialog; Shut Down joins when todos/0051 lands). Typing
 * (the root holds keyboard focus) filters a flat walk of the menu tree
 * into the left pane live; Enter launches the top hit. "All Programs"
 * (hover, click, or arrow-Right) cascades the menu tree as flyout columns
 * to the right — each its own window titled "startmenu2"/"startmenu3"/...
 * so the EV_CREATED park can tell them apart, listing /etc/menu if that
 * directory exists else the baked /usr/share/menu (todos/0040 —
 * systemd-style /etc: user overrides only, first-existing-dir wins), with
 * subdirectories as GROUPS that cascade further. Only the root ever holds
 * keyboard focus (flyouts hand it back at their create echo, the Aero-Peek
 * precedent); keys route by menu-open state, so once a flyout is open its
 * DEEPEST column takes arrows/Enter/type-ahead/Esc. The RUN... builtin is
 * one more borderless window ("startrun") with a text field; Enter spawns
 * `/bin/sh -c <input>` the same desktop way. Children spawn with cwd /root
 * (the wm chdir's at startup — doom finds its WAD by cwd) and are reaped
 * with a WNOHANG poll.
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
 * (ctlpanel's Display applet); an icon: Open, Cut/Copy (0092) and Delete
 * to the Recycle Bin (0093 — the bin icon itself gets Open + Empty
 * instead, and pins to the grid's tail); a taskbar button:
 * Restore/Minimize/Maximize/Close over the
 * chrome ops this process already owns, inapplicable rows grayed. Same
 * furniture rules as the Start menu: top layer, root holds kernel focus
 * (flyouts hand it back), focus-leave/outside-click/Esc dismiss, arrows/
 * Enter drive it. The Start strip stays reserved; window title bars for
 * 0102.
 *
 * Taskbar polish (todos/0101): the empty strip (and the clock/Show Desktop
 * region) right-clicks to a taskbar menu — Cascade, Tile, Minimize All,
 * Properties (-> ctlpanel) — pure wm.c policy loops over the window list
 * (resizable windows get real MOVE+RESIZE; fixed-size ones are cascaded,
 * never sheared — the 0021 rule). A narrow Show Desktop sliver at the far
 * right (past the clock) toggles minimize-all / restore, stashing the set
 * it minimized so a second click brings back exactly those. Hovering (or
 * clicking, for agent parity) the clock raises a "datepop" tooltip window
 * with the full date — the Aero-Peek borderless-furniture mechanism.
 *
 * The window system menu (todos/0102): Alt+Space (WMP EV_SYSMENU, the
 * EV_CYCLE chord pattern; also `wmctl sysmenu`) raises the Win95 sysmenu on
 * the focused window — the taskbar-button menu (0101) plus Move/Size rows,
 * anchored at the window's top-left, rows grayed per its state. Picking
 * Move or Size keeps the popup up as a keyboard GRABBER (it holds kernel
 * focus): arrows nudge the target 8px, Enter commits, Esc reverts to the
 * stashed rect — the accessibility path to move/resize, since kernel drag
 * is pointer-only. Size is disabled on fixed-size windows (they scale by
 * pointer, 0024). Restore/Minimize/Maximize/Close reuse the existing
 * chrome ops.
 *
 * The screensaver (todos/0096): after the configured seconds of idle —
 * measured by the KERNEL (WMP GET_IDLE, polled once a second off the frame
 * tick), since this process only ever sees input over its own windows —
 * one more fullscreen borderless window ("screensaver") raises on the TOP
 * layer and runs a classic (marquee / starfield, drawn per frame) until
 * any input lands on it; being fullscreen, top, and focused (the
 * create-focus is deliberately NOT handed back — the anti-peek), every
 * pointer and key event does land on it, so dismissal needs no kernel
 * help. Config via saver.h (~/.config/screensaver, /etc/screensaver, the
 * baked /usr/share/screensaver; re-read at each poll so the Control Panel
 * applet's writes go live). `wmctl saver` / the applet's Preview button
 * ride WMP EV_SAVER to raise it immediately (the EV_MENU pattern).
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
#include "sounds.h"
#include "saver.h"

#define BAR_H     28
#define START_W   50    /* the Start button strip at the taskbar's left (0028) */
#define BTN_W     104   /* preferred button width; shrinks on overflow (0031) */
#define BTN_MIN   24    /* ...but never below a clickable floor */
#define BTN_GAP   4
#define CLOCK_W   45    /* right-aligned HH.MM cell: 8 + 5*6-1 + 8 (0031) */
#define SHOWDESK_W 14   /* the Show Desktop sliver at the far right (0101) */
#define DATE_W    104   /* the clock-hover date tooltip (0101): "SAT 2026-07-11" */
#define DATE_H    22
#define MAX_WIN   64
#define TITLE_H   28    /* keep placements below the kernel title bar (>= WM_TITLE_H) */

#define MENU_W       150    /* a flyout column's full width */
#define MENU_ENTRY_H 20
#define MENU_PAD     4
#define MENU_SEP_H   8      /* separator groove (kept for flyout row math) */
#define MAX_MENU     32
#define MENU_DEPTH   4      /* two-pane root + up to 3 cascading flyouts */
#define MENU_FIXED   2      /* right-pane fixed rows (SETTINGS, RUN...) */

/* Win7 two-pane root (todos/0098). Left pane: pinned entries + MRU
 * recents + an "All Programs" row (which cascades the tree flyout), with
 * a live search box at its foot; right pane: the fixed places column.
 * Flyouts (depth >= 1) stay single-column entry lists (the 0078
 * substrate). The root is a FIXED size so its geometry doesn't shift with
 * the recents count. */
#define SM_LEFT_W    170
#define SM_RIGHT_W   120
#define SM_ROW_H     20
#define SM_PAD       4
#define SM_LEFT_ROWS 10     /* left-pane row slots (also the item cap) */
#define SM_SEARCH_H  22     /* the search box at the foot of the left pane */
#define SM_ROOT_W    (SM_LEFT_W + SM_RIGHT_W)
#define SM_ROOT_H    (SM_PAD + SM_LEFT_ROWS * SM_ROW_H + 4 + SM_SEARCH_H + SM_PAD)
#define SM_SEARCH_Y  (SM_PAD + SM_LEFT_ROWS * SM_ROW_H + 4)
#define RECENT_MAX   8      /* MRU cap in ~/.config/recent */

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
    int snapped;                       /* Aero Snap edge (todos/0095): 0
                                          floating, 1 L, 2 R, 4-7 quarters
                                          (top snap becomes maximized) */
    int32_t sx, sy, sw, sh;            /* saved FLOATING geometry for
                                          restore: x, y, and w/h (resizable)
                                          or dst (fixed) — written once on
                                          leaving the floating state, kept
                                          across snap-to-snap moves */
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

/* Show Desktop (todos/0101): the far-right sliver toggles minimize-all /
 * restore. sd_stash holds the sids WE minimized on the way down (by sid,
 * since wins[] indices aren't stable), so a second click brings back
 * exactly those — windows minimized before the toggle stay minimized. */
static int32_t sd_stash[MAX_WIN];
static int sd_nstash = 0;

/* The clock-hover date tooltip (todos/0101): a borderless top-layer
 * "datepop" furniture window (the Aero-Peek mechanism). Shown on hover
 * (unpinned: idle-dismissed) or toggled by a click (pinned: stays up). */
static SDL_Window *date_win;
static SDL_Surface *date_surf;
static int32_t date_sid = 0;
static int date_x = 0;
static int date_idle = 0;
static int date_pinned = 0;

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

/* Win7 two-pane root state (todos/0098): mcol[0] still owns the root
 * WINDOW (sid/geometry/parking through the shared plumbing), but its left
 * pane is this heterogeneous item list rather than mcol[0].ents — pinned
 * entries, then MRU recents, then All Programs; in search mode, a flat
 * walk of the tree. Flyouts (depth >= 1) keep using menu_col wholesale. */
enum { SMI_PIN, SMI_RECENT, SMI_ALLPROGS, SMI_RESULT };
typedef struct { char name[32]; char path[256]; int kind; } sm_item;
static sm_item sm_left[SM_LEFT_ROWS];
static int sm_nleft = 0;
static int sm_lhover = -1;         /* left-pane cursor row, -1 none */
static int sm_rhover = -1;         /* right-pane (fixed) cursor row, -1 none */
static char sm_search[64];         /* the live search query */
static int sm_search_len = 0;

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
static int desk_trash_full = 0;    /* Recycle Bin glyph state (todos/0093),
                                      refreshed on the same coarse tick */
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

/* Inline rename editor (todos/0103): F2 on a single-selected icon, or the
 * icon menu's Rename, opens an edit box over that icon's label — printable
 * keys insert, Backspace deletes, Enter commits rename(2), Esc cancels, a
 * click-away or focus-loss commits (the Win95 behavior). desk_edit is the
 * desk[] index being edited, -1 = none; desk_ebuf holds the working name. */
static int desk_edit = -1;
static char desk_ebuf[256];
static int desk_elen = 0;
static int desk_edit_armed = 0;    /* the editor's desktop focus has landed —
                                      gates focus-loss commit so the transient
                                      focus-fall when the icon menu dismisses
                                      (Rename path) can't close it early */

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
    CM_RENAME,                     /* icon (0103: the inline rename editor) */
    CM_CUT, CM_COPY,               /* icon (0092: the selection set) */
    CM_DELETE,                     /* icon (0093: to the Recycle Bin) */
    CM_EMPTY,                      /* the Recycle Bin icon (0093) */
    CM_RESTORE, CM_MINIMIZE, CM_MAXIMIZE, CM_CLOSE, /* taskbar button */
    CM_CASCADE, CM_TILE, CM_MIN_ALL, CM_PROPERTIES, /* taskbar strip (0101) */
    CM_MOVE, CM_SIZE               /* window system menu (todos/0102) */
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

/* Window system menu keyboard move/resize modes (todos/0102): after the
 * sysmenu popup's Move/Size row fires, the popup stays up as the key
 * grabber (its root holds kernel focus) and arrows nudge the target; Enter
 * commits, Esc reverts to the stashed rect. sys_mode 0 none / 1 move / 2
 * size. */
static int sys_mode = 0;
static int32_t sys_target = 0;
static int32_t sys_x0, sys_y0, sys_w0, sys_h0;  /* pre-mode rect (Esc revert) */
#define SYS_STEP 8                 /* arrow nudge, in px */
#define SYS_MIN_W 96               /* size-mode floor (matches the tile grid) */
#define SYS_MIN_H 96
static void desk_delete(void);     /* likewise (0093 — desk_key's Del) */
static void menu_dismiss(void);    /* these three likewise (0096 —
                                      saver_show clears every popup
                                      before covering the screen) */
static void run_dismiss(void);
static void peek_dismiss(void);
static void date_dismiss(void);                    /* clock tooltip (0101) */
static void sm_record_recent(const char *path);   /* MRU recents (0098) */

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

/* Snap preview state (todos/0095): a translucent borderless window (the
 * 0063 alpha tier) covering the snap target while a title drag hovers a
 * screen-edge zone — raised/replaced/dropped on EV_SNAP_EDGE, always gone
 * at the drop. */
static SDL_Window *snapprev_win;   /* NULL = hidden */
static SDL_Surface *snapprev_surf;
static int32_t snapprev_sid = 0;   /* EV_CREATED echo ("snappreview") */
static int snapprev_edge = 0;      /* zone currently previewed */
static int snapprev_x, snapprev_y, snapprev_w, snapprev_h;

/* Screensaver state (todos/0096): one fullscreen borderless top-layer
 * window, alive only while the saver runs; the animation redraws it per
 * frame tick. The idle clock is the kernel's (GET_IDLE -> R_IDLE, routed
 * off the drain like the peek's R_SHOT). */
#define SAVER_STARS 128
static SDL_Window *saver_win;      /* NULL = not running */
static SDL_Surface *saver_surf;
static int32_t saver_sid = 0;      /* EV_CREATED echo ("screensaver") */
static int32_t saver_prev = 0;     /* the window to re-focus at dismissal */
static int saver_kind = 0;         /* 1 marquee, 2 starfield (from config) */
static sv_cfg saver_cfg;           /* last polled configuration */
static int saver_tick = 0;         /* coarse once-a-second poll counter */
static int idle_pending = 0;       /* GET_IDLE in flight */
static int marq_x, marq_y;         /* marquee banner position */
static float star_x[SAVER_STARS], star_y[SAVER_STARS], star_z[SAVER_STARS];

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

/* ---- taskbar-strip arrangement commands (todos/0101) ---- */

/* Place one window at cascade slot k: a diagonal offset in the work area,
 * wrapped so a long run stays on-screen. Resizable windows also resize to
 * a uniform 3/5 box; fixed-size ones are only moved (never sheared, the
 * 0021 rule). Cascading exits any maximize/snap state. */
static void cascade_one(win_t *w, int k) {
    w->maximized = 0;
    w->snapped = 0;
    int32_t cw = scr_w * 3 / 5, ch = (scr_h - BAR_H - TITLE_H) * 3 / 5;
    int step = TITLE_H + 4;
    int span_x = scr_w - cw - 8;  if (span_x < step) span_x = step;
    int span_y = scr_h - BAR_H - ch - TITLE_H - 8; if (span_y < step) span_y = step;
    int32_t m[3] = { w->sid, 8 + (k * step) % span_x,
                     TITLE_H + 8 + (k * step) % span_y };
    wmp_send(sock, WMP_MOVE, m, 3);
    if (w->resizable) {
        int32_t r[3] = { w->sid, cw, ch };
        wmp_send(sock, WMP_RESIZE, r, 3);
    }
}

/* Cascade every visible (non-minimized) window. */
static void cascade_windows(void) {
    int k = 0;
    for (int i = 0; i < nwins; i++)
        if (!wins[i].minimized) cascade_one(&wins[i], k++);
}

/* Tile the resizable visible windows into a near-square grid filling the
 * work area; fixed-size visible windows can't fill a cell without shearing
 * (0021), so they get cascaded positions instead. No resizable window (or a
 * too-cramped grid) falls back to a plain cascade. */
static void tile_windows(void) {
    int nt = 0;
    for (int i = 0; i < nwins; i++)
        if (!wins[i].minimized && wins[i].resizable) nt++;
    if (nt == 0) { cascade_windows(); return; }
    int32_t work_w = scr_w, work_h = scr_h - BAR_H - TITLE_H;
    int rows = 1; while ((rows + 1) * (rows + 1) <= nt) rows++;  /* isqrt */
    int cols = (nt + rows - 1) / rows;
    int cw = work_w / cols, chh = work_h / rows;
    if (cw < 96 || chh < 96) { cascade_windows(); return; }
    int ti = 0, ck = 0;
    for (int i = 0; i < nwins; i++) {
        win_t *w = &wins[i];
        if (w->minimized) continue;
        if (w->resizable) {
            w->maximized = 0;
            w->snapped = 0;
            int r = ti / cols, c = ti % cols;
            int32_t m[3] = { w->sid, c * cw, TITLE_H + r * chh };
            wmp_send(sock, WMP_MOVE, m, 3);
            int32_t rz[3] = { w->sid, cw, chh };
            wmp_send(sock, WMP_RESIZE, rz, 3);
            ti++;
        } else cascade_one(w, ck++);   /* fixed-size: cascaded, never sheared */
    }
}

/* Minimize All (todos/0101): stash then minimize every visible window, so
 * Show Desktop can bring back exactly this set. */
static void min_all(void) {
    sd_nstash = 0;
    for (int i = 0; i < nwins; i++)
        if (!wins[i].minimized) {
            if (sd_nstash < MAX_WIN) sd_stash[sd_nstash++] = wins[i].sid;
            int32_t a[1] = { wins[i].sid };
            wmp_send(sock, WMP_MINIMIZE, a, 1);
        }
}

/* Show Desktop toggle (todos/0101): if we hold a stash of still-minimized
 * windows, restore them (focus restores — the 0014 rule) and clear it;
 * otherwise minimize-all and stash. Windows the user minimized before the
 * toggle are never in the stash, so they stay down across a restore. */
static void show_desktop_toggle(void) {
    int restored = 0;
    for (int i = 0; i < sd_nstash; i++) {
        win_t *w = find(sd_stash[i]);
        if (w && w->minimized) {
            int32_t a[1] = { sd_stash[i] };
            wmp_send(sock, WMP_FOCUS, a, 1);
            restored = 1;
        }
    }
    if (restored) { sd_nstash = 0; return; }
    min_all();
}

/* ---- Aero Snap (todos/0095) ---- */

/* Client rect for a snap edge in the CURRENT work area (screen minus
 * taskbar, below the kernel title bar — the 0025 maximize metrics).
 * Halves split the width; quarters also split the height, the bottom row
 * shifted down one TITLE_H so both stacked title bars stay reachable.
 * Edge 3 (top) is the full work area — used only for the preview; the
 * commit path routes top through maximize(). */
static void snap_rect(int edge, int32_t *x, int32_t *y, int32_t *w, int32_t *h) {
    int32_t ww = scr_w, wh = scr_h - BAR_H - TITLE_H;
    int32_t lw = ww / 2;
    int32_t qh = (wh - TITLE_H) / 2;
    int right = edge == 2 || edge == 5 || edge == 7;
    int bottom = edge == 6 || edge == 7;
    *x = right ? lw : 0;
    *w = edge == 3 ? ww : (right ? ww - lw : lw);
    *y = TITLE_H + (bottom ? qh + TITLE_H : 0);
    *h = edge == 3 ? wh : (edge >= 4 ? (bottom ? wh - qh - TITLE_H : qh) : wh);
}

/* Stash the floating rect once, on leaving the floating state — a snap of
 * an already-snapped/maximized window keeps the ORIGINAL rect, so any
 * later restore lands where the user left it (Win7). */
static void save_floating(win_t *w) {
    if (w->maximized || w->snapped) return;
    w->sx = w->x; w->sy = w->y;
    w->sw = w->resizable ? w->w : w->dst_w;
    w->sh = w->resizable ? w->h : w->dst_h;
}

/* Back to the saved floating rect — the restore half of the 0025 toggle,
 * shared by maximize-restore, Win+Down, and unsnap. */
static void restore_floating(win_t *w) {
    w->maximized = 0;
    w->snapped = 0;
    int32_t m[3] = { w->sid, w->sx, w->sy };
    wmp_send(sock, WMP_MOVE, m, 3);
    int32_t g[3] = { w->sid, w->sw, w->sh };
    wmp_send(sock, w->resizable ? WMP_RESIZE : WMP_SET_DST, g, 3);
}

/* Fill w's snap rect — the maximize() dispatch exactly: resizable gets
 * MOVE + RESIZE, fixed-size gets the aspect-fit SET_DST centered in the
 * box. Also re-run on EV_SCREEN while snapped (the maximize precedent). */
static void snap_place(win_t *w) {
    int32_t bx, by, bw, bh;
    snap_rect(w->snapped, &bx, &by, &bw, &bh);
    if (bw < 64 || bh < 64) return;    /* degenerate screen: skip */
    if (w->resizable) {
        int32_t m[3] = { w->sid, bx, by };
        wmp_send(sock, WMP_MOVE, m, 3);
        int32_t r[3] = { w->sid, bw, bh };
        wmp_send(sock, WMP_RESIZE, r, 3);
    } else {
        int32_t d[3] = { w->sid, 0, 0 };
        fit_dst(w, bw, bh, 0, &d[1], &d[2]);
        int32_t m[3] = { w->sid, bx + (bw - d[1]) / 2, by + (bh - d[2]) / 2 };
        wmp_send(sock, WMP_MOVE, m, 3);
        wmp_send(sock, WMP_SET_DST, d, 3);
    }
}

/* Snap w to an edge: top is the 0025 maximize (same state bit, so the
 * title-bar toggle and Win+Down restore it identically); the rest set the
 * per-window snap edge. The floating rect is saved on the way out of
 * floating and survives snap-to-snap moves. */
static void snap_to(win_t *w, int edge) {
    if (!w || w->w <= 0 || w->h <= 0) return;
    save_floating(w);
    if (edge == 3) {
        w->maximized = 1;
        w->snapped = 0;
        maximize(w);
        return;
    }
    w->snapped = edge;
    w->maximized = 0;
    snap_place(w);
}

/* EV_TITLE_ACTIVATE (title double-click or wmctl max, todos/0025): toggle.
 * First activate maximizes (saving the floating rect unless a snap already
 * did); the second restores it. */
static void title_activate(int32_t sid) {
    win_t *w = find(sid);
    if (!w || w->w <= 0 || w->h <= 0) return;
    if (!w->maximized) snap_to(w, 3);
    else restore_floating(w);
}

/* EV_SNAP_KEY (Win+arrow, or wmctl snap — todos/0095): drive the focused
 * window. Left/Right snap to halves — pressing toward the edge it already
 * holds wraps to the other side ("cycle across the edge"); Up maximizes;
 * Down restores a snapped/maximized window, minimizes a floating one. */
static void snap_key(int dir) {
    win_t *w = NULL;
    for (int i = 0; i < nwins; i++)
        if (wins[i].focused && !wins[i].minimized) { w = &wins[i]; break; }
    if (!w || w->w <= 0 || w->h <= 0) return;
    if (dir == 0) snap_to(w, w->snapped == 1 ? 2 : 1);
    else if (dir == 1) snap_to(w, w->snapped == 2 ? 1 : 2);
    else if (dir == 2) { if (!w->maximized) snap_to(w, 3); }
    else if (dir == 3) {
        if (w->maximized || w->snapped) restore_floating(w);
        else {
            int32_t a[1] = { w->sid };
            wmp_send(sock, WMP_MINIMIZE, a, 1);
        }
    }
}

static void snapprev_dismiss(void) {
    if (!snapprev_win) return;
    SDL_DestroyWindow(snapprev_win);
    snapprev_win = NULL;
    snapprev_surf = NULL;
    snapprev_sid = 0;
    snapprev_edge = 0;
}

/* Raise the snap preview for an edge zone (todos/0095): one borderless
 * SDL_WINDOW_TRANSPARENT window over the target's outer rect (client +
 * title band), translucent white fill under a stronger 2px border,
 * painted ONCE — the 0063 per-pixel-alpha composite does the translucency
 * in both compositors. Parks at its EV_CREATED echo on the top layer and
 * hands focus straight back (the peek pattern — the dragged window must
 * keep the focus it took at the title mousedown). */
static void snapprev_show(int edge) {
    if (snapprev_win && snapprev_edge == edge) return;   /* already up */
    snapprev_dismiss();
    int32_t bx, by, bw, bh;
    snap_rect(edge, &bx, &by, &bw, &bh);
    if (bw < 32 || bh < 32) return;    /* degenerate screen: no preview */
    snapprev_x = bx;
    snapprev_y = by - TITLE_H;         /* cover the would-be title band too */
    snapprev_w = bw;
    snapprev_h = bh + TITLE_H;
    snapprev_edge = edge;
    snapprev_win = SDL_CreateWindow("snappreview", snapprev_w, snapprev_h,
                                    SDL_WINDOW_BORDERLESS | SDL_WINDOW_TRANSPARENT);
    if (!snapprev_win) { snapprev_edge = 0; return; }
    snapprev_surf = SDL_GetWindowSurface(snapprev_win);
    uint32_t *px = (uint32_t *)snapprev_surf->pixels;
    uint32_t fillc = 0x50FFFFFFu, border = 0xC0FFFFFFu;  /* white, a=80 / a=192 */
    for (int j = 0; j < snapprev_h; j++)
        for (int i = 0; i < snapprev_w; i++)
            px[j * snapprev_w + i] =
                (j < 2 || j >= snapprev_h - 2 || i < 2 || i >= snapprev_w - 2)
                    ? border : fillc;
    SDL_UpdateWindowSurface(snapprev_win);
}

/* ---- the screensaver (todos/0096) ---- */

/* The marquee's glyph zoom for the current screen: the 5x7 font scaled to
 * a banner that reads across the room, clamped sane on tiny screens. */
static int saver_zoom(void) {
    int z = scr_h / 64;
    if (z < 2) z = 2;
    if (z > 8) z = 8;
    return z;
}

/* draw_text_s at an integer zoom — each font pixel becomes a z x z block.
 * Off-surface glyphs clip in fill_s, so the banner can enter and leave. */
static void draw_text_zoom(uint32_t *px, int sw, int sh, int x, int y,
                           const char *s, int z, uint32_t col) {
    for (; *s; s++, x += 6 * z) {
        if (x >= sw || x + 5 * z <= 0) continue;
        const uint8_t *g = glyph(*s);
        if (!g) continue;
        for (int r = 0; r < 7; r++)
            for (int c = 0; c < 5; c++)
                if (g[r] & (0x10 >> c))
                    fill_s(px, sw, sh, x + c * z, y + r * z, z, z, col);
    }
}

/* One star back to the far plane ("deep") or anywhere along the flight
 * path (the initial fill, so the field starts populated). */
static void star_respawn(int i, int deep) {
    star_x[i] = (float)(rand() % 2001 - 1000) / 1000.0f;
    star_y[i] = (float)(rand() % 2001 - 1000) / 1000.0f;
    star_z[i] = deep ? 1.0f : (float)(rand() % 950 + 50) / 1000.0f;
}

/* Tear the saver down and put focus back where it was. If the previously
 * focused window died meanwhile, the kernel's destroy-time focus fall
 * already picked someone — leave it be. */
static void saver_dismiss(void) {
    if (!saver_win) return;
    SDL_DestroyWindow(saver_win);
    saver_win = NULL;
    saver_surf = NULL;
    saver_sid = 0;
    if (saver_prev && find(saver_prev)) {
        int32_t f[1] = { saver_prev };
        wmp_send(sock, WMP_FOCUS, f, 1);
    }
    saver_prev = 0;
}

/* Raise the saver saver_cfg picks. Fullscreen borderless on the TOP layer
 * (the EV_CREATED echo parks it); the create-focus is deliberately KEPT —
 * unlike every other piece of wm furniture — so all keys land on the saver
 * and dismiss it. Any open popup furniture goes first: its geometry (and
 * the focus rules it relies on) must not fight the covering window. */
static void saver_show(void) {
    if (saver_win) return;
    if (strcasecmp(saver_cfg.saver, "marquee") == 0) saver_kind = 1;
    else if (strcasecmp(saver_cfg.saver, "starfield") == 0) saver_kind = 2;
    else return;                       /* 'none' (or a typo): nothing to run */
    menu_dismiss();
    run_dismiss();
    peek_dismiss();
    ctx_dismiss();
    date_dismiss();
    snapprev_dismiss();
    saver_prev = 0;
    for (int i = 0; i < nwins; i++)
        if (wins[i].focused && !wins[i].minimized) { saver_prev = wins[i].sid; break; }
    marq_x = scr_w;
    marq_y = (scr_h - 7 * saver_zoom()) / 2;
    for (int i = 0; i < SAVER_STARS; i++) star_respawn(i, 0);
    saver_win = SDL_CreateWindow("screensaver", scr_w, scr_h,
                                 SDL_WINDOW_BORDERLESS);
    if (!saver_win) return;
    saver_surf = SDL_GetWindowSurface(saver_win);
}

/* The once-a-second poll (off the frame tick): re-read the config — so a
 * Control Panel write applies without a wm restart — and ask the kernel
 * how idle the system is. The R_IDLE reply lands in idle_consume via the
 * drain; one request in flight at a time. */
static void saver_poll(void) {
    if (saver_win) return;
    sv_get(&saver_cfg);
    if (saver_cfg.timeout <= 0 || strcasecmp(saver_cfg.saver, "none") == 0)
        return;
    if (idle_pending) return;
    if (wmp_send(sock, WMP_GET_IDLE, NULL, 0) == 0) idle_pending = 1;
}

/* An R_IDLE reply landed (drain_socket routes every one here). Compare in
 * whole seconds — the poll is second-coarse anyway. */
static void idle_consume(wmp_hdr *h) {
    idle_pending = 0;
    int32_t ms = 0;
    if (h->plen < 4 || wmp_read_all(sock, &ms, 4) != 0) exit(1);
    if (wmp_skip(sock, h->plen - 4) != 0) exit(1);
    if (!saver_win && saver_cfg.timeout > 0 && ms / 1000 >= saver_cfg.timeout)
        saver_show();
}

/* EV_SAVER (wmctl saver / the Control Panel Preview, todos/0096): raise
 * the configured saver NOW. A 'none' config means there is nothing to
 * preview — the gesture is a no-op then. */
static void saver_force(void) {
    sv_get(&saver_cfg);
    saver_show();
}

/* One animation frame. Full black repaint every tick — the surface is the
 * whole screen, cheap at these sizes (doom pushes more pixels). */
static void draw_saver(void) {
    if (!saver_win) return;
    uint32_t *px = (uint32_t *)saver_surf->pixels;
    uint32_t black = rgb(0, 0, 0), white = rgb(255, 255, 255);
    fill_s(px, scr_w, scr_h, 0, 0, scr_w, scr_h, black);
    if (saver_kind == 1) {             /* the scrolling marquee */
        int z = saver_zoom();
        int bw = (int)strlen(saver_cfg.text) * 6 * z;
        draw_text_zoom(px, scr_w, scr_h, marq_x, marq_y, saver_cfg.text, z, white);
        marq_x -= 4;
        if (marq_x + bw < 0) {         /* wrapped: new pass, new height */
            marq_x = scr_w;
            int span = scr_h - 7 * z - 2 * DESK_MARGIN;
            marq_y = DESK_MARGIN + (span > 0 ? rand() % span : 0);
        }
    } else {                           /* the starfield flythrough */
        int cx = scr_w / 2, cy = scr_h / 2;
        for (int i = 0; i < SAVER_STARS; i++) {
            star_z[i] -= 0.008f;
            if (star_z[i] < 0.03f) star_respawn(i, 1);
            int sx = cx + (int)(star_x[i] / star_z[i] * (float)cx);
            int sy = cy + (int)(star_y[i] / star_z[i] * (float)cy);
            if (sx < 0 || sx >= scr_w || sy < 0 || sy >= scr_h) {
                star_respawn(i, 1);    /* flew past the rim: back deep */
                continue;
            }
            int size = star_z[i] < 0.15f ? 3 : star_z[i] < 0.4f ? 2 : 1;
            int v = 255 - (int)(star_z[i] * 200.0f);
            fill_s(px, scr_w, scr_h, sx, sy, size, size, rgb(v, v, v));
        }
    }
    SDL_UpdateWindowSurface(saver_win);
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
        sm_record_recent(path);                  /* MRU recents (0098) */
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
    /* The Recycle Bin pins to the grid's TAIL (todos/0093): every other
     * icon keeps its pre-0093 sorted cell, and the bin sits below/after
     * everything the way Win95 keeps it apart. (Shared with the Start
     * menu, where no entry carries this name.) */
    int ra = strcmp(ea->name, "Recycle Bin") == 0;
    int rb = strcmp(eb->name, "Recycle Bin") == 0;
    if (ra != rb) return ra - rb;
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

/* ---- the Start menu flyout columns (todos/0078; the two-pane root that
 * anchors them is todos/0098, further down) ---- */

/* Row bookkeeping for a flyout column (depth >= 1: pure entry lists). The
 * depth==0 arithmetic is retained but dead — the two-pane root does its
 * own hit-testing (sm_root_hit). */
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

static void sm_rebuild_left(void);        /* build the root's left pane (0098) */

/* Open the column at `depth` listing `dir`. Depth 0 is the Win7 two-pane
 * root (fixed size, parked bottom-left above the taskbar; its left pane
 * comes from sm_rebuild_left, and `dir` is remembered as the tree root
 * for search / All Programs); depth >= 1 are single-column flyouts parked
 * at (px, py) clamped on-screen. The window parks when its EV_CREATED echo
 * arrives (title "startmenu" for the root, "startmenu<depth+1>" deeper —
 * see handle_event). Returns 1 if live. */
static int menu_open_col(int depth, const char *dir, int px, int py) {
    if (depth >= MENU_DEPTH) return 0;
    menu_col *c = &mcol[depth];
    if (depth == 0) {                          /* the two-pane root (0098) */
        snprintf(c->dir, sizeof c->dir, "%s", dir);   /* the tree root */
        sm_search[0] = 0; sm_search_len = 0;
        sm_lhover = -1; sm_rhover = -1;
        sm_rebuild_left();
        c->w = SM_ROOT_W;
        c->h = SM_ROOT_H;
        c->x = 0;
        c->y = scr_h - BAR_H - c->h;
        c->win = SDL_CreateWindow("startmenu", c->w, c->h, SDL_WINDOW_BORDERLESS);
        if (!c->win) return 0;
        c->surf = SDL_GetWindowSurface(c->win);
        c->sid = 0;
        mdepth = 1;
        return 1;
    }
    c->n = load_entries(dir, c->ents, MAX_MENU);
    if (c->n == 0) return 0;                    /* an empty group: nothing */
    snprintf(c->dir, sizeof c->dir, "%s", dir);
    c->hover = -1;
    c->open_child = -1;
    c->w = MENU_W;
    c->h = 2 * MENU_PAD + c->n * MENU_ENTRY_H;
    c->x = px;
    c->y = py;
    if (c->x + c->w > scr_w) c->x = scr_w - c->w;
    if (c->y + c->h > scr_h - BAR_H) c->y = scr_h - BAR_H - c->h;
    if (c->y < 0) c->y = 0;
    char title[16];
    snprintf(title, sizeof title, "startmenu%d", depth + 1);
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

/* ---- Win7 two-pane root: recents, pins, live search (todos/0098) ---- */

static const char *sm_home(void) {
    const char *h = getenv("HOME");
    return (h && *h) ? h : "/root";    /* kernel services run env-less */
}

/* Case-insensitive substring test (the 0078 type-ahead generalized). */
static int sm_name_matches(const char *name, const char *q) {
    if (!*q) return 1;
    for (const char *p = name; *p; p++) {
        const char *a = p, *b = q;
        while (*a && *b) {
            char ca = *a >= 'A' && *a <= 'Z' ? (char)(*a + 32) : *a;
            char cb = *b >= 'A' && *b <= 'Z' ? (char)(*b + 32) : *b;
            if (ca != cb) break;
            a++; b++;
        }
        if (!*b) return 1;
    }
    return 0;
}

/* Push `path` to the head of the MRU recents file (~/.config/recent),
 * de-duplicated, capped at RECENT_MAX. activate() calls this on every real
 * program launch — menu, desktop, or run dialog all flow through it, so
 * "recent programs" spans the whole shell (todos/0098). */
static void sm_record_recent(const char *path) {
    if (!path || !*path) return;
    char cfg[300], file[320];
    snprintf(cfg, sizeof cfg, "%s/.config", sm_home());
    mkdir(cfg, 0755);                            /* ignore EEXIST */
    snprintf(file, sizeof file, "%s/recent", cfg);
    char keep[RECENT_MAX][256];
    int nkeep = 0;
    FILE *f = fopen(file, "r");
    if (f) {
        char line[256];
        while (fgets(line, sizeof line, f) && nkeep < RECENT_MAX - 1) {
            size_t l = strlen(line);
            while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
            if (!line[0] || strcmp(line, path) == 0) continue;
            snprintf(keep[nkeep++], 256, "%s", line);
        }
        fclose(f);
    }
    FILE *w = fopen(file, "w");
    if (!w) return;
    fprintf(w, "%s\n", path);                    /* newest first */
    for (int i = 0; i < nkeep; i++) fprintf(w, "%s\n", keep[i]);
    fclose(w);
}

/* Add existing one-path-per-line entries of `file` as left-pane items of
 * `kind` (topmost first), reserving the final slot for All Programs.
 * Missing files / vanished paths are skipped silently. */
static void sm_load_list(const char *file, int kind) {
    FILE *f = fopen(file, "r");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof line, f) && sm_nleft < SM_LEFT_ROWS - 1) {
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
        if (!line[0]) continue;
        struct stat st;
        if (stat(line, &st) != 0) continue;      /* gone: drop it */
        sm_item *it = &sm_left[sm_nleft++];
        const char *base = strrchr(line, '/');
        base = base ? base + 1 : line;
        snprintf(it->name, sizeof it->name, "%s", base);
        snprintf(it->path, sizeof it->path, "%s", line);
        it->kind = kind;
    }
    fclose(f);
}

/* Recursive flat walk of the menu tree, collecting leaf launchers whose
 * filename matches the query. Fills in readdir order, capped at the pane;
 * groups (dirs / links to dirs) recurse. */
static void sm_search_walk(const char *dir, const char *q, int depth) {
    if (depth > MENU_DEPTH || sm_nleft >= SM_LEFT_ROWS) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) && sm_nleft < SM_LEFT_ROWS) {
        if (de->d_name[0] == '.') continue;
        char path[512];
        snprintf(path, sizeof path, "%s/%s", dir, de->d_name);
        struct stat st;
        if (lstat(path, &st) != 0) continue;
        int isdir = S_ISDIR(st.st_mode);
        if (S_ISLNK(st.st_mode)) {
            struct stat s2;
            isdir = stat(path, &s2) == 0 && S_ISDIR(s2.st_mode);
        }
        if (isdir) { sm_search_walk(path, q, depth + 1); continue; }
        if (!sm_name_matches(de->d_name, q)) continue;
        sm_item *it = &sm_left[sm_nleft++];
        snprintf(it->name, sizeof it->name, "%s", de->d_name);
        snprintf(it->path, sizeof it->path, "%s", path);
        it->kind = SMI_RESULT;
    }
    closedir(d);
}

/* Rebuild the left-pane item list. Search mode (query non-empty): the flat
 * tree walk (and the tree flyout is meaningless, so close it). Browse mode:
 * pinned entries, then MRU recents, then the All Programs row. */
static void sm_rebuild_left(void) {
    sm_nleft = 0;
    if (sm_search_len > 0) {
        menu_close_from(1);
        sm_search_walk(mcol[0].dir, sm_search, 0);
        return;
    }
    char pin[320], rec[320];
    snprintf(pin, sizeof pin, "%s/.config/pinned", sm_home());
    snprintf(rec, sizeof rec, "%s/.config/recent", sm_home());
    sm_load_list(pin, SMI_PIN);
    sm_load_list(rec, SMI_RECENT);
    if (sm_nleft < SM_LEFT_ROWS) {
        sm_item *it = &sm_left[sm_nleft++];
        snprintf(it->name, sizeof it->name, "%s", "All Programs");
        it->path[0] = 0;
        it->kind = SMI_ALLPROGS;
    }
}

/* Cascade the menu tree as a flyout to the right of the two-pane root,
 * aligned to the All Programs row. The flyout lists mcol[0].dir (the tree
 * root); its groups cascade further via the ordinary flyout machinery. */
static void sm_open_allprogs(void) {
    int row = -1;
    for (int i = 0; i < sm_nleft; i++)
        if (sm_left[i].kind == SMI_ALLPROGS) { row = i; break; }
    if (row < 0) return;
    menu_close_from(1);
    menu_open_col(1, mcol[0].dir, mcol[0].x + SM_ROOT_W - 3,
                  mcol[0].y + row * SM_ROW_H);
}

/* Pane/row under a root-window point. Returns 0 left item, 1 right fixed
 * item, 2 the search box, -1 dead zone; the row index lands in *row. */
static int sm_root_hit(int x, int y, int *row) {
    if (x < SM_LEFT_W) {
        if (y >= SM_SEARCH_Y) return 2;          /* the search box strip */
        int i = (y - SM_PAD) / SM_ROW_H;
        if (y >= SM_PAD && i >= 0 && i < sm_nleft) { *row = i; return 0; }
        return -1;
    }
    int i = (y - SM_PAD) / SM_ROW_H;
    if (y >= SM_PAD && i >= 0 && i < MENU_FIXED) { *row = i; return 1; }
    return -1;
}

/* Launch a left-pane row: All Programs cascades; everything else is a path
 * through the shared activate() (which records the recent). */
static void sm_left_activate(int row) {
    if (row < 0 || row >= sm_nleft) return;
    sm_item *it = &sm_left[row];
    if (it->kind == SMI_ALLPROGS) { sm_open_allprogs(); return; }
    char path[256];
    snprintf(path, sizeof path, "%s", it->path);
    menu_dismiss();
    activate(path);
}

static void sm_right_activate(int row) {
    menu_dismiss();
    if (row == 0) activate("/bin/ctlpanel");     /* SETTINGS */
    else run_open();                             /* RUN... */
}

static void sm_root_click(int x, int y) {
    int row = -1;
    int pane = sm_root_hit(x, y, &row);
    if (pane == 0) { sm_lhover = row; sm_left_activate(row); }
    else if (pane == 1) sm_right_activate(row);
    /* pane 2 (search box) / -1 (dead zone): a click INSIDE the menu keeps
     * it open — only an outside click / focus loss dismisses (Win7). */
}

static void sm_root_motion(int x, int y) {
    int row = -1;
    int pane = sm_root_hit(x, y, &row);
    sm_lhover = pane == 0 ? row : -1;
    sm_rhover = pane == 1 ? row : -1;
    if (pane == 0 && sm_left[row].kind == SMI_ALLPROGS && mdepth < 2)
        sm_open_allprogs();
}

/* Keyboard while only the root is open (todos/0098): printable keys type
 * into the search box (filtering the tree live), arrows walk the left
 * pane, Enter launches the cursor row (the top hit in search mode), Right
 * cascades All Programs, Esc clears the search then closes. When a flyout
 * is open the deeper column owns the keys (menu_key routes there). */
static void sm_root_key(int sym) {
    if (sym == SDLK_ESCAPE) {
        if (sm_search_len > 0) {
            sm_search[0] = 0; sm_search_len = 0;
            sm_rebuild_left(); sm_lhover = -1;
        } else menu_dismiss();
        return;
    }
    if (sym == SDLK_DOWN || sym == SDLK_UP) {
        if (sm_nleft == 0) return;
        int d = sym == SDLK_DOWN ? 1 : -1;
        sm_lhover = sm_lhover < 0 ? (d > 0 ? 0 : sm_nleft - 1)
                                  : (sm_lhover + d + sm_nleft) % sm_nleft;
        return;
    }
    if (sym == SDLK_RIGHT) {
        if (sm_lhover >= 0 && sm_lhover < sm_nleft &&
            sm_left[sm_lhover].kind == SMI_ALLPROGS) {
            sm_open_allprogs();
            if (mdepth > 1) mcol[1].hover = 0;
        }
        return;
    }
    if (sym == SDLK_RETURN) {
        int row = sm_lhover >= 0 ? sm_lhover : (sm_nleft > 0 ? 0 : -1);
        sm_left_activate(row);
        return;
    }
    if (sym == SDLK_BACKSPACE) {
        if (sm_search_len > 0) {
            sm_search[--sm_search_len] = 0;
            sm_rebuild_left();
            sm_lhover = sm_nleft > 0 ? 0 : -1;
        }
        return;
    }
    if (sym >= 32 && sym < 127 && sm_search_len < (int)sizeof sm_search - 1) {
        sm_search[sm_search_len++] = (char)sym;
        sm_search[sm_search_len] = 0;
        sm_rebuild_left();
        sm_lhover = sm_nleft > 0 ? 0 : -1;       /* preselect the top hit */
    }
}

static void draw_root_menu(void) {
    menu_col *c = &mcol[0];
    if (!c->win) return;
    int w = SM_ROOT_W, h = SM_ROOT_H;
    uint32_t *px = (uint32_t *)c->surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0),
             sel = rgb(0, 0, 128), seltxt = rgb(255, 255, 255),
             rband = rgb(176, 176, 176), white = rgb(255, 255, 255),
             ghost = rgb(128, 128, 128);
    fill_s(px, w, h, 0, 0, w, h, face);
    /* raised outer edge (Win95 chrome carried over) */
    fill_s(px, w, h, 0, 0, w, 1, hi);
    fill_s(px, w, h, 0, 0, 1, h, hi);
    fill_s(px, w, h, 0, h - 1, w, 1, sh);
    fill_s(px, w, h, w - 1, 0, 1, h, sh);
    /* right pane band + the divider between the panes */
    fill_s(px, w, h, SM_LEFT_W, 1, SM_RIGHT_W - 1, h - 2, rband);
    fill_s(px, w, h, SM_LEFT_W, 1, 1, h - 2, sh);
    fill_s(px, w, h, SM_LEFT_W + 1, 1, 1, h - 2, hi);
    /* left pane items */
    for (int i = 0; i < sm_nleft; i++) {
        int y = SM_PAD + i * SM_ROW_H;
        int hl = i == sm_lhover;
        if (hl) fill_s(px, w, h, 2, y, SM_LEFT_W - 4, SM_ROW_H, sel);
        if (sm_left[i].kind == SMI_ALLPROGS && i > 0) {   /* groove above it */
            fill_s(px, w, h, 6, y - 1, SM_LEFT_W - 12, 1, sh);
        }
        draw_text_s(px, w, h, 10, y + (SM_ROW_H - 7) / 2, sm_left[i].name,
                    hl ? seltxt : txt);
        if (sm_left[i].kind == SMI_ALLPROGS) {            /* cascade arrow */
            int ax = SM_LEFT_W - 12, ay = y + (SM_ROW_H - 7) / 2;
            for (int t = 0; t < 4; t++)
                fill_s(px, w, h, ax + t, ay + t, 1, 7 - 2 * t, hl ? seltxt : txt);
        }
    }
    /* the search box (sunken white field) at the foot of the left pane */
    int bx = SM_PAD, by = SM_SEARCH_Y, bw = SM_LEFT_W - 2 * SM_PAD,
        bh = SM_SEARCH_H - 2;
    fill_s(px, w, h, bx, by, bw, bh, white);
    fill_s(px, w, h, bx, by, bw, 1, sh);
    fill_s(px, w, h, bx, by, 1, bh, sh);
    if (sm_search_len > 0) {
        int maxn = (bw - 8) / 6;
        const char *s = sm_search_len > maxn ? sm_search + (sm_search_len - maxn)
                                             : sm_search;
        draw_text_s(px, w, h, bx + 4, by + (bh - 7) / 2, s, txt);
        fill_s(px, w, h, bx + 4 + (int)strlen(s) * 6, by + (bh - 9) / 2, 2, 9, txt);
    } else {
        draw_text_s(px, w, h, bx + 4, by + (bh - 7) / 2, "Search", ghost);
    }
    /* right pane: the fixed places column */
    for (int i = 0; i < MENU_FIXED; i++) {
        int y = SM_PAD + i * SM_ROW_H;
        int hl = i == sm_rhover;
        if (hl) fill_s(px, w, h, SM_LEFT_W + 4, y, SM_RIGHT_W - 8, SM_ROW_H, sel);
        draw_text_s(px, w, h, SM_LEFT_W + 12, y + (SM_ROW_H - 7) / 2,
                    menu_fixed[i], hl ? seltxt : txt);
    }
    SDL_UpdateWindowSurface(c->win);
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
    if (depth == 0) { sm_root_key(sym); return; }   /* the two-pane root (0098) */
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
    if (depth == 0) { draw_root_menu(); return; }   /* the two-pane root (0098) */
    menu_col *c = &mcol[depth];
    if (!c->win) return;
    int w = c->w, h = c->h;
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
    for (int i = 0; i < c->n; i++) {
        int y = MENU_PAD + i * MENU_ENTRY_H;
        int hl = i == c->hover || i == c->open_child;
        if (hl) fill_s(px, w, h, 2, y, w - 4, MENU_ENTRY_H, sel);
        draw_text_s(px, w, h, 10, y + (MENU_ENTRY_H - 7) / 2, c->ents[i].name,
                    hl ? seltxt : txt);
        if (c->ents[i].is_dir) {   /* the flyout arrow */
            int ax = w - 10, ay = y + (MENU_ENTRY_H - 7) / 2;
            for (int t = 0; t < 4; t++)
                fill_s(px, w, h, ax + t, ay + t, 1, 7 - 2 * t,
                       hl ? seltxt : txt);
        }
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
    if (desk_edit >= 0) return;        /* nor under an inline rename (0103) —
                                          the edited index must stay valid */
    int tf = fo_trash_count() > 0;     /* bin glyph state (todos/0093) */
    if (tf != desk_trash_full) { desk_trash_full = tf; desk_dirty = 1; }
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
    desk_edit = -1;                    /* ...and any inline rename (0103) */
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

/* Carry a 0077 .icons placement across a rename (todos/0103): rewrite the
 * matching "col row name" line's name in place so the renamed icon keeps its
 * cell. No-op if the file or the entry is absent — the icon just auto-flows
 * under its new name (the "if present" the 0103 plan calls for). */
static void desk_icons_rename(const char *oldn, const char *newn) {
    FILE *f = fopen("/root/Desktop/.icons", "r");
    if (!f) return;
    static char out[MAX_DESK * 320];   /* off the 64KB wasm stack */
    size_t olen = 0;
    char line[320];
    int hit = 0;
    while (fgets(line, sizeof line, f)) {
        int c, r, off = -1;
        char *keep = line;
        if (sscanf(line, "%d %d %n", &c, &r, &off) >= 2 && off >= 0) {
            char name[300];
            snprintf(name, sizeof name, "%s", line + off);
            size_t l = strlen(name);
            while (l > 0 && (name[l - 1] == '\n' || name[l - 1] == '\r'))
                name[--l] = 0;
            if (strcmp(name, oldn) == 0) {
                char nl[320];
                int m = snprintf(nl, sizeof nl, "%d %d %s\n", c, r, newn);
                if (m > 0 && olen + (size_t)m < sizeof out) {
                    memcpy(out + olen, nl, (size_t)m);
                    olen += (size_t)m;
                }
                hit = 1;
                continue;
            }
        }
        size_t l = strlen(keep);
        if (olen + l < sizeof out) { memcpy(out + olen, keep, l); olen += l; }
    }
    fclose(f);
    if (!hit) return;                  /* nothing pinned: leave the file alone */
    f = fopen("/root/Desktop/.icons", "w");
    if (!f) return;
    fwrite(out, 1, olen, f);
    fclose(f);
}

/* Open the inline rename editor on icon idx (todos/0103). The Recycle Bin is
 * never renamable (wm.c recreates it every start). Seeds the buffer with the
 * current name and takes desktop focus so the following keys route here. */
static void desk_edit_start(int idx) {
    if (idx < 0 || idx >= desk_n) return;
    if (strcmp(desk[idx].name, "Recycle Bin") == 0) return;
    desk_edit = idx;
    snprintf(desk_ebuf, sizeof desk_ebuf, "%s", desk[idx].name);
    desk_elen = (int)strlen(desk_ebuf);
    desk_selmask = 1ULL << idx;
    desk_anchor = idx;
    /* F2 path: the desktop already holds focus, so no EV_FOCUS(desk) is
     * coming — arm now. Menu path (desk_focused 0, the ctxmenu had it): arm
     * when our WMP_FOCUS's EV_FOCUS(desk) lands, not on the dismiss fall. */
    desk_edit_armed = desk_focused;
    desk_focused = 1;
    if (desk_sid) { int32_t f[1] = { desk_sid }; wmp_send(sock, WMP_FOCUS, f, 1); }
    desk_dirty = 1;
}

static void desk_edit_cancel(void) {
    if (desk_edit < 0) return;
    desk_edit = -1;
    desk_dirty = 1;
}

/* Commit the rename (todos/0103): refuse empty / '/'-bearing names and leave
 * the editor open (the beep-equivalent — no dialog furniture here); an
 * unchanged name just closes it. rename(2) on /root/Desktop, but refuse to
 * clobber an existing target (both files kept, editor stays open — EEXIST),
 * then carry the .icons placement and reload the grid. */
static void desk_edit_commit(void) {
    if (desk_edit < 0) return;
    int idx = desk_edit;
    if (idx >= desk_n) { desk_edit = -1; return; }
    if (desk_elen == 0 || strchr(desk_ebuf, '/')) return;   /* keep open */
    if (strcmp(desk_ebuf, desk[idx].name) == 0) {           /* no change */
        desk_edit = -1; desk_dirty = 1; return;
    }
    char oldn[256];
    snprintf(oldn, sizeof oldn, "%s", desk[idx].name);
    char oldp[300], newp[300];
    snprintf(oldp, sizeof oldp, "/root/Desktop/%s", oldn);
    snprintf(newp, sizeof newp, "/root/Desktop/%s", desk_ebuf);
    struct stat st;
    if (lstat(newp, &st) == 0) return;   /* target exists: keep both, stay open */
    if (rename(oldp, newp) != 0) {
        fprintf(stderr, "wm: rename '%s' -> '%s' failed: %s\n",
                oldp, newp, strerror(errno));
        return;                          /* keep the editor open */
    }
    desk_icons_rename(oldn, desk_ebuf);
    desk_edit = -1;
    desk_load();                         /* picks up the new name immediately */
    desk_dirty = 1;
}

/* Commit-if-valid, else discard — the click-away / focus-loss path where an
 * invalid name can't just linger the editor open off-screen (todos/0103). */
static void desk_edit_finish(void) {
    if (desk_edit < 0) return;
    desk_edit_commit();
    if (desk_edit >= 0) desk_edit_cancel();
}

static void desk_key(int sym) {
    if (desk_edit >= 0) {              /* inline rename editor owns the keys */
        if (sym == SDLK_ESCAPE) { desk_edit_cancel(); return; }
        if (sym == SDLK_RETURN) { desk_edit_commit(); return; }
        if (sym == SDLK_BACKSPACE) {
            if (desk_elen > 0) { desk_ebuf[--desk_elen] = 0; desk_dirty = 1; }
            return;
        }
        if (sym >= 32 && sym < 127 && desk_elen < (int)sizeof desk_ebuf - 1) {
            desk_ebuf[desk_elen++] = (char)sym;
            desk_ebuf[desk_elen] = 0;
            desk_dirty = 1;
        }
        return;                        /* modal: swallow everything else */
    }
    if (sym == SDLK_F2) {              /* rename the lone selection (0103) */
        if (desk_selmask && !(desk_selmask & (desk_selmask - 1))) {
            int i = 0;
            while (!(desk_selmask >> i & 1)) i++;
            desk_edit_start(i);
        }
        return;
    }
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
    if (sym == SDLK_DELETE) { desk_delete(); return; }   /* to the bin (0093) */
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
         * black launcher notch at the bottom-left (the Win95 arrow). The
         * Recycle Bin (todos/0093) draws a basket instead — hollow when
         * empty, contents block when the store holds entries (the probe
         * pixel is the tile center: white empty, navy full). */
        fill_s(px, w, h, ix, iy, ICON_W, ICON_W, white);
        if (strcmp(desk[i].name, "Recycle Bin") == 0) {
            fill_s(px, w, h, ix + 3, iy + 3, ICON_W - 6, 2, navy);   /* rim */
            fill_s(px, w, h, ix + 5, iy + 5, 2, ICON_W - 10, navy);  /* walls */
            fill_s(px, w, h, ix + ICON_W - 7, iy + 5, 2, ICON_W - 10, navy);
            fill_s(px, w, h, ix + 5, iy + ICON_W - 7, ICON_W - 10, 2, navy);
            if (desk_trash_full)
                fill_s(px, w, h, ix + 8, iy + 8, ICON_W - 16, ICON_W - 16, navy);
        } else {
            fill_s(px, w, h, ix + 6, iy + 6, ICON_W - 12, ICON_W - 12, navy);
        }
        if (desk[i].is_link)
            fill_s(px, w, h, ix + 2, iy + ICON_W - 8, 6, 6, black);
        if (i == desk_edit) {          /* inline rename editor (todos/0103):
                                          a sunken white box + black text +
                                          caret over the label cell, sized to
                                          the tail that fits and clamped on. */
            int vis = desk_elen > 18 ? 18 : desk_elen;
            const char *tail = desk_elen > 18 ? desk_ebuf + (desk_elen - 18)
                                              : desk_ebuf;
            int bw = vis * 6 + 8;
            int bx = cx + (CELL_W - bw) / 2, by = cy + ICON_W + 6;
            if (bx < 0) bx = 0;
            if (bx + bw > w) bx = w - bw;
            fill_s(px, w, h, bx, by, bw, 13, white);
            rect_s(px, w, h, bx, by, bw, 13, black);
            char eb[19];
            memcpy(eb, tail, (size_t)vis);
            eb[vis] = 0;
            draw_text_s(px, w, h, bx + 3, by + 3, eb, black);
            fill_s(px, w, h, bx + 3 + vis * 6, by + 2, 2, 9, black);   /* caret */
            continue;
        }
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
    sys_mode = 0;                  /* any dismiss ends a move/size (0102) */
    sys_target = 0;
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
 * (todos/0092 — the same format-2 clipboard file list fileman pastes)
 * + Delete to the Recycle Bin (todos/0093) + Rename (todos/0103, the inline
 * label editor — dir launchers rename like any file, the link name IS label).
 * The Recycle Bin icon itself gets its own menu: Open + Empty Recycle
 * Bin (grayed when the store is empty; unconfirmed by design — this
 * process has no dialog furniture, fileman's Empty confirms). */
static void ctx_open_icon(int idx, int x, int y) {
    ctx_dismiss();
    ctx_icon = idx;
    ctx_nent[0] = 0;
    if (strcmp(desk[idx].name, "Recycle Bin") == 0) {
        ctx_add(0, "OPEN", CM_OPEN, 0);
        ctx_add(0, "", CM_NONE, CTF_SEP);
        ctx_add(0, "EMPTY RECYCLE BIN", CM_EMPTY,
                desk_trash_full ? 0 : CTF_GRAY);
    } else {
        ctx_add(0, "OPEN", CM_OPEN, 0);
        ctx_add(0, "", CM_NONE, CTF_SEP);
        ctx_add(0, "CUT", CM_CUT, 0);
        ctx_add(0, "COPY", CM_COPY, 0);
        ctx_add(0, "DELETE", CM_DELETE, 0);
        ctx_add(0, "RENAME", CM_RENAME, 0);        /* the inline editor (0103) */
    }
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
        if (strcmp(desk[i].name, "Recycle Bin") == 0) continue;   /* not a
                                          movable object (0093) */
        snprintf(bufs[n], sizeof bufs[n], "/root/Desktop/%s", desk[i].name);
        paths[n] = bufs[n];
        n++;
    }
    if (n && fo_clip_set(cut, paths, n) != 0)
        fprintf(stderr, "wm: clipboard set failed: %s\n", strerror(errno));
}

/* Delete the selection to the Recycle Bin (todos/0093 — recoverable, so
 * no confirm; wm.c has no dialog furniture anyway). The bin itself is
 * skipped; errors go to the service log, the fileman precedent. */
static void desk_delete(void) {
    for (int i = 0; i < desk_n && i < MAX_DESK; i++) {
        if (!(desk_selmask >> i & 1)) continue;
        if (strcmp(desk[i].name, "Recycle Bin") == 0) continue;
        char path[300];
        snprintf(path, sizeof path, "/root/Desktop/%s", desk[i].name);
        if (fo_trash(path) != 0)
            fprintf(stderr, "wm: delete '%s' failed: %s\n", path,
                    strerror(errno));
    }
    desk_load();
    desk_dirty = 1;
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
            (w->minimized || w->maximized || w->snapped) ? 0 : CTF_GRAY);
    ctx_add(0, "MINIMIZE", CM_MINIMIZE, w->minimized ? CTF_GRAY : 0);
    ctx_add(0, "MAXIMIZE", CM_MAXIMIZE,
            (w->maximized || w->minimized) ? CTF_GRAY : 0);
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "CLOSE", CM_CLOSE, 0);
    ctx_openwin(0, bx, scr_h);         /* clamp parks it above the bar */
}

/* Right-click the empty taskbar strip (todos/0101): the Win95 bar menu —
 * window-arrangement policy this process owns, plus Properties -> the
 * ctlpanel hub (todos/0089). Anchored at the click x, parked above the bar
 * by the ctx_openwin clamp. */
static void ctx_open_taskbar(int bx) {
    ctx_dismiss();
    ctx_target = 0;
    ctx_nent[0] = 0;
    ctx_add(0, "CASCADE", CM_CASCADE, 0);
    ctx_add(0, "TILE", CM_TILE, 0);
    ctx_add(0, "MINIMIZE ALL", CM_MIN_ALL, 0);
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "PROPERTIES", CM_PROPERTIES, 0);
    ctx_openwin(0, bx, scr_h);
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

/* The window system menu (todos/0102): the Win95 Alt+Space menu — the
 * taskbar-button menu (0101) plus Move/Size rows — anchored at the target
 * window's top-left. Rows gray per the window's state: Restore only when
 * off the floating rect, Move/Maximize disabled while minimized, Size only
 * on a resizable window (fixed-size scales by pointer, 0024), Maximize off
 * when already maximized. */
static void ctx_open_sysmenu(const win_t *w) {
    ctx_dismiss();
    ctx_target = w->sid;
    ctx_icon = -1;
    ctx_nent[0] = 0;
    ctx_add(0, "RESTORE", CM_RESTORE,
            (w->minimized || w->maximized || w->snapped) ? 0 : CTF_GRAY);
    ctx_add(0, "MOVE", CM_MOVE, w->minimized ? CTF_GRAY : 0);
    ctx_add(0, "SIZE", CM_SIZE, (w->minimized || !w->resizable) ? CTF_GRAY : 0);
    ctx_add(0, "MINIMIZE", CM_MINIMIZE, w->minimized ? CTF_GRAY : 0);
    ctx_add(0, "MAXIMIZE", CM_MAXIMIZE,
            (w->maximized || w->minimized) ? CTF_GRAY : 0);
    ctx_add(0, "", CM_NONE, CTF_SEP);
    ctx_add(0, "CLOSE", CM_CLOSE, 0);
    /* Anchor just under the title bar's top-left; the ctx_openwin clamp
     * keeps it on-screen (right/bottom edges). */
    ctx_openwin(0, w->x, w->y);
}

/* End a keyboard move/size (todos/0102): optionally revert to the stashed
 * rect, tear the popup grabber down, and hand focus back to the window we
 * were driving (the popup took it at open). */
static void sys_end(int revert) {
    win_t *w = find(sys_target);
    if (revert && w) {
        if (sys_mode == 1) {
            int32_t g[3] = { w->sid, sys_x0, sys_y0 };
            wmp_send(sock, WMP_MOVE, g, 3);
            w->x = sys_x0; w->y = sys_y0;
        } else {
            int32_t g[3] = { w->sid, sys_w0, sys_h0 };
            wmp_send(sock, WMP_RESIZE, g, 3);
            w->w = sys_w0; w->h = sys_h0;
        }
    }
    int32_t tgt = sys_target;
    sys_mode = 0;
    sys_target = 0;
    ctx_dismiss();
    if (find(tgt)) {
        int32_t f[1] = { tgt };
        wmp_send(sock, WMP_FOCUS, f, 1);
    }
}

/* Enter a keyboard move (1) or size (2) mode from the sysmenu (todos/0102).
 * The popup stays up as the key grabber (do NOT dismiss); arrows nudge the
 * target. Size is refused on a fixed-size window (its row is grayed anyway,
 * so this is defensive). */
static void sys_enter(int mode) {
    win_t *w = find(ctx_target);
    if (!w || w->w <= 0 || w->h <= 0) { ctx_dismiss(); return; }
    if (mode == 2 && !w->resizable) return;
    sys_mode = mode;
    sys_target = w->sid;
    sys_x0 = w->x; sys_y0 = w->y; sys_w0 = w->w; sys_h0 = w->h;
}

/* Arrow-key nudge while a move/size mode is live (todos/0102). Enter
 * commits, Esc reverts; the ordinary MOVE/RESIZE ops drive it (the echo
 * re-syncs the model). Non-arrow keys are swallowed so the mode stays
 * modal — only Enter/Esc leave it. */
static void sys_key(int sym) {
    win_t *w = find(sys_target);
    if (!w) { sys_end(0); return; }
    if (sym == SDLK_ESCAPE) { sys_end(1); return; }
    if (sym == SDLK_RETURN) { sys_end(0); return; }
    int dx = 0, dy = 0;
    if (sym == SDLK_LEFT) dx = -SYS_STEP;
    else if (sym == SDLK_RIGHT) dx = SYS_STEP;
    else if (sym == SDLK_UP) dy = -SYS_STEP;
    else if (sym == SDLK_DOWN) dy = SYS_STEP;
    else return;
    if (sys_mode == 1) {
        int32_t g[3] = { w->sid, w->x + dx, w->y + dy };
        wmp_send(sock, WMP_MOVE, g, 3);
        w->x += dx; w->y += dy;
    } else {
        int nw = w->w + dx, nh = w->h + dy;
        if (nw < SYS_MIN_W) nw = SYS_MIN_W;
        if (nh < SYS_MIN_H) nh = SYS_MIN_H;
        int32_t g[3] = { w->sid, nw, nh };
        wmp_send(sock, WMP_RESIZE, g, 3);
        w->w = nw; w->h = nh;
    }
}

/* Fire row i of column d. Grayed/separator rows never fire; sub rows
 * cascade. Real commands snapshot their argument, dismiss, then act —
 * dismissal first so a spawned child's create-focus finds no popup. */
static void ctx_activate(int d, int i) {
    if (i < 0 || i >= ctx_nent[d]) return;
    ctx_ent *e = &ctx_ents[d][i];
    if (e->flags & (CTF_SEP | CTF_GRAY)) return;
    if (e->flags & CTF_SUB) { ctx_open_flyout(i); return; }
    /* Move/Size keep the popup as the key grabber — enter the mode instead
     * of dismissing (todos/0102). Everything else dismisses then acts. */
    if (e->id == CM_MOVE) { sys_enter(1); return; }
    if (e->id == CM_SIZE) { sys_enter(2); return; }
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
    case CM_RENAME: desk_edit_start(icon); break;   /* 0103: inline editor */
    case CM_CUT: desk_clip(1); break;            /* 0092 */
    case CM_COPY: desk_clip(0); break;
    case CM_PASTE: desk_paste(); break;
    case CM_DELETE: desk_delete(); break;        /* 0093: to the bin */
    case CM_EMPTY:                               /* 0093: the bin's menu */
        if (fo_trash_empty() != 0)
            fprintf(stderr, "wm: empty recycle bin failed: %s\n",
                    strerror(errno));
        desk_load();
        desk_dirty = 1;
        break;
    case CM_RESTORE: {
        win_t *w = find(target);
        if (!w) break;
        if (w->minimized) {            /* focus restores (the 0014 rule) */
            int32_t a[1] = { target };
            wmp_send(sock, WMP_FOCUS, a, 1);
        } else if (w->maximized || w->snapped) restore_floating(w);
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
    case CM_CASCADE: cascade_windows(); break;   /* taskbar strip (0101) */
    case CM_TILE: tile_windows(); break;
    case CM_MIN_ALL: min_all(); break;
    case CM_PROPERTIES: {               /* the ctlpanel hub (todos/0089) */
        char *argv[2] = { (char *)"ctlpanel", 0 };
        spawn_path("/bin/ctlpanel", argv);
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
    /* A live move/size mode owns the keys (todos/0102): the popup is still
     * up (ctx_depth > 0) as the grabber, but arrows drive the target and
     * Enter/Esc end the mode — the menu nav is suspended until then. */
    if (sys_mode) { sys_key(sym); return; }
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
    date_dismiss();                    /* likewise (todos/0101) */
    snapprev_dismiss();                /* likewise (todos/0095) */
    saver_dismiss();                   /* geometry is stale; the idle clock
                                          re-raises it in timeout seconds
                                          (todos/0096) */
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
        if (w->snapped) { snap_place(w); continue; }   /* re-fit (todos/0095) */
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
            } else if (strncmp(r.title, "snappreview", 12) == 0) {   /* 0095 */
                if (!snapprev_win) return;     /* dismissed before the echo */
                snapprev_sid = r.sid;
                int32_t a[3] = { r.sid, snapprev_x, snapprev_y };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer: over the drag */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                /* The preview must not steal focus from the dragged window
                 * (the peek hand-back). */
                for (int i = 0; i < nwins; i++)
                    if (wins[i].focused && !wins[i].minimized) {
                        int32_t f[1] = { wins[i].sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                        break;
                    }
            } else if (strncmp(r.title, "screensaver", 12) == 0) {   /* 0096 */
                if (!saver_win) return;        /* dismissed before the echo */
                saver_sid = r.sid;
                int32_t a[3] = { r.sid, 0, 0 };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer: over everything */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                /* Deliberately NO focus hand-back (the one exception to the
                 * peek pattern): the saver keeps focus so every key lands
                 * on it and dismisses it. The explicit FOCUS also RAISES it
                 * within the +1 band — SET_LAYER's stable normalize would
                 * otherwise leave it under the earlier-created taskbar. */
                int32_t f[1] = { r.sid };
                wmp_send(sock, WMP_FOCUS, f, 1);
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
            } else if (strncmp(r.title, "datepop", 7) == 0) {   /* 0101 */
                if (!date_win) return;         /* dismissed before the echo */
                date_sid = r.sid;
                int32_t a[3] = { r.sid, date_x, scr_h - BAR_H - DATE_H - 4 };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer, like the bar */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
                /* A tooltip must not steal focus from the app. */
                for (int i = 0; i < nwins; i++)
                    if (wins[i].focused && !wins[i].minimized) {
                        int32_t f[1] = { wins[i].sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                        break;
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
            w->snapped = 0;            /* likewise (todos/0095) */
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
        if (p[0] == snapprev_sid) snapprev_sid = 0;       /* defensive (0095) */
        if (p[0] == saver_sid) saver_sid = 0;             /* defensive (0096) */
        if (sys_mode && p[0] == sys_target) sys_end(0);   /* target gone (0102) */
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
            if (desk_focused) {
                if (desk_edit >= 0) desk_edit_armed = 1;   /* editor focus landed */
            } else {
                mod_ctrl = mod_shift = 0;
                if (desk_edit >= 0 && desk_edit_armed)
                    desk_edit_finish();    /* click-away/focus-loss commits (0103) */
            }
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
    case WMP_EV_SNAP_EDGE: {            /* mid-drag edge zone (todos/0095) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        if (p[1] > 0 && find(p[0])) snapprev_show(p[1]);
        else snapprev_dismiss();
        break;
    }
    case WMP_EV_SNAP_DROP: {            /* title-drag release (todos/0095) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        snapprev_dismiss();
        win_t *w = find(p[0]);
        if (!w) break;
        if (p[1] > 0) {
            /* The drag-end EV_MOVED already put the DROP position in the
             * model; the floating rect worth saving is the PRE-drag one
             * the event carries. Rewind the model before snap_to saves —
             * the snap's own MOVE echo re-syncs it right after. */
            if (!w->snapped && !w->maximized && h->plen >= 16) {
                w->x = p[2];
                w->y = p[3];
            }
            snap_to(w, p[1]);
        }
        else if (w->snapped || w->maximized) {
            /* Drag-off: restore the floating SIZE at the drop position —
             * the preceding EV_MOVED already updated x/y in the model, so
             * only the size goes back. */
            w->maximized = 0;
            w->snapped = 0;
            int32_t g[3] = { w->sid, w->sw, w->sh };
            wmp_send(sock, w->resizable ? WMP_RESIZE : WMP_SET_DST, g, 3);
        }
        break;
    }
    case WMP_EV_SNAP_KEY: {             /* Win+arrow / wmctl snap (0095) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        snap_key(p[0]);
        break;
    }
    case WMP_EV_SAVER: {                /* wmctl saver / Preview (0096) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        saver_force();
        break;
    }
    case WMP_EV_SYSMENU: {              /* Alt+Space / wmctl sysmenu (0102) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) exit(1);
        win_t *w = find(p[0]);          /* the focused sid it carries */
        if (w && !w->minimized) ctx_open_sysmenu(w);
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
        else if (h.type == WMP_R_IDLE) idle_consume(&h);   /* GET_IDLE (0096) */
        else if (wmp_skip(sock, h.plen) != 0) exit(1);
    }
}

/* ---- the taskbar ---- */

/* Left edge of the right-aligned clock cell (todos/0101): the Show Desktop
 * sliver sits past it, so the button strip and clock both budget against
 * this, not bar_w. */
static int clock_left(void) { return bar_w - SHOWDESK_W - CLOCK_W; }

/* ---- the clock-hover date tooltip (todos/0101) ---- */

static void date_dismiss(void) {
    if (date_win) SDL_DestroyWindow(date_win);
    date_win = NULL;
    date_surf = NULL;
    date_sid = 0;
    date_pinned = 0;
}

static void date_draw(void) {
    if (!date_win) return;
    uint32_t *px = (uint32_t *)date_surf->pixels;
    uint32_t face = rgb(255, 255, 225), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0);
    fill_s(px, DATE_W, DATE_H, 0, 0, DATE_W, DATE_H, face);
    fill_s(px, DATE_W, DATE_H, 0, 0, DATE_W, 1, hi);       /* raised edge */
    fill_s(px, DATE_W, DATE_H, 0, 0, 1, DATE_H, hi);
    fill_s(px, DATE_W, DATE_H, 0, DATE_H - 1, DATE_W, 1, sh);
    fill_s(px, DATE_W, DATE_H, DATE_W - 1, 0, 1, DATE_H, sh);
    static const char *const wday[7] = { "SUN", "MON", "TUE", "WED",
                                         "THU", "FRI", "SAT" };
    time_t now = time(NULL);
    struct tm *tm = localtime(&now);
    char s[32];
    snprintf(s, sizeof s, "%s %04d-%02d-%02d", wday[tm->tm_wday % 7],
             tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday);
    draw_text_s(px, DATE_W, DATE_H, 8, (DATE_H - 7) / 2, s, txt);
    SDL_UpdateWindowSurface(date_win);
}

/* Raise the date tooltip above the clock (right-aligned). pin=1 keeps it up
 * (a click toggle); pin=0 is a hover, idle-dismissed by the frame loop. Its
 * EV_CREATED echo ("datepop") parks it and hands focus back (the peek
 * pattern) so it never steals focus from an app. */
static void date_show(int pin) {
    date_idle = 0;
    if (date_win) { if (pin) date_pinned = 1; return; }
    date_pinned = pin;
    date_x = bar_w - DATE_W;
    if (date_x < 0) date_x = 0;
    date_win = SDL_CreateWindow("datepop", DATE_W, DATE_H, SDL_WINDOW_BORDERLESS);
    if (!date_win) return;
    date_surf = SDL_GetWindowSurface(date_win);
    date_draw();
}

static void date_toggle(void) {
    if (date_win) date_dismiss();
    else date_show(1);
}

/* Current button width: BTN_W until the row would run past the clock,
 * then shrink to fit (Win95 overflow, todos/0031). Drawing and click
 * mapping share this. */
static int btn_width(void) {
    if (nwins == 0) return BTN_W;
    int avail = clock_left() - START_W - BTN_GAP - 2;
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
    /* The clock cell raises the date tooltip (todos/0101) — but not over an
     * open context menu, whose root must keep focus. */
    int cx = clock_left();
    if ((int)fx >= cx && (int)fx < cx + CLOCK_W && ctx_depth == 0) {
        date_show(0);
        peek_dismiss();
        return;
    }
    if (date_win && !date_pinned) date_dismiss();   /* left the clock: drop */
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if (rel >= 0 && rel % (bw + BTN_GAP) < bw && i < nwins &&
        x + bw <= cx) {                /* same overflow gate as draw_bar */
        peek_show(wins[i].sid, x, bw);
        peek_idle = 0;                 /* still hovering: hold the popup */
    } else peek_dismiss();
}

static void bar_click(float fx) {
    peek_dismiss();                    /* a click acts; the preview drops */
    if ((int)fx < START_W) { date_dismiss(); menu_toggle(); return; }  /* Start */
    menu_dismiss();                    /* any other taskbar click dismisses */
    ctx_dismiss();                     /* likewise (todos/0091) */
    /* Show Desktop sliver, then the clock cell (todos/0101): the sliver
     * toggles minimize-all/restore, the clock toggles the date tooltip. */
    if ((int)fx >= bar_w - SHOWDESK_W) { date_dismiss(); show_desktop_toggle(); return; }
    if ((int)fx >= clock_left()) { date_toggle(); return; }
    date_dismiss();
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    if (rel < 0 || rel % (bw + BTN_GAP) >= bw || i >= nwins) return;
    int32_t a[1] = { wins[i].sid };
    if (wins[i].focused && !wins[i].minimized) wmp_send(sock, WMP_MINIMIZE, a, 1);
    else wmp_send(sock, WMP_FOCUS, a, 1);
}

/* Taskbar right-click: a drawn button raises the Win95 window menu (0091);
 * the Start strip stays reserved; the empty strip / clock / Show Desktop
 * region raises the taskbar-strip menu (0101). Same geometry as bar_click. */
static void bar_rclick(float fx) {
    peek_dismiss();
    menu_dismiss();
    date_dismiss();
    if ((int)fx < START_W) { ctx_dismiss(); return; }   /* Start: reserved */
    int bw = btn_width();
    int rel = (int)fx - START_W - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if (rel >= 0 && rel % (bw + BTN_GAP) < bw && i < nwins &&
        x + bw <= clock_left()) {      /* on a drawn button */
        ctx_open_bar(&wins[i], x);
        return;
    }
    ctx_open_taskbar((int)fx);         /* empty strip / clock / show-desktop */
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
    int cx = clock_left();
    for (int i = 0; i < nwins; i++) {
        int x = START_W + BTN_GAP + i * (bw + BTN_GAP) + 2;
        if (x + bw > cx) break;                /* never under the clock */
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
     * runs per frame, so it updates on the minute by construction. Now left
     * of the Show Desktop sliver (todos/0101). */
    {
        time_t now = time(NULL);
        struct tm *tm = localtime(&now);
        char hhmm[6];
        snprintf(hhmm, sizeof hhmm, "%02d.%02d", tm->tm_hour, tm->tm_min);
        draw_text(px, cx + 8, (BAR_H - 7) / 2, hhmm, txt);
    }
    /* The Show Desktop sliver (todos/0101): a thin Win7 affordance at the
     * far right edge, a raised divider then a strip that reads pressed while
     * a stash is held (i.e. the desktop is currently shown). */
    {
        int sx = bar_w - SHOWDESK_W;
        int held = sd_nstash > 0;
        fill(px, sx, 3, SHOWDESK_W - 2, BAR_H - 6,
             held ? rgb(170, 170, 170) : face);
        fill(px, sx, 3, 1, BAR_H - 6, held ? sh : hi);       /* divider */
        fill(px, sx + 1, 3, 1, BAR_H - 6, held ? face : sh);
        fill(px, sx + 2, 3, SHOWDESK_W - 4, 1, held ? sh : hi);
        fill(px, sx + 2, BAR_H - 4, SHOWDESK_W - 4, 1, held ? hi : sh);
    }
    SDL_UpdateWindowSurface(bar_win);
}

static void frame_cb(void) {
    drain_socket();
    reap_kids();
    /* Coarse /root/Desktop watch (todos/0029): one readdir per second-ish
     * of frame ticks — no watch API exists or is needed. */
    if (++desk_tick >= 60) { desk_tick = 0; desk_load(); }
    /* The screensaver's idle poll rides the same cadence (todos/0096). */
    if (++saver_tick >= 60) { saver_tick = 0; saver_poll(); }
    /* Many windows, one queue: dispatch by windowID (0028/0029/0063/0078).
     * Menu columns and the run dialog come and go inside handlers, so
     * their ids are resolved per event (menu_col_for), not cached. */
    SDL_WindowID did = desk_win ? SDL_GetWindowID(desk_win) : 0;
    SDL_WindowID pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        /* A running screensaver swallows the waking input (todos/0096):
         * fullscreen on the top layer and holding focus, it receives every
         * pointer and key event — any of them dismisses. */
        if (saver_win &&
            (e.type == SDL_EVENT_MOUSE_MOTION ||
             e.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
             e.type == SDL_EVENT_MOUSE_BUTTON_UP ||
             e.type == SDL_EVENT_KEY_DOWN || e.type == SDL_EVENT_KEY_UP)) {
            saver_dismiss();
            continue;
        }
        if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
            int md = menu_col_for(e.button.windowID);
            int cd = ctx_col_for(e.button.windowID);
            if (md == 0) sm_root_click((int)e.button.x, (int)e.button.y);   /* 0098 */
            else if (md > 0) menu_click(md, e.button.y);
            else if (cd >= 0) ctx_click(cd, e.button.y);   /* 0091 */
            else if (run_win && e.button.windowID == SDL_GetWindowID(run_win)) {
                /* a click inside the run dialog: nothing to hit */
            } else if (desk_win && e.button.windowID == did) {
                desk_edit_finish();    /* click-away commits the rename (0103) */
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
            } else if (date_win && e.button.windowID == SDL_GetWindowID(date_win)) {
                date_dismiss();        /* click the date tooltip: dismiss (0101) */
            } else if (e.button.button == 3) bar_rclick(e.button.x);
            else bar_click(e.button.x);
            pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;   /* may drop */
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_UP) {
            if (desk_win && e.button.windowID == did && e.button.button == 1)
                desk_up(e.button.x, e.button.y);   /* marquee/drag end (0077) */
        } else if (e.type == SDL_EVENT_MOUSE_MOTION) {
            int md = menu_col_for(e.motion.windowID);
            int cd = ctx_col_for(e.motion.windowID);
            if (md == 0) sm_root_motion((int)e.motion.x, (int)e.motion.y);   /* 0098 */
            else if (md > 0) menu_motion(md, e.motion.y);
            else if (cd >= 0) ctx_motion(cd, e.motion.y);   /* 0091 */
            else if (desk_win && e.motion.windowID == did) {
                peek_dismiss();        /* pointer left the bar (0063) */
                desk_motion(e.motion.x, e.motion.y, e.motion.state);
            } else if (peek_win && e.motion.windowID == pkid) {
                peek_idle = 0;         /* hovering the preview holds it */
            } else if (date_win && e.motion.windowID == SDL_GetWindowID(date_win)) {
                date_idle = 0;         /* hovering the tooltip holds it (0101) */
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
    /* The date tooltip (todos/0101): a hover (unpinned) drops once the
     * pointer has been off the clock for a while — the wm only sees motion
     * over its own windows, so this backstop mirrors PEEK_IDLE. A pinned
     * (click-opened) tooltip stays until clicked away. */
    if (date_win && !date_pinned && ++date_idle >= PEEK_IDLE) date_dismiss();
    draw_bar();
    for (int d = 0; d < mdepth; d++) draw_menu_col(d);
    for (int d = 0; d < ctx_depth; d++) draw_ctx(d);       /* 0091 */
    draw_run();
    draw_desk();
    if (peek_dirty) { peek_dirty = 0; draw_peek(); }
    draw_saver();                      /* every frame: the animation (0096) */
}

/* The Recycle Bin's desktop presence (todos/0093): the trash store dirs
 * plus a /root/Desktop launcher script — double-click opens the store in
 * fileman, the shared activate() path (a #! script IS the icon, no wm.c
 * launch special case). Recreated every wm start, so the bin can't be
 * lost for good and pre-0093 images grow one without a reseed. */
static void ensure_recycle(void) {
    fo_trash_init();
    mkdir("/root/Desktop", 0755);
    struct stat st;
    if (lstat("/root/Desktop/Recycle Bin", &st) == 0) return;
    FILE *f = fopen("/root/Desktop/Recycle Bin", "w");
    if (!f) return;
    fputs("#!/bin/sh\nexec /bin/fileman " FO_TRASH_FILES "\n", f);
    fclose(f);
}

int main(void) {
    own_pid = getpid();
    srand((unsigned)time(NULL));       /* starfield / marquee-pass jitter (0096) */
    chdir("/root");                    /* children inherit the cwd (0028) */
    ensure_recycle();                  /* the bin exists before desk_load (0093) */
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
    /* Desktop is up: the startup chime (todos/0094; sounds.h fire-and-
     * forget — the kernel drains the clip, pumpless kernels drop it).
     * Deliberately per wm start, not per boot: a `wm &` respawn is a new
     * session, like a Windows logon. */
    snd_play_event("SystemStart");
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
