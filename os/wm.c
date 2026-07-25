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
 * The Start menu (todos/0028, Win95-classic by todos/0078, given the Win7
 * two-pane facelift by todos/0098, then reverted to ONE Win95 column by
 * todos/0132) is a set of borderless SDL windows in this same process,
 * created on Start-button click (or the Ctrl+Esc chord / `wmctl menu` —
 * WMP EV_MENU, the EV_CYCLE pattern) and destroyed on selection or dismiss
 * — SDL events dispatch per window by e.*.windowID. The ROOT window
 * ("startmenu") is a fixed-size single column with a gucOS branding band
 * down the left (the Win95 sidebar): pinned entries (~/.config/pinned) + MRU
 * recents (~/.config/recent, pushed by activate() on every real launch,
 * capped at RECENT_MAX), a groove and the fixed places (Settings ->
 * /bin/ctlpanel, Run... -> the run dialog; Shut Down joins when todos/0051
 * lands), then — XP/Vista/7 style — the "All Programs" row at the BOTTOM,
 * with a live SEARCH box at its foot. Typing (the root holds keyboard
 * focus) filters a flat walk of the menu tree into the column live (fixed
 * places suppressed); Enter launches the top hit. "All Programs" (hover,
 * click, or arrow-Right)
 * cascades the menu tree as flyout columns snugly off the column's right
 * edge — each its own window titled "startmenu2"/"startmenu3"/...
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
 * fixed item lists. Empty desktop: New >, Sort by >, Refresh, Add Default
 * Icons (Lane D: spawns /usr/bin/desktop-defaults, the additive default-
 * Desktop reconcile), Display
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
#include <SDL_popup.h>     /* anchored menu columns (todos/0282 over 0256) */
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
#include "launch.h"
#include "openwith.h"
#include "fileops.h"
#include "sounds.h"
#include "saver.h"
#include "keys.h"

#ifndef SDLK_LGUI               /* not yet in the veneer SDL.h: the modifier
                                   keysym block stops at RALT. 0x40000000 |
                                   scancode, scancodes 227/231 (SDL3). */
#define SDLK_LGUI 1073742051
#define SDLK_RGUI 1073742055
#endif
/* The ONE menu engine (todos/0259, arch A13): wm.c is menu-engine
 * customer #2 — its Start-menu flyouts and context menus track/measure/
 * raster through menucore (model + chain + gdi32/freetype raster), with
 * this process supplying the window substrate (borderless top-layer
 * furniture windows that HOLD kernel focus — the WM has no parent app
 * window for keys to land on) through the MenuCoreOps vtable. */
#include "win32/menucore.h"
#include "win32/win32_internal.h"

/* The unified multi-source wait (kernel FS_WAIT via host.js, todos/0178):
 * park until an fd in rfds is readable (1), the input ring has records —
 * already drained into the SDL queue at return (2), timeout_ms elapses
 * (0; < 0 waits forever), or a signal was posted (-1, handler already ran).
 * Readiness-check and park are atomic KERNEL-side — this is what retired
 * the 0168 socket kick + pre-park select pair. Every return re-runs the
 * drains (the 0161 spurious-wake contract). */
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

#define BAR_H     36
#define START_W   80    /* the Start button strip at the taskbar's left (0028) */
#define BTN_W     160   /* preferred button width; shrinks on overflow (0031) */
#define BTN_MIN   32    /* ...but never below a clickable floor */
#define BTN_GAP   4
#define CLOCK_W   75    /* right-aligned HH.MM cell: 8 + 5*12-1 + 8 (0031) */
#define SHOWDESK_W 18   /* the Show Desktop sliver at the far right (0101) */
#define DATE_W    184   /* the clock-hover date tooltip (0101): "SAT 2026-07-11" */
#define DATE_H    30
#define MAX_WIN   64
#define TITLE_H   28    /* keep placements below the kernel title bar (>= WM_TITLE_H) */

/* Flyout/ctx geometry (MENU_W/MENU_ENTRY_H/MENU_PAD/MENU_SEP_H/CTX_W) and
 * the MENU_DEPTH-4 cap are GONE since todos/0259: popup columns are
 * menucore chain levels (MENU_ITEM_H rows, measured widths, arbitrary
 * depth to MENU_MAX_DEPTH). */
#define MAX_MENU     32
#define ENT_NAME     256    /* entry/item name buffer: a full filesystem name
                              * (BlockFS d_name is 255 chars + NUL) fits, so a
                              * long/spaced Desktop or menu filename is never
                              * truncated on the launch path (todos/0151). */
#define SM_WALK_MAX  8      /* search-walk recursion cap (was MENU_DEPTH) */

/* Win95 single-column root (todos/0132, restyling the 0098 two-pane; the
 * gucOS branding band + bottom "All Programs" are the 0132 follow-up).
 * A vertical gucOS BAND runs down the left (the Win95 sidebar), then ONE
 * column: pinned entries + MRU recents, a groove, the fixed places
 * (Settings, Run...), a groove, and — XP/Vista/7 style — the "All
 * Programs" row at the BOTTOM (which cascades the tree flyout), with a
 * live search box at its foot. Flyouts (depth >= 1) are the same
 * single-column entry lists (the 0078 substrate) — dropping the right pane
 * makes the cascade formula (smroot.x + SM_ROOT_W - 3) hang the flyout
 * snugly off the column's right edge, where 0098's two-pane root threw it
 * PAST the second pane; a bottom All-Programs cascades UPWARD via the
 * work-area clamp (the win_create op), exactly like Win7. The root is a FIXED
 * size so its geometry doesn't shift with the recents count. */
#define SM_SIDE_W    30     /* the gucOS branding band down the left */
#define SM_COL_W     260    /* the item column, right of the band */
#define SM_ROW_H     28
#define SM_PAD       4
#define SM_ROWS      12     /* column row slots (also the item cap) */
#define SM_FIXED     2      /* fixed rows folded into the column: Settings, Run... */
#define SM_SEARCH_H  30     /* the search box at the foot of the column */
#define SM_ROOT_W    (SM_SIDE_W + SM_COL_W)
#define SM_ROOT_H    (SM_PAD + SM_ROWS * SM_ROW_H + 4 + SM_SEARCH_H + SM_PAD)
#define SM_SEARCH_Y  (SM_PAD + SM_ROWS * SM_ROW_H + 4)
#define RECENT_MAX   8      /* MRU cap in ~/.config/recent */

#define RUN_W        340    /* the RUN... dialog (todos/0078) */
#define RUN_H        78
#define RUN_MAX      100

#define DESK_MARGIN  16     /* the icon grid (todos/0029) */
#define CELL_W       116
#define CELL_H       96
#define ICON_W       32
#define MAX_DESK     64
#define DBLCLICK_NS  500000000ULL   /* 500ms, the SDL click-count window */
#define DRAG_SLOP    4      /* px of button-held travel before a press
                               becomes a marquee or icon drag (todos/0077) */

/* Window overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md) */
#define OV_GAP       16     /* grid gap between miniature cells */
#define OV_CAPTION_H 24     /* per-row caption strip — MUST MATCH the compositor
                               (compositor.js OV_CAPTION_H) so the browser
                               caption lands where the layout reserved room */
#define TASKVIEW_W   26     /* the Task-View button right of the Start strip
                               (Win10 position); shifts the app-button strip */


#define PEEK_W       160    /* Aero Peek popup (todos/0063) */
#define PEEK_H       120
#define PEEK_PAD     6      /* face border around the thumbnail */
#define PEEK_REFRESH_MS 500  /* ms between live THUMB refreshes */
#define PEEK_IDLE_MS   2500  /* ms without a hover before auto-dismiss —
                                the wm only sees motion over its OWN windows,
                                so a pointer parked over an app window can't
                                tell us to close; this backstop does (wall
                                clock since todos/0168: the loop wakes ~1/s
                                idle, not per frame) */

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

/* Fatal-exit with a diagnostic (todos/0234): the wm is the desktop's
 * central service, and the kernel-chrome fallback makes its death easy
 * to miss — a bare exit turns a protocol drift or a dead endpoint
 * into an strace hunt. Every fatal path says WHAT failed and WHY on
 * stderr — and the WHY must come from the layer that actually failed
 * (todos/0255). Two intents:
 *   fatal()      appends strerror(errno) — the socket/wmp_read callers,
 *                where errno IS the cause (wmp_read_all names EOF as
 *                ECONNRESET, so the common endpoint-gone case reads
 *                truthfully).
 *   fatal_sdl()  appends SDL_GetError() — the SDL window-creation
 *                paths, where errno is unset or stale noise (pre-0255
 *                the EV_SCREEN recreate printed "cannot recreate the
 *                desktop window: Success").
 * Both carry the exit code so the exit(2) window-creation paths get
 * the same treatment. */
static void fatal(int code, const char *what) {
    fprintf(stderr, "wm: %s: %s\n", what, strerror(errno));
    exit(code);
}
static void fatal_sdl(int code, const char *what) {
    const char *why = SDL_GetError();
    if (why && why[0]) fprintf(stderr, "wm: %s: %s\n", what, why);
    else fprintf(stderr, "wm: %s\n", what);
    exit(code);
}
static void die(const char *what) { fatal(1, what); }
static win_t wins[MAX_WIN];
static int nwins = 0;
static int32_t bar_sid = 0;        /* our own taskbar surface */
static int own_pid = 0;
static int overview_active = 0;    /* window overview / Exposé (todos/EXPOSE):
                                      1 while the miniature grid is up. Declared
                                      here (not with the overview functions) so
                                      saver_show can end it — mutual exclusion */
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
static uint64_t date_hover_ms = 0; /* last raise/hover stamp (0101; 0168 wall clock) */
static int date_pinned = 0;

/* Start menu state (todos/0028; single-column root 0098/0132; flyouts on
 * the menucore chain since todos/0259). The ROOT panel (branding band +
 * pins/recents/search) stays this process's own window and drawing — its
 * shape (search box, fixed places, bottom All Programs) is shell policy,
 * not an item-tree menu, and deliberately did NOT reseat onto the
 * engine. The flyout columns (All Programs and every subdirectory
 * cascade) ARE engine chain levels: entries union-read from /etc/menu
 * AND /usr/share/menu (todos/0259, ex-0244/0250 — /etc wins same-name
 * clashes) at each popup_opening. */
/* Desktop icon glyph kinds (ticket #82): the normalized filetype the desk
 * render loop dispatches on. Computed per entry by desk_kind() (desktop
 * only — Start-menu loads leave it 0/unused). */
enum {
    DK_FILE = 0,                   /* generic document: dog-eared page */
    DK_DIR,                        /* folder: tab + body (todos/0185) */
    DK_EXEC,                       /* runnable (\0asm / #!): solid block */
    DK_TEXT,                       /* text/config: page + text lines */
    DK_IMAGE,                      /* image: framed sun + ridge */
    DK_DECK,                       /* presentation deck: screen on stand */
    DK_BIN,                        /* the Recycle Bin basket (todos/0093) */
    DK_STORE,                      /* software center: shopping bag (Q2) */
};
typedef struct { char name[ENT_NAME]; int is_link; int is_dir; int kind; } menu_ent;
static struct {                    /* the root panel window; NULL = closed */
    SDL_Window *win;
    SDL_Surface *surf;
    int32_t sid;                   /* EV_CREATED echo ("startmenu") */
    int x, y;                      /* screen geometry (the park target) */
} smroot;
static int nkids = 0;              /* live spawned children (reap on frame) */

/* ---- the menucore front-end (todos/0259) --------------------------
 * One tracking at a time (menus are modal): mc_kind says which consumer
 * owns the open chain; ov[] is the overlay-window substrate — one
 * furniture window per open chain level. Since todos/0282 every level
 * with an owner surface is a kernel ANCHORED CHILD (0256, created via
 * SDL_CreatePopupWindow): positioned kernel-side from the owner +
 * offset, layer-inherited, re-slotted above the owner after every z
 * mutation (a column can never render below the panel it cascades
 * from — the 0282 bug), and never focused, so the root keeps the
 * keyboard with no FOCUS hand-back. Titles ("ctxmenu"/"ctxmenu2"/...
 * for context menus, "startmenu2"/... for Start flyouts) still land
 * via SET_TITLE so tests keep their handles; the sid is recorded at
 * the EV_CREATED echo by creation order (anchored echoes carry no
 * title). Only a ctx-menu ROOT — no owner surface, it opens at the
 * pointer — stays an ownerless borderless top-level parked at its
 * echo; it HOLDS kernel focus (the create steal) so keyboard nav
 * reaches this process even over a foreign focused window. */
enum { MK_NONE = 0, MK_START, MK_CTX };
static int mc_kind = MK_NONE;
static struct {
    SDL_Window *win;               /* NULL = level not live */
    int32_t sid;                   /* EV_CREATED echo */
    int x, y;                      /* clamped screen position (park target) */
} ov[MENU_MAX_DEPTH];

/* Start-chain model: tables are lazily (re)populated per popup_opening
 * from the menu-tree union; assoc maps each live table to its path
 * RELATIVE to the tree roots, and a leaf's command id is
 * (assoc-index << 8 | row) — resolved back to an absolute path at fire
 * time (tables outlive the chain; they are freed at the next open). */
#define SM_ASSOC_MAX 128
static struct { MenuTbl *tbl; char rel[288]; } sm_assoc[SM_ASSOC_MAX];
static MenuTbl *sm_tbl;            /* the chain's root table (all subs hang
                                      off it; destroyed at the next open) */
static MenuTbl *ctx_tbl;           /* the ctx tracking's root table */
static void ctx_command(int id);   /* the CM-id dispatch (defined with the
                                      ctx builders) */

/* Single-column root state (todos/0098, right pane dropped in 0132):
 * smroot still owns the root WINDOW (sid/geometry/parking through the
 * shared plumbing), but its column is this heterogeneous item list rather
 * than a directory listing — pinned entries, then MRU recents, then All Programs,
 * then a groove and the fixed places (Settings, Run...); in search mode, a
 * flat walk of the tree (fixed rows suppressed). Flyouts (depth >= 1) keep
 * using menu_col wholesale. */
enum { SMI_PIN, SMI_RECENT, SMI_ALLPROGS, SMI_RESULT, SMI_SETTINGS, SMI_RUN };
typedef struct { char name[ENT_NAME]; char path[256]; int kind; } sm_item;
static sm_item sm_left[SM_ROWS];
static int sm_nleft = 0;
static int sm_lhover = -1;         /* column cursor row, -1 none */
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
static uint64_t desk_poll_ms = 0;  /* coarse /root/Desktop re-read stamp */
static int desk_trash_full = 0;    /* Recycle Bin glyph state (todos/0093),
                                      refreshed on the same coarse tick */
static int mod_ctrl = 0, mod_shift = 0,   /* held modifiers, tracked from
                                             key events by KEYSYM — pointer
                                             records carry no mod word; reset
                                             when the desktop loses focus so
                                             a keyup that went elsewhere can't
                                             wedge them (todos/0077) */
           mod_gui = 0;                   /* ⌘/GUI likewise (todos/0149 —
                                             the macos-scheme select-all) */
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

/* Context menu state (todos/0091; on the menucore chain since 0259 —
 * the "at most one ctxmenu2" v1 depth cap is gone with the fork engine):
 * item tables built per open from fixed lists, tracked/measured/rastered
 * by the engine over the ov[] furniture windows ("ctxmenu"/"ctxmenu2"/
 * ...), dismissed when kernel focus leaves them. */
enum {                             /* command ids (ctx_command dispatch) */
    CM_NONE = 0,
    CM_REFRESH, CM_DISPLAY,        /* desktop */
    CM_ADD_DEFAULTS,               /* desktop (Lane D: /usr/bin/desktop-defaults) */
    CM_PASTE,                      /* desktop (0092: the fileops clipboard) */
    CM_NEW_FOLDER, CM_NEW_FILE, CM_SORT_NAME,      /* New/Sort by cascades */
    CM_OPEN,                       /* icon */
    CM_EDIT,                       /* icon (0202: document → GUI text editor) */
    CM_RENAME,                     /* icon (0103: the inline rename editor) */
    CM_CUT, CM_COPY,               /* icon (0092: the selection set) */
    CM_DELETE,                     /* icon (0093: to the Recycle Bin) */
    CM_EMPTY,                      /* the Recycle Bin icon (0093) */
    CM_RESTORE, CM_MINIMIZE, CM_MAXIMIZE, CM_CLOSE, /* taskbar button */
    CM_CASCADE, CM_TILE, CM_MIN_ALL, CM_PROPERTIES, /* taskbar strip (0101) */
    CM_MOVE, CM_SIZE               /* window system menu (todos/0102) */
};

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
static uint64_t peek_refresh_ms = 0; /* last live-refresh stamp */
static uint64_t peek_hover_ms = 0;   /* last raise/hover stamp (auto-dismiss) */
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
static uint64_t saver_poll_ms = 0; /* coarse once-a-second poll stamp */
static uint64_t grab_poll_ms = 0;  /* key-grab-table rebuild stamp (0 = due) */
static int idle_pending = 0;       /* GET_IDLE in flight */
static int marq_x, marq_y;         /* marquee banner position */
static float star_x[SAVER_STARS], star_y[SAVER_STARS], star_z[SAVER_STARS];

/* ---- transient hover furniture vs. focus-owning popups ----
 *
 * TRANSIENTS are the wm's hover-raised, purely informational surfaces: the
 * Aero Peek thumbnail (0063) and the clock's date tooltip (0101). Being
 * ownerless borderless top-levels they take the kernel's create-focus
 * (kernel.js focuses every parentless new surface) and then hand it straight
 * back to the focused app in their EV_CREATED echo ("must not steal focus
 * from the app" — see handle_event).
 *
 * BOTH halves of that churn are fatal to a popup whose ROOT MUST KEEP FOCUS
 * — the Start menu, the context menu, the run dialog. Each of those is
 * dismissed by focus landing on a sid it does not own, and neither the
 * transient's own sid nor the app it hands focus back to is such a sid. So a
 * transient raised over an open menu kills it twice over, and a transient
 * merely still ALIVE when a menu opens kills it later, when the idle
 * auto-dismiss in the frame loop destroys it and focus falls again.
 *
 * ONE rule instead of a per-pairing guard at each site (the clock branch of
 * bar_motion used to carry the only copy, which is why hovering a taskbar
 * BUTTON — the same function, two lines down — killed the menu):
 *
 *   while a focus-owning popup is up, no transient surface EXISTS.
 *
 * Enforced at the two seams: transients refuse to be created
 * (popup_holds_focus, checked inside peek_show/date_show themselves so any
 * future caller inherits it), and raising a focus-owning popup first drops
 * any transient already showing (transients_dismiss, from the ctx/Start/run
 * open paths). Killing the CREATE is what makes this structural rather than
 * a patch per focus op: no surface means no create-focus steal, no echo, no
 * hand-back, and nothing for the idle timer to destroy later. A new
 * transient added here needs the same two lines; a new focus-owning popup
 * needs only to join the predicate. */
static int popup_holds_focus(void) {
    return smroot.win ||                             /* Start menu (0028/0078) */
           run_win ||                                /* Run... dialog (0078) */
           saver_win ||                              /* screensaver (0096) */
           (__mc.open && mc_kind == MK_CTX);         /* context menu (0091) */
    /* sys_mode (0102) needs no entry: its keyboard move/size mode keeps the
     * sysmenu popup up as the grabber, so MK_CTX already covers it. */
}

static void transients_dismiss(void) {
    peek_dismiss();
    date_dismiss();
}

static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

/* ---- chrome text via freetype/gdi32 (Phase C facility, 20px-AA retune) ----
 *
 * ONE glyph facility: the same gdi32/freetype path the menus (menucore)
 * already draw with, reached through the __gdi_dc_wrap seam (the
 * child-control precedent) — no second glyph cache, no second text path.
 * The font-20 retune (folded into Phase D): CHROME_PPEM 20 with
 * DEFAULT_QUALITY grayscale AA — unhinted freetype at ppem 10 was the
 * grain/blur root cause (no hinter is vendored; at 20px AA is clean
 * without one), and the 1-bit threshold amplified it. This font is now
 * THE system font everywhere: it equals the gdi32 SYSTEM_FONT stock
 * (STOCK_FONT_PX 20), so wm chrome, menucore menus at every level,
 * user32 controls and the software center all render identically.
 * Noto Sans Mono at ppem 20: advance 12px, caps 14px (CHROME_CAP),
 * ascent 22, descent 6. */
#define CHROME_PPEM 20
#define CHROME_CAP  14   /* cap height at CHROME_PPEM — the layout unit that
                            replaced the retired 5x7 table's 7px cap cell */

static HFONT chrome_font(void) {
    static HFONT f;
    if (!f)
        f = CreateFont(-CHROME_PPEM, 0, 0, 0, FW_NORMAL, 0, 0, 0,
                       ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                       DEFAULT_QUALITY, FIXED_PITCH, "mono");
    return f;
}

/* The persistent 1x1 measure DC (user32's g_scratchPx precedent). */
static HDC chrome_mdc(void) {
    static HDC mdc;
    static uint32_t dot;
    if (!mdc) {
        mdc = __gdi_dc_wrap(&dot, 1, 1, 1);
        if (mdc) SelectObject(mdc, chrome_font());
    }
    return mdc;
}

static int chrome_ascent(void) {
    static int asc;
    if (!asc) {
        TEXTMETRIC tm;
        asc = chrome_mdc() && GetTextMetrics(chrome_mdc(), &tm) ? tm.tmAscent
                                                                : 8;
    }
    return asc;
}

static int chrome_cell_h(void) {
    static int ch;
    if (!ch) {
        TEXTMETRIC tm;
        ch = chrome_mdc() && GetTextMetrics(chrome_mdc(), &tm)
                 ? tm.tmHeight : 11;
    }
    return ch;
}

static int text_w(const char *s) {
    SIZE sz;
    if (!chrome_mdc() ||
        !GetTextExtentPoint32(chrome_mdc(), s, (int)strlen(s), &sz))
        return 0;
    return (int)sz.cx;
}

/* Byte count of the longest prefix of s fitting in maxw px — codepoint-
 * aware (never splits a UTF-8 sequence); replaces the byte-count*6
 * truncation loops. */
static int text_fit(const char *s, int maxw) {
    int len = (int)strlen(s), i = 0, w = 0;
    while (i < len) {
        int j = i;
        __u8_next(s, len, &j);
        char cpb[8];
        memcpy(cpb, s + i, (size_t)(j - i));
        cpb[j - i] = 0;
        w += text_w(cpb);
        if (w > maxw) break;
        i = j;
    }
    return i;
}

/* Byte index where the TAIL of s that fits in maxw px begins (input
 * fields keep the end of the line visible). */
static int text_tail(const char *s, int maxw) {
    int len = (int)strlen(s), i = len, w = 0;
    while (i > 0) {
        int p = __u8_prev(s, i);
        char cpb[8];
        memcpy(cpb, s + p, (size_t)(i - p));
        cpb[i - p] = 0;
        w += text_w(cpb);
        if (w > maxw) break;
        i = p;
    }
    return i;
}

/* UTF-8-encode one keysym code point (the VT2 input ring carries Unicode
 * code points since Phase A). Returns byte count, 0 on a non-character. */
static int u8_enc(unsigned cp, char *out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | cp >> 6);
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | cp >> 12);
        out[1] = (char)(0x80 | (cp >> 6 & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    if (cp <= 0x10FFFF) {
        out[0] = (char)(0xF0 | cp >> 18);
        out[1] = (char)(0x80 | (cp >> 12 & 0x3F));
        out[2] = (char)(0x80 | (cp >> 6 & 0x3F));
        out[3] = (char)(0x80 | (cp & 0x3F));
        return 4;
    }
    return 0;
}

/* Is this keysym printable TEXT for the wm's own input fields (RUN,
 * search, icon rename)? Named keys live at 0x40000000+, DEL is 127. */
static int sym_text(int sym) {
    return sym >= 32 && sym != 127 && sym < 0x40000000;
}

/* Drawing helpers over any surface (sw x sh) — the taskbar and the Start
 * menu share them (todos/0028). (x, y) addresses the top of the CAP cell
 * (CHROME_CAP px tall — the generalization of the retired 5x7 table's
 * 7px cell): the baseline sits at y + CHROME_CAP and every
 * (H - CHROME_CAP) / 2 centering in the chrome derives from the real
 * font metrics; descenders extend below the cap cell, which every
 * surface budgets room for. */
static void draw_text_s(uint32_t *px, int sw, int sh, int x, int y,
                        const char *s, uint32_t col) {
    HDC dc = __gdi_dc_wrap(px, sw, sh, sw);
    if (!dc) return;
    SelectObject(dc, chrome_font());
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, (COLORREF)(col & 0x00FFFFFFu));
    TextOut(dc, x, y + CHROME_CAP - chrome_ascent(), s, (int)strlen(s));
    __gdi_dc_unwrap(dc);
}

/* Render s through the chrome font into a transient ink MASK (1 byte per
 * pixel, nonzero = ink) trimmed to the ink bounding box — the substrate
 * the rotated (gucOS band) and zoomed (marquee) transforms operate on.
 * Returns NULL when s has no ink; caller frees. */
static unsigned char *text_mask(const char *s, int *tw, int *th) {
    int w = text_w(s) + 2, h = chrome_cell_h() + 4;
    if (w < 3) return NULL;
    uint32_t *tmp = (uint32_t *)calloc((size_t)w * h, 4);
    if (!tmp) return NULL;
    HDC dc = __gdi_dc_wrap(tmp, w, h, w);
    if (!dc) { free(tmp); return NULL; }
    SelectObject(dc, chrome_font());
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255, 255, 255));
    TextOut(dc, 0, 2, s, (int)strlen(s));
    __gdi_dc_unwrap(dc);
    int x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (int j = 0; j < h; j++)
        for (int i = 0; i < w; i++)
            if (tmp[j * w + i]) {
                if (i < x0) x0 = i;
                if (i > x1) x1 = i;
                if (j < y0) y0 = j;
                if (j > y1) y1 = j;
            }
    if (x1 < 0) { free(tmp); return NULL; }
    int mw = x1 - x0 + 1, mh = y1 - y0 + 1;
    unsigned char *m = (unsigned char *)malloc((size_t)mw * mh);
    if (!m) { free(tmp); return NULL; }
    for (int j = 0; j < mh; j++)
        for (int i = 0; i < mw; i++)
            m[j * mw + i] = tmp[(y0 + j) * w + x0 + i] ? 1 : 0;
    free(tmp);
    *tw = mw;
    *th = mh;
    return m;
}

/* Vertical label reading BOTTOM-to-TOP — the Win95 sidebar title
 * (todos/0132 follow-up): upright and correctly ordered when the head
 * tilts left. (cx, cy) is the CENTER of the band area; a mask pixel
 * (hx, hy) maps to horizontal +hy and vertical -hx, a true (non-mirrored)
 * 90° CCW rotation of the freetype-rendered text. */
static void draw_text_vert_s(uint32_t *px, int sw, int sh, int cx, int cy,
                             const char *s, uint32_t col) {
    int tw, th;
    unsigned char *m = text_mask(s, &tw, &th);
    if (!m) return;
    int bx = cx - th / 2, by = cy + tw / 2;
    for (int hy = 0; hy < th; hy++)
        for (int hx = 0; hx < tw; hx++)
            if (m[hy * tw + hx]) {
                int xx = bx + hy, yy = by - hx;
                if (xx >= 0 && xx < sw && yy >= 0 && yy < sh)
                    px[yy * sw + xx] = col;
            }
    free(m);
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

/* The marquee's glyph zoom for the current screen: the chrome font scaled
 * to a banner that reads across the room, clamped sane on tiny screens. */
static int saver_zoom(void) {
    /* The 20px chrome mask is ~3x the retired 7px cell, so the zoom
     * range halves to keep the banner a comparable screen fraction. */
    int z = scr_h / 128;
    if (z < 1) z = 1;
    if (z > 4) z = 4;
    return z;
}

/* The zoomed banner's pixel size (the wrap / vertical-centering math). */
static void text_zoom_size(const char *s, int z, int *bw, int *bh) {
    int tw = 0, th = 7;
    unsigned char *m = text_mask(s, &tw, &th);
    free(m);
    *bw = tw * z;
    *bh = th * z;
}

/* draw_text_s at an integer zoom — each ink pixel of the freetype-rendered
 * mask becomes a z x z block. Off-surface blocks clip in fill_s, so the
 * banner can enter and leave. */
static void draw_text_zoom(uint32_t *px, int sw, int sh, int x, int y,
                           const char *s, int z, uint32_t col) {
    int tw, th;
    unsigned char *m = text_mask(s, &tw, &th);
    if (!m) return;
    for (int hy = 0; hy < th; hy++)
        for (int hx = 0; hx < tw; hx++)
            if (m[hy * tw + hx])
                fill_s(px, sw, sh, x + hx * z, y + hy * z, z, z, col);
    free(m);
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
    if (overview_active) {             /* mutually exclusive (todos/EXPOSE) */
        wmp_send(sock, WMP_OVERVIEW_END, NULL, 0);
        overview_active = 0;
    }
    saver_prev = 0;
    for (int i = 0; i < nwins; i++)
        if (wins[i].focused && !wins[i].minimized) { saver_prev = wins[i].sid; break; }
    marq_x = scr_w;
    {
        int bw, bh;
        text_zoom_size(saver_cfg.text, saver_zoom(), &bw, &bh);
        marq_y = (scr_h - bh) / 2;
    }
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

/* ---- the kernel key-grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md §4) ----
 * wm.c is the POLICY owner of the global chords: it computes the desired grab
 * table from the keys.h registry (active scheme + user bind.<action> overrides,
 * resolved per-action by ks_action_binding) and PUSHES it to the config-blind
 * kernel via WMP_GRAB_SET whenever it changes. Rebuilt on the 1 Hz config poll
 * (the saver_poll cadence — a Control Panel Apply lands within ~1s); steady
 * state sends nothing. In the windows scheme the table is the legacy chords —
 * behaviour identical to the kernel's WM_DEFAULT_GRABS, just carried by the
 * non-reserved KTOK_* tokens that ride EV_HOTKEY instead of the default table's
 * reserved twins. In the macos scheme snap RELOCATES to Ctrl+Alt+arrow and
 * GUI+arrow is simply not installed — that omission IS the whole "⌘+arrow
 * reaches the app for line/doc nav" story (an uninstalled chord passes through;
 * no release op). Ctrl+Alt+E (wm.overview) is installed in BOTH schemes; its
 * EV_HOTKEY toggles the window overview / Exposé (hotkey_dispatch below). */
typedef struct { int32_t scancode, km, token; } grab_ent;
static grab_ent grab_last[WMP_GRAB_MAX];
static int grab_last_n = -1;             /* -1 = never pushed (force first) */

static void grab_table_push(void) {
    grab_ent tbl[WMP_GRAB_MAX];
    int n = 0;
    for (int i = 0; i < KSA_COUNT && n < WMP_GRAB_MAX; i++) {
        if (KS_ACTIONS[i].kind != KAK_SYS) continue;   /* system chords only */
        KsChord ch[2];
        int nc = ks_action_binding(i, ch);             /* override-or-scheme */
        for (int c = 0; c < nc && n < WMP_GRAB_MAX; c++) {
            int sc = ks_chord_scancode(ch[c].key);
            if (sc < 0) continue;                       /* unmappable key */
            /* Dedupe (scancode, km): the kernel takes the FIRST match, and
             * registry order is the §7.3 conflict tie-break — the earlier
             * action wins a collision, the later one is dropped, so we never
             * install a duplicate row that would eat a key for a shadowed
             * action. (Also collapses cycle's dual default cleanly: its two
             * chords differ, so both survive.) */
            int dup = 0;
            for (int j = 0; j < n; j++)
                if (tbl[j].scancode == sc && tbl[j].km == ch[c].mods) { dup = 1; break; }
            if (dup) continue;
            tbl[n].scancode = sc;
            tbl[n].km = ch[c].mods;
            tbl[n].token = KS_ACTIONS[i].token;
            n++;
        }
    }
    if (n == grab_last_n && memcmp(tbl, grab_last, (size_t)n * sizeof *tbl) == 0)
        return;                          /* unchanged: steady state is silent */
    int32_t args[1 + 3 * WMP_GRAB_MAX];
    args[0] = n;
    for (int i = 0; i < n; i++) {
        args[1 + 3 * i] = tbl[i].scancode;
        args[2 + 3 * i] = tbl[i].km;
        args[3 + 3 * i] = tbl[i].token;
    }
    wmp_sendv(sock, WMP_GRAB_SET, args, 1 + 3 * n);   /* n triples exceed wmp_send's 8-arg cap */
    memcpy(grab_last, tbl, (size_t)n * sizeof *tbl);
    grab_last_n = n;
}

/* An R_IDLE reply landed (drain_socket routes every one here). Compare in
 * whole seconds — the poll is second-coarse anyway. */
static void idle_consume(wmp_hdr *h) {
    idle_pending = 0;
    int32_t ms = 0;
    if (h->plen < 4 || wmp_read_all(sock, &ms, 4) != 0) die("R_IDLE read");
    if (wmp_skip(sock, h->plen - 4) != 0) die("R_IDLE skip");
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
        int bw, bh;
        text_zoom_size(saver_cfg.text, z, &bw, &bh);
        draw_text_zoom(px, scr_w, scr_h, marq_x, marq_y, saver_cfg.text, z, white);
        marq_x -= 4;
        if (marq_x + bw < 0) {         /* wrapped: new pass, new height */
            marq_x = scr_w;
            int span = scr_h - bh - 2 * DESK_MARGIN;
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

/* ---- launching + the Start menu (todos/0028) ----
 * The spawn primitive itself (spawn_path/reap_kids) is shared with fileman
 * via launch.h; the wm passes its own kid counter and "wm" as the
 * diagnostic prefix. */

/* activate()'s directory policy: a folder opens in fileman (todos/0185).
 * Start-menu dirs are flyout groups and never reach here. */
static void dir_open_fileman(const char *path) {
    char *argv[3] = { "fileman", (char *)path, 0 };
    spawn_path("/bin/fileman", argv, &nkids, "wm");
}

/* One "activate a path" (todos/0066), shared by the Start menu and the
 * desktop grid: the launch.h ladder (todos/0240 — fileman rides the same
 * one) with wm's policies — directories open in a new fileman, direct
 * launches push the MRU recents (0098). The stat follows links, matching
 * the grid's is_dir; a gone/dangling link is a no-op. */
static void activate(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) return;            /* gone, or a dangling link */
    launch_activate(path, &st, dir_open_fileman, sm_record_recent,
                    &nkids, "wm");
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

/* ---- the menu-tree UNION (todos/0259, resolving the 0244 "4th class
 * member" + the 0250 deferral): a Start-menu directory is the union of
 * /etc/menu/<rel> and /usr/share/menu/<rel>, an /etc entry winning a
 * same-NAME clash (so a package or the admin can drop one entry into the
 * writable /etc/menu without hiding the whole baked tree — the gucman
 * prerequisite). One merged groups-first/alpha sort. ---- */
static int menu_load_union(const char *rel, menu_ent *dst, int max) {
    char dir[320];
    snprintf(dir, sizeof dir, "/etc/menu%s%s", *rel ? "/" : "", rel);
    int n = load_entries(dir, dst, max);
    static menu_ent baked[MAX_MENU];   /* off the 64KB wasm stack */
    snprintf(dir, sizeof dir, "/usr/share/menu%s%s", *rel ? "/" : "", rel);
    int m = load_entries(dir, baked, MAX_MENU);
    for (int i = 0; i < m && n < max; i++) {
        int dup = 0;
        for (int k = 0; k < n && !dup; k++)
            dup = strcmp(dst[k].name, baked[i].name) == 0;
        if (!dup) dst[n++] = baked[i];
    }
    qsort(dst, n, sizeof dst[0], entcmp);
    return n;
}

/* Resolve a union-relative path to the layer that owns it (/etc first —
 * the precedence rule — else the baked tree). */
static void menu_union_abs(const char *rel, const char *name,
                           char *out, int cap) {
    struct stat st;
    snprintf(out, cap, "/etc/menu%s%s%s%s", *rel ? "/" : "", rel,
             "/", name);
    if (lstat(out, &st) == 0) return;
    snprintf(out, cap, "/usr/share/menu%s%s%s%s", *rel ? "/" : "", rel,
             "/", name);
}

/* ---- the menucore ops (todos/0259): the window substrate + command
 * sinks this process supplies to the engine ---- */

static int ov_index(SDL_Window *win) {
    for (int k = 0; k < MENU_MAX_DEPTH; k++)
        if (ov[k].win == win) return k;
    return -1;
}

static int ov_level_for(SDL_WindowID id) {
    for (int k = 0; k < MENU_MAX_DEPTH; k++)
        if (ov[k].win && SDL_GetWindowID(ov[k].win) == id) return k;
    return -1;
}

static int ov_owns_sid(int32_t sid) {
    if (!sid) return 0;
    for (int k = 0; k < MENU_MAX_DEPTH; k++)
        if (ov[k].win && ov[k].sid == sid) return 1;
    return 0;
}

static int sm_assoc_index(MenuTbl *tbl) {
    for (int i = 0; i < SM_ASSOC_MAX; i++)
        if (sm_assoc[i].tbl == tbl) return i;
    return -1;
}

static int sm_assoc_add(MenuTbl *tbl, const char *rel) {
    for (int i = 0; i < SM_ASSOC_MAX; i++)
        if (!sm_assoc[i].tbl) {
            sm_assoc[i].tbl = tbl;
            snprintf(sm_assoc[i].rel, sizeof sm_assoc[i].rel, "%s", rel);
            return i;
        }
    fprintf(stderr, "wm: menu-tree assoc table full (%d)\n", SM_ASSOC_MAX);
    return -1;
}

/* Forget a sub-table subtree the owning table is about to destroy. */
static void sm_assoc_forget(MenuTbl *tbl) {
    if (!tbl) return;
    for (int i = 0; i < tbl->n; i++)
        if (tbl->items[i].sub) sm_assoc_forget(tbl->items[i].sub);
    int idx = sm_assoc_index(tbl);
    if (idx >= 0) sm_assoc[idx].tbl = NULL;
}

/* (Re)populate a Start-chain table from its union directory — fired by
 * the engine's popup_opening BEFORE the level is measured, so lazy disk
 * reads land in the paint (the WM_INITMENUPOPUP analogue). */
static void sm_populate(MenuTbl *tbl) {
    int ti = sm_assoc_index(tbl);
    if (ti < 0) return;
    for (int i = 0; i < tbl->n; i++)
        if (tbl->items[i].sub) sm_assoc_forget(tbl->items[i].sub);
    mc_menu_clear(tbl);
    const char *rel = sm_assoc[ti].rel;
    static menu_ent ents[MAX_MENU];    /* off the wasm stack */
    int n = menu_load_union(rel, ents, MAX_MENU);
    for (int i = 0; i < n; i++) {
        if (ents[i].is_dir) {
            MenuTbl *sub = mc_menu_create();
            char sr[288];
            snprintf(sr, sizeof sr, "%s%s%s", rel, *rel ? "/" : "",
                     ents[i].name);
            sm_assoc_add(sub, sr);
            mc_append(tbl, 1, 0, ents[i].name, sub);
        } else {
            mc_append(tbl, 0, (ti << 8) | i, ents[i].name, NULL);
        }
    }
}

/* Free the previous tracking's tables (deferred to the NEXT open: a
 * fired item's id resolves against them AFTER the chain closed). */
static void sm_free_tables(void) {
    if (sm_tbl) { mc_menu_destroy(sm_tbl); sm_tbl = NULL; }
    memset(sm_assoc, 0, sizeof sm_assoc);
}

static void wmmc_post_command(void *owner, int id) {
    (void)owner;
    if (mc_kind == MK_START) {
        int ti = id >> 8, row = id & 255;
        if (ti < 0 || ti >= SM_ASSOC_MAX || !sm_assoc[ti].tbl) return;
        MenuTbl *t = sm_assoc[ti].tbl;
        if (row >= t->n || !t->items[row].text) return;
        char path[600];
        menu_union_abs(sm_assoc[ti].rel, t->items[row].text,
                       path, sizeof path);
        activate(path);                /* records the MRU recent (0098) */
        menu_dismiss();                /* the root panel closes too */
    } else {
        ctx_command(id);
    }
}

static void wmmc_track_state(void *owner, int entering, int standalone) {
    (void)owner; (void)standalone;
    if (!entering) {
        sys_mode = 0;                  /* any dismissal ends a keyboard
                                          move/size (0102) */
        sys_target = 0;
    }
}

static void wmmc_popup_opening(void *owner, void *tbl, int idx) {
    (void)owner; (void)idx;
    if (mc_kind == MK_START) sm_populate((MenuTbl *)tbl);
}

static MCWIN wmmc_win_create(MCWIN parent, int dx, int dy, int w, int h,
                             int grab) {
    (void)grab;                        /* no kernel grab (TOOLTIP flavor):
                                          dismissal stays the 0091 focus-leave
                                          rule, keyboard stays on the root */
    int lvl = __mc.nlev;
    if (lvl < 0 || lvl >= MENU_MAX_DEPTH) return NULL;
    /* The surface this level hangs off (todos/0282): deeper levels anchor to
     * the previous column, the level-0 Start flyout to the root panel. A
     * ctx-menu ROOT has no owner surface (it opens at the pointer over the
     * desktop/taskbar/an icon) and stays an ownerless top-level. */
    SDL_Window *aw = (SDL_Window *)parent;
    int ax = 0, ay = 0;
    int px = dx, py = dy;
    if (parent) {                      /* deeper level: parent-relative */
        int pi = ov_index(aw);
        if (pi >= 0) { ax = ov[pi].x; ay = ov[pi].y; }
        px += ax; py += ay;
    } else if (mc_kind == MK_START) {
        aw = smroot.win;
        ax = smroot.x; ay = smroot.y;
    }
    /* Work-area clamp (the 0091 rules: a py at/past the bottom — the
     * taskbar anchor — lands the menu exactly above the bar). Done in
     * SCREEN coords BEFORE the parent-relative conversion below, so the
     * kernel's own into-the-screen clamp for anchored children is already
     * satisfied and never fights this one. */
    if (px + w > scr_w) px = scr_w - w;
    if (px < 0) px = 0;
    if (py + h > scr_h - BAR_H) py = scr_h - BAR_H - h;
    if (py < 0) py = 0;
    char title[16];
    if (mc_kind == MK_CTX) {
        if (lvl == 0) snprintf(title, sizeof title, "ctxmenu");
        else snprintf(title, sizeof title, "ctxmenu%d", lvl + 1);
    } else {
        snprintf(title, sizeof title, "startmenu%d", lvl + 2);
    }
    SDL_Window *win;
    if (aw) {
        /* A kernel anchored child (todos/0256): _wmZNormalize re-slots it
         * above its owner after every z mutation, so the column can never
         * render below the panel it cascades from — the 0282 fix. It
         * inherits the owner's layer and never takes focus by construction
         * (the root keeps the keyboard with zero FOCUS juggling). Title
         * after create: the popup API takes none, and the EV_CREATED echo
         * is matched by the ANCHORED flag + creation order, not title. */
        win = SDL_CreatePopupWindow(aw, px - ax, py - ay, w, h,
                                    SDL_WINDOW_TOOLTIP);
        if (win) SDL_SetWindowTitle(win, title);
    } else {
        win = SDL_CreateWindow(title, w, h, SDL_WINDOW_BORDERLESS);
    }
    if (!win) return NULL;
    ov[lvl].win = win;
    ov[lvl].sid = 0;
    ov[lvl].x = px;
    ov[lvl].y = py;
    return (MCWIN)win;
}

static void wmmc_win_destroy(MCWIN win) {
    int k = ov_index((SDL_Window *)win);
    if (k >= 0) { ov[k].win = NULL; ov[k].sid = 0; }
    SDL_DestroyWindow((SDL_Window *)win);
}

static HDC wmmc_win_begin(MCWIN win, int *wOut, int *hOut) {
    SDL_Surface *sf = SDL_GetWindowSurface((SDL_Window *)win);
    if (!sf) return NULL;
    if (wOut) *wOut = sf->w;
    if (hOut) *hOut = sf->h;
    HDC dc = __gdi_dc_wrap(sf->pixels, sf->w, sf->h, sf->pitch / 4);
    /* The ONE chrome font, selected explicitly (font-20 retune): nested
     * menu columns draw with the exact font object the taskbar/Start
     * root/desktop use — no fall-through to the DC default (which is
     * ALSO this font now that SYSTEM_FONT is 20px, but explicit beats
     * coincidental). */
    if (dc) SelectObject(dc, chrome_font());
    return dc;
}

static void wmmc_win_present(MCWIN win, HDC dc) {
    __gdi_dc_unwrap(dc);
    SDL_UpdateWindowSurface((SDL_Window *)win);
}

static void wmmc_screen_size(int *wOut, int *hOut) {
    *wOut = scr_w;
    *hOut = scr_h - BAR_H;             /* the work area caps a level's size */
}

static const MenuCoreOps wm_mc = {
    wmmc_post_command, wmmc_track_state, wmmc_popup_opening,
    wmmc_win_create, wmmc_win_destroy, wmmc_win_begin, wmmc_win_present,
    wmmc_screen_size,
};

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
    transients_dismiss();              /* likewise: run_dismiss is focus-leave
                                          driven too */
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
            spawn_path("/bin/sh", argv, &nkids, "wm");
        }
        run_dismiss();
        return;
    }
    if (sym == SDLK_BACKSPACE) {
        if (run_len > 0) {             /* pop one CODE POINT (Phase C) */
            run_len = __u8_prev(run_buf, run_len);
            run_buf[run_len] = 0;
        }
        return;
    }
    if (sym_text(sym)) {
        char b[4];
        int n = u8_enc((unsigned)sym, b);
        if (n > 0 && run_len + n <= RUN_MAX) {
            memcpy(run_buf + run_len, b, (size_t)n);
            run_len += n;
            run_buf[run_len] = 0;
        }
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
    draw_text_s(px, RUN_W, RUN_H, 8, 12, "RUN", txt);
    /* Sunken white input box: dark top/left. */
    fill_s(px, RUN_W, RUN_H, 8, 34, RUN_W - 16, 30, hi);
    fill_s(px, RUN_W, RUN_H, 8, 34, RUN_W - 16, 1, sh);
    fill_s(px, RUN_W, RUN_H, 8, 34, 1, 30, sh);
    /* The tail of the input that fits, plus a block caret. */
    const char *s = run_buf + text_tail(run_buf, RUN_W - 16 - 12 - 6);
    draw_text_s(px, RUN_W, RUN_H, 12, 42, s, txt);
    fill_s(px, RUN_W, RUN_H, 12 + text_w(s), 41, 2, 16, txt);
    SDL_UpdateWindowSurface(run_win);
}

/* ---- the Start menu flyout columns (todos/0078; menucore chain levels
 * since todos/0259 — the MENU_DEPTH-4 cap is gone; the single-column
 * root that anchors them is todos/0098+0132, further down) ---- */

/* Close the whole Start menu: the flyout chain, then the root panel.
 * (The chain alone closes level-wise via the engine's Esc/Left.) */
static void menu_dismiss(void) {
    if (__mc.open && mc_kind == MK_START) mc_close();
    if (smroot.win) {
        SDL_DestroyWindow(smroot.win);
        smroot.win = NULL;
        smroot.surf = NULL;
        smroot.sid = 0;
    }
}

static void sm_rebuild_left(void);        /* build the root's left pane (0098) */

/* Open the single-column root panel (0132), parked bottom-left above the
 * taskbar at its EV_CREATED echo (title "startmenu" — see handle_event). */
static int menu_open_root(void) {
    transients_dismiss();              /* the ctx_begin rule, for the Start
                                          menu: Ctrl+Esc can fire with a
                                          preview up (bar_click's own
                                          dismissals only cover the button) */
    sm_search[0] = 0; sm_search_len = 0;
    sm_lhover = -1;
    sm_rebuild_left();
    smroot.x = 0;
    smroot.y = scr_h - BAR_H - SM_ROOT_H;
    smroot.win = SDL_CreateWindow("startmenu", SM_ROOT_W, SM_ROOT_H,
                                  SDL_WINDOW_BORDERLESS);
    if (!smroot.win) return 0;
    smroot.surf = SDL_GetWindowSurface(smroot.win);
    smroot.sid = 0;
    return 1;
}

/* ---- single-column root: recents, pins, live search (todos/0098+0132) ---- */

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

/* Add existing one-path-per-line entries of `file` as column items of
 * `kind` (topmost first), reserving the trailing slots for All Programs +
 * the fixed places. Missing files / vanished paths are skipped silently. */
static void sm_load_list(const char *file, int kind) {
    FILE *f = fopen(file, "r");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof line, f) && sm_nleft < SM_ROWS - SM_FIXED - 1) {
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

/* Recursive flat walk of ONE menu-tree root, collecting leaf launchers
 * whose filename matches the query. Fills in readdir order, capped at
 * the pane; groups (dirs / links to dirs) recurse. Since 0259 the
 * search spans the UNION (both roots walked, /etc first — sm_have_name
 * dedups, so an /etc entry shadows its baked same-name twin). */
static int sm_have_name(const char *name) {
    for (int i = 0; i < sm_nleft; i++)
        if (strcmp(sm_left[i].name, name) == 0) return 1;
    return 0;
}

static void sm_search_walk(const char *dir, const char *q, int depth) {
    if (depth > SM_WALK_MAX || sm_nleft >= SM_ROWS) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) && sm_nleft < SM_ROWS) {
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
        if (sm_have_name(de->d_name)) continue;      /* union dedup (0259) */
        sm_item *it = &sm_left[sm_nleft++];
        snprintf(it->name, sizeof it->name, "%s", de->d_name);
        snprintf(it->path, sizeof it->path, "%s", path);
        it->kind = SMI_RESULT;
    }
    closedir(d);
}

/* Rebuild the column item list. Search mode (query non-empty): the flat
 * tree walk (the fixed places + All Programs are suppressed, and the tree
 * flyout is meaningless, so close it). Browse mode (XP/Vista/7 order,
 * 0132 follow-up): pinned entries, then MRU recents, a groove and the
 * fixed places (Settings, Run...), then a groove and the "All Programs"
 * row LAST — at the bottom of the column, above the search box. */
static void sm_rebuild_left(void) {
    sm_nleft = 0;
    if (sm_search_len > 0) {
        if (__mc.open && mc_kind == MK_START) mc_close();   /* tree flyout
                                                               meaningless */
        sm_search_walk("/etc/menu", sm_search, 0);          /* union (0259) */
        sm_search_walk("/usr/share/menu", sm_search, 0);
        return;
    }
    char pin[320], rec[320];
    snprintf(pin, sizeof pin, "%s/.config/pinned", sm_home());
    snprintf(rec, sizeof rec, "%s/.config/recent", sm_home());
    sm_load_list(pin, SMI_PIN);
    sm_load_list(rec, SMI_RECENT);
    static const struct { const char *name; int kind; } fixed[SM_FIXED] = {
        { "Settings", SMI_SETTINGS }, { "Run...", SMI_RUN },
    };
    for (int i = 0; i < SM_FIXED && sm_nleft < SM_ROWS - 1; i++) {
        sm_item *it = &sm_left[sm_nleft++];
        snprintf(it->name, sizeof it->name, "%s", fixed[i].name);
        it->path[0] = 0;
        it->kind = fixed[i].kind;
    }
    if (sm_nleft < SM_ROWS) {                 /* All Programs anchors the bottom */
        sm_item *it = &sm_left[sm_nleft++];
        snprintf(it->name, sizeof it->name, "%s", "All Programs");
        it->path[0] = 0;
        it->kind = SMI_ALLPROGS;
    }
}

/* The "All Programs" item index (it is appended last in browse mode), or -1
 * (search mode has no All Programs). */
static int sm_ap_index(void) {
    return (sm_nleft > 0 && sm_left[sm_nleft - 1].kind == SMI_ALLPROGS)
               ? sm_nleft - 1 : -1;
}

/* The DISPLAY row of item i. XP/Vista/7: "All Programs" pins to the last
 * row slot — the bottom of the panel, right above the search box — with an
 * empty gap above it; every other item stacks from the top (todos/0132
 * follow-up 2). Search mode has no All Programs, so this is the identity. */
static int sm_disp_row(int i) {
    return i == sm_ap_index() ? SM_ROWS - 1 : i;
}

/* Cascade the menu tree as a flyout off the column's right edge, aligned to
 * the All Programs DISPLAY row (the bottom of the panel). SM_ROOT_W spans
 * the band + column, so the flyout hangs snugly beside the row; anchoring at
 * the bottom row makes the win_create work-area clamp cascade it UPWARD
 * (Win7). The flyout lists the union tree root; its groups cascade
 * further via the ordinary flyout machinery. */
static void sm_open_allprogs(void) {
    int ap = sm_ap_index();
    if (ap < 0 || !smroot.win) return;
    if (__mc.open) mc_close();         /* one tracking at a time */
    sm_free_tables();                  /* the PREVIOUS tracking's tables die
                                          now (fired ids resolved already) */
    sm_tbl = mc_menu_create();
    sm_assoc_add(sm_tbl, "");          /* the union tree root */
    mc_kind = MK_START;
    mc_track_begin(&wm_mc, (void *)&wm_mc, (void *)&wm_mc, 1, 0);
    mc_level_open(sm_tbl, 0, NULL, smroot.x + SM_ROOT_W - 3,
                  smroot.y + sm_disp_row(ap) * SM_ROW_H);
}

/* Zone/row under a root-window point (single column since 0132; the gucOS
 * band occupies x < SM_SIDE_W). Returns 0 an item row, 2 the search box,
 * -1 dead zone (incl. the band and the gap above bottom-pinned All
 * Programs); the item index lands in *row. */
static int sm_root_hit(int x, int y, int *row) {
    if (x < SM_SIDE_W || x >= SM_ROOT_W) return -1;
    if (y >= SM_SEARCH_Y) return 2;              /* the search box strip */
    if (y < SM_PAD) return -1;
    int r = (y - SM_PAD) / SM_ROW_H;             /* the display row hit */
    int ap = sm_ap_index();
    if (r == SM_ROWS - 1 && ap >= 0) { *row = ap; return 0; }   /* bottom row */
    int top = ap >= 0 ? sm_nleft - 1 : sm_nleft; /* top-stacked item count */
    if (r >= 0 && r < top) { *row = r; return 0; }
    return -1;                                   /* the empty gap */
}

/* Launch a column row: All Programs cascades, the fixed places run their
 * builtin (Settings -> ctlpanel, Run... -> the run dialog); everything else
 * is a path through the shared activate() (which records the recent). */
static void sm_left_activate(int row) {
    if (row < 0 || row >= sm_nleft) return;
    sm_item *it = &sm_left[row];
    if (it->kind == SMI_ALLPROGS) { sm_open_allprogs(); return; }
    if (it->kind == SMI_SETTINGS) { menu_dismiss(); activate("/bin/ctlpanel"); return; }
    if (it->kind == SMI_RUN)      { menu_dismiss(); run_open(); return; }
    char path[256];
    snprintf(path, sizeof path, "%s", it->path);
    menu_dismiss();
    activate(path);
}

static void sm_root_click(int x, int y) {
    int row = -1;
    int zone = sm_root_hit(x, y, &row);
    if (zone == 0) { sm_lhover = row; sm_left_activate(row); }
    /* zone 2 (search box) / -1 (dead zone): a click INSIDE the menu keeps
     * it open — only an outside click / focus loss dismisses (Win7). */
}

static void sm_root_motion(int x, int y) {
    int row = -1;
    int zone = sm_root_hit(x, y, &row);
    sm_lhover = zone == 0 ? row : -1;
    if (zone == 0 && sm_left[row].kind == SMI_ALLPROGS &&
        !(__mc.open && mc_kind == MK_START))
        sm_open_allprogs();
}

/* Keyboard while only the root is open (todos/0098): printable keys type
 * into the search box (filtering the tree live), arrows walk the column,
 * Enter launches the cursor row (the top hit in search mode), Right
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
            if (__mc.open && __mc.nlev > 0)
                mc_route_key(1073741905);   /* Down: hot the first row */
        }
        return;
    }
    if (sym == SDLK_RETURN) {
        int row = sm_lhover >= 0 ? sm_lhover : (sm_nleft > 0 ? 0 : -1);
        sm_left_activate(row);
        return;
    }
    if (sym == SDLK_BACKSPACE) {
        if (sm_search_len > 0) {       /* pop one CODE POINT (Phase C) */
            sm_search_len = __u8_prev(sm_search, sm_search_len);
            sm_search[sm_search_len] = 0;
            sm_rebuild_left();
            sm_lhover = sm_nleft > 0 ? 0 : -1;
        }
        return;
    }
    if (sym_text(sym)) {
        char b[4];
        int n = u8_enc((unsigned)sym, b);
        if (n > 0 && sm_search_len + n < (int)sizeof sm_search) {
            memcpy(sm_search + sm_search_len, b, (size_t)n);
            sm_search_len += n;
            sm_search[sm_search_len] = 0;
            sm_rebuild_left();
            sm_lhover = sm_nleft > 0 ? 0 : -1;   /* preselect the top hit */
        }
    }
}

static void draw_root_menu(void) {
    if (!smroot.win) return;
    int w = SM_ROOT_W, h = SM_ROOT_H;
    uint32_t *px = (uint32_t *)smroot.surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0),
             sel = rgb(0, 0, 128), seltxt = rgb(255, 255, 255),
             white = rgb(255, 255, 255), ghost = rgb(128, 128, 128);
    const int X0 = SM_SIDE_W;              /* item column starts right of the band */
    fill_s(px, w, h, 0, 0, w, h, face);
    /* raised outer edge (Win95 chrome carried over) */
    fill_s(px, w, h, 0, 0, w, 1, hi);
    fill_s(px, w, h, 0, 0, 1, h, hi);
    fill_s(px, w, h, 0, h - 1, w, 1, sh);
    fill_s(px, w, h, w - 1, 0, 1, h, sh);
    /* the gucOS branding band down the left (the Win95 sidebar): a vertical
     * navy->blue gradient with "gucOS" rotated reading bottom-to-top, and a
     * sunken divider between the band and the item column (todos/0132). */
    for (int j = 1; j < h - 1; j++) {
        int b = 72 + (j * 140) / h;        /* darker at top, brighter at foot */
        fill_s(px, w, h, 1, j, SM_SIDE_W - 2, 1, rgb(0, 16, b));
    }
    draw_text_vert_s(px, w, h, SM_SIDE_W / 2, h / 2, "gucOS",
                     rgb(224, 224, 240));
    fill_s(px, w, h, SM_SIDE_W - 1, 1, 1, h - 2, sh);      /* divider shadow */
    fill_s(px, w, h, SM_SIDE_W, 1, 1, h - 2, hi);          /* divider hilite */
    /* the single column of items: pins/recents then Settings/Run stacked from
     * the top, and "All Programs" pinned to the BOTTOM row above the search
     * box (its display row is SM_ROWS-1, with an empty gap above it) */
    for (int i = 0; i < sm_nleft; i++) {
        int y = SM_PAD + sm_disp_row(i) * SM_ROW_H;
        int hl = i == sm_lhover;
        if (hl) fill_s(px, w, h, X0 + 2, y, SM_COL_W - 4, SM_ROW_H, sel);
        /* a groove above the fixed section (Settings) and above the bottom
         * All Programs row — the Win95 separators between the program list,
         * the places, and the bottom-pinned All-Programs gateway (todos/0132) */
        if ((sm_left[i].kind == SMI_ALLPROGS ||
             (i > 0 && sm_left[i].kind == SMI_SETTINGS)))
            fill_s(px, w, h, X0 + 6, y - 1, SM_COL_W - 12, 1, sh);
        draw_text_s(px, w, h, X0 + 10, y + (SM_ROW_H - CHROME_CAP) / 2, sm_left[i].name,
                    hl ? seltxt : txt);
        if (sm_left[i].kind == SMI_ALLPROGS) {            /* cascade arrow */
            int ax = X0 + SM_COL_W - 16, ay = y + (SM_ROW_H - 11) / 2;
            for (int t = 0; t < 6; t++)
                fill_s(px, w, h, ax + t, ay + t, 1, 11 - 2 * t, hl ? seltxt : txt);
        }
    }
    /* the search box (sunken white field) at the foot of the column */
    int bx = X0 + SM_PAD, by = SM_SEARCH_Y, bw = SM_COL_W - 2 * SM_PAD,
        bh = SM_SEARCH_H - 2;
    fill_s(px, w, h, bx, by, bw, bh, white);
    fill_s(px, w, h, bx, by, bw, 1, sh);
    fill_s(px, w, h, bx, by, 1, bh, sh);
    if (sm_search_len > 0) {
        const char *s = sm_search + text_tail(sm_search, bw - 8 - 3);
        draw_text_s(px, w, h, bx + 4, by + (bh - CHROME_CAP) / 2, s, txt);
        fill_s(px, w, h, bx + 4 + text_w(s), by + (bh - 16) / 2, 2, 16, txt);
    } else {
        draw_text_s(px, w, h, bx + 4, by + (bh - CHROME_CAP) / 2, "Search", ghost);
    }
    SDL_UpdateWindowSurface(smroot.win);
}

/* Toggle from the Start button, the Ctrl+Esc chord, or `wmctl menu` (all
 * ride EV_MENU or call here directly). The programs tree is the UNION of
 * /etc/menu and /usr/share/menu since 0259 (menu_load_union — no more
 * first-existing-dir shadowing); the fixed section keeps the menu useful
 * even over an empty programs list. */
static void menu_toggle(void) {
    ctx_dismiss();                     /* one popup at a time (todos/0091) */
    if (smroot.win) { menu_dismiss(); return; }
    menu_open_root();
}

static int menu_owns_sid(int32_t sid) {
    if (sid && sid == smroot.sid) return 1;
    return mc_kind == MK_START && ov_owns_sid(sid);
}

/* Keyboard while the Start menu is open (todos/0078): with a flyout
 * chain up the engine owns the keys (arrows/Right/Enter/Esc walk the
 * DEEPEST level; Esc and Left close level-wise, Win95-style — Left at
 * the first flyout returns to the root panel), plus the 0078 first-
 * letter type-ahead; with only the root open, sm_root_key (search box,
 * column nav). The focus holder makes every key land here. */
static void menu_key(int sym) {
    if (__mc.open && mc_kind == MK_START) {
        if (sym == SDLK_LEFT && __mc.nlev <= 1) { mc_close(); return; }
        if (!mc_route_key(sym)) mc_typeahead(sym);
        return;
    }
    sm_root_key(sym);
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

/* Per-filetype glyph dispatch (ticket #82): normalize one desktop entry to
 * its DK_ kind. Runnability wins over extension — the same order as
 * activate(), so an icon looks like what double-click DOES (a `#!` script
 * named build.sh is a launcher, not a text file). The extension map is
 * the ONE table below; anything unmatched is a generic document. */
static const struct { const char *ext; int kind; } desk_ext_map[] = {
    { "txt", DK_TEXT },  { "md", DK_TEXT },    { "log", DK_TEXT },
    { "cfg", DK_TEXT },  { "conf", DK_TEXT },  { "ini", DK_TEXT },
    { "json", DK_TEXT }, { "c", DK_TEXT },     { "h", DK_TEXT },
    { "png", DK_IMAGE }, { "ppm", DK_IMAGE },  { "pgm", DK_IMAGE },
    { "pbm", DK_IMAGE }, { "bmp", DK_IMAGE },  { "gif", DK_IMAGE },
    { "jpg", DK_IMAGE }, { "jpeg", DK_IMAGE }, { "xpm", DK_IMAGE },
    { "xbm", DK_IMAGE }, { "ico", DK_IMAGE },
    { "mgp", DK_DECK },  { "sent", DK_DECK },  { "deck", DK_DECK },
};

static int desk_kind(const menu_ent *e) {
    if (strcmp(e->name, "Recycle Bin") == 0) return DK_BIN;
    if (strcmp(e->name, "software") == 0) return DK_STORE;  /* storefront glyph (Q2) */
    if (e->is_dir) return DK_DIR;
    char path[300];
    snprintf(path, sizeof path, "/root/Desktop/%s", e->name);
    if (ow_is_runnable(path)) return DK_EXEC;  /* follows symlinks (0066) */
    char key[32];
    if (ow_key_for(e->name, key, sizeof key))
        for (size_t i = 0; i < sizeof desk_ext_map / sizeof desk_ext_map[0]; i++)
            if (strcmp(key, desk_ext_map[i].ext) == 0)
                return desk_ext_map[i].kind;
    return DK_FILE;
}

static int desk_resniff = 0;           /* Refresh drops the kind carry-over */

static void desk_load(void) {
    if (desk_press) return;            /* never reshuffle under a drag (0077) */
    if (desk_edit >= 0) return;        /* nor under an inline rename (0103) —
                                          the edited index must stay valid */
    int tf = fo_trash_count() > 0;     /* bin glyph state (todos/0093) */
    if (tf != desk_trash_full) { desk_trash_full = tf; desk_dirty = 1; }
    menu_ent fresh[MAX_DESK];
    int fcol[MAX_DESK], frow[MAX_DESK];
    int n = load_entries("/root/Desktop", fresh, MAX_DESK);
    /* Glyph kinds (ticket #82): the sniff opens the file (ow_is_runnable),
     * so carry the kind over from the live grid for unchanged entries —
     * the idle 1s re-read tick stays I/O-free. New names sniff; the ctx
     * menu's Refresh re-sniffs everything (desk_resniff). */
    for (int i = 0; i < n; i++) {
        int carried = 0;
        if (!desk_resniff)
            for (int k = 0; k < desk_n && !carried; k++)
                if (strcmp(fresh[i].name, desk[k].name) == 0 &&
                    fresh[i].is_link == desk[k].is_link &&
                    fresh[i].is_dir == desk[k].is_dir) {
                    fresh[i].kind = desk[k].kind;
                    carried = 1;
                }
        if (!carried) fresh[i].kind = desk_kind(&fresh[i]);
    }
    desk_resniff = 0;
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
            if (desk_elen > 0) {       /* pop one CODE POINT (Phase C) */
                desk_elen = __u8_prev(desk_ebuf, desk_elen);
                desk_ebuf[desk_elen] = 0;
                desk_dirty = 1;
            }
            return;
        }
        if (mod_ctrl || mod_gui) return;   /* chords are not text (0149) */
        if (sym_text(sym)) {
            char b[4];
            int n = u8_enc((unsigned)sym, b);
            if (n > 0 && desk_elen + n < (int)sizeof desk_ebuf) {
                memcpy(desk_ebuf + desk_elen, b, (size_t)n);
                desk_elen += n;
                desk_ebuf[desk_elen] = 0;
                desk_dirty = 1;
            }
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
    /* select-all — Explorer's chord, resolved through the scheme table
     * (^A / ⌘A, todos/0149; keys.h case-folds the shifted keysym) */
    if (sym >= 32 && sym < 127 &&
        key_action(KCTX_LIST,
                   (mod_ctrl ? KM_CTRL : 0) | (mod_shift ? KM_SHIFT : 0) |
                       (mod_gui ? KM_GUI : 0),
                   sym) == KA_SELECT_ALL) {
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

/* One icon glyph on its white tile, dispatched on the entry's DK_ kind
 * (ticket #82). All flat fill_s/rect_s rects in the two desktop inks.
 *
 * CENTER-PIXEL CONTRACT (probed by kernel + browser tests — updated
 * deliberately by #82, keep new glyphs inside it): the tile center
 * (ix+12, iy+12) is NAVY for anything that launches or opens a container
 * — programs (DK_EXEC solid block), folders (DK_DIR tab+body) and the
 * FULL Recycle Bin — and WHITE for every data-file glyph and the empty
 * bin. Pre-#82 all files drew the solid block; the exec/dir/bin pixels
 * are unchanged, only non-runnable files moved to white-center glyphs. */
static void draw_icon_glyph(uint32_t *px, int w, int h, int ix, int iy,
                            int kind) {
    uint32_t white = rgb(255, 255, 255), navy = rgb(0, 0, 128);
    fill_s(px, w, h, ix, iy, ICON_W, ICON_W, white);
    switch (kind) {
    case DK_BIN:                       /* basket (todos/0093): hollow when
                                          empty, contents block when full */
        fill_s(px, w, h, ix + 4, iy + 4, ICON_W - 8, 3, navy);   /* rim */
        fill_s(px, w, h, ix + 7, iy + 7, 3, ICON_W - 14, navy);  /* walls */
        fill_s(px, w, h, ix + ICON_W - 10, iy + 7, 3, ICON_W - 14, navy);
        fill_s(px, w, h, ix + 7, iy + ICON_W - 10, ICON_W - 14, 3, navy);
        if (desk_trash_full)
            fill_s(px, w, h, ix + 11, iy + 11, ICON_W - 22, ICON_W - 22, navy);
        break;
    case DK_DIR:                       /* folder tab + body (todos/0185) */
        fill_s(px, w, h, ix + 7, iy + 7, (ICON_W - 14) / 2, 4, navy);
        fill_s(px, w, h, ix + 7, iy + 11, ICON_W - 14, ICON_W - 18, navy);
        break;
    case DK_EXEC:                      /* the pre-#82 solid block */
        fill_s(px, w, h, ix + 8, iy + 8, ICON_W - 16, ICON_W - 16, navy);
        break;
    case DK_TEXT:                      /* page outline + text lines */
        rect_s(px, w, h, ix + 7, iy + 4, 18, 24, navy);
        fill_s(px, w, h, ix + 11, iy + 9, 10, 2, navy);
        fill_s(px, w, h, ix + 11, iy + 13, 10, 2, navy);
        fill_s(px, w, h, ix + 11, iy + 17, 10, 2, navy);
        fill_s(px, w, h, ix + 11, iy + 21, 6, 2, navy);
        break;
    case DK_IMAGE:                     /* frame, sun, mountain ridge */
        rect_s(px, w, h, ix + 5, iy + 6, 22, 19, navy);
        fill_s(px, w, h, ix + 9, iy + 10, 4, 4, navy);           /* sun */
        fill_s(px, w, h, ix + 8, iy + 20, 16, 4, navy);          /* ridge */
        fill_s(px, w, h, ix + 13, iy + 17, 6, 3, navy);          /* peak */
        break;
    case DK_DECK:                      /* presentation screen on a stand */
        rect_s(px, w, h, ix + 5, iy + 5, 22, 15, navy);
        fill_s(px, w, h, ix + 8, iy + 8, 14, 3, navy);           /* title */
        fill_s(px, w, h, ix + 9, iy + 13, 10, 2, navy);          /* bullet */
        fill_s(px, w, h, ix + 15, iy + 20, 3, 4, navy);          /* stand */
        fill_s(px, w, h, ix + 11, iy + 24, 10, 3, navy);         /* base */
        break;
    case DK_STORE:                     /* shopping bag (Q2 software center):
                                          two handle loops rising from the mouth
                                          of a filled navy bag — the twin arches
                                          read it as a bag, not a briefcase.
                                          Launcher → navy center (16,16). */
        fill_s(px, w, h, ix + 10, iy + 6, 2, 6, navy);           /* L handle outer */
        fill_s(px, w, h, ix + 13, iy + 6, 2, 6, navy);           /* L handle inner */
        fill_s(px, w, h, ix + 10, iy + 6, 5, 2, navy);           /* L handle top */
        fill_s(px, w, h, ix + 17, iy + 6, 2, 6, navy);           /* R handle inner */
        fill_s(px, w, h, ix + 20, iy + 6, 2, 6, navy);           /* R handle outer */
        fill_s(px, w, h, ix + 17, iy + 6, 5, 2, navy);           /* R handle top */
        fill_s(px, w, h, ix + 7, iy + 11, ICON_W - 14, ICON_W - 15, navy); /* bag body */
        break;
    default:                           /* DK_FILE: dog-eared page */
        rect_s(px, w, h, ix + 7, iy + 4, 18, 24, navy);
        fill_s(px, w, h, ix + 19, iy + 4, 6, 6, navy);           /* fold */
        break;
    }
}

/* Wrap a desktop icon label to at most two lines within maxw px (#91). A
 * label that fits whole stays ONE line (l2 emptied) — byte-identical to the
 * pre-#91 single-line render, so only genuinely-too-wide labels change.
 * Otherwise it breaks at the last space that keeps line 1 within maxw
 * (greedy word wrap, the space dropped); a single over-wide word breaks on
 * the codepoint boundary via text_fit. Line 2 gets a "..." tail when the
 * remainder still overflows. Returns the line count (1 or 2). */
static int desk_label_wrap(const char *name, int maxw, char *l1, char *l2, size_t cap) {
    l2[0] = 0;
    int fit = text_fit(name, maxw);
    if (name[fit] == 0) {                          /* whole label fits: one line */
        snprintf(l1, cap, "%s", name);
        return 1;
    }
    int brk = -1;                                  /* last space at/before the break */
    for (int i = 0; i < fit; i++)
        if (name[i] == ' ') brk = i;
    int l1len = brk > 0 ? brk : (fit > 0 ? fit : 1);
    int l2start = brk > 0 ? brk + 1 : l1len;
    if (l1len > (int)cap - 1) l1len = (int)cap - 1;
    memcpy(l1, name, (size_t)l1len);
    l1[l1len] = 0;
    const char *rest = name + l2start;
    if (rest[text_fit(rest, maxw)] == 0) {         /* remainder fits on line 2 */
        snprintf(l2, cap, "%s", rest);
    } else {                                       /* trim, leave room for "..." */
        char tmp[64];
        int room = text_fit(rest, maxw - text_w("..."));
        if (room > (int)sizeof tmp - 1) room = (int)sizeof tmp - 1;
        memcpy(tmp, rest, (size_t)room);
        tmp[room] = 0;
        snprintf(l2, cap, "%s...", tmp);
    }
    return 2;
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
        /* Per-filetype glyph (#82, dispatch above); links keep the black
         * launcher notch at the bottom-left (the Win95 arrow). */
        draw_icon_glyph(px, w, h, ix, iy, desk[i].kind);
        if (desk[i].is_link)
            fill_s(px, w, h, ix + 3, iy + ICON_W - 11, 8, 8, black);
        if (i == desk_edit) {          /* inline rename editor (todos/0103):
                                          a sunken white box + black text +
                                          caret over the label cell, sized to
                                          the tail that fits and clamped on. */
            const char *tail = desk_ebuf + text_tail(desk_ebuf, CELL_W - 8);
            int tw = text_w(tail);
            int bw = tw + 8;
            int bx = cx + (CELL_W - bw) / 2, by = cy + ICON_W + 6;
            if (bx < 0) bx = 0;
            if (bx + bw > w) bx = w - bw;
            fill_s(px, w, h, bx, by, bw, 24, white);
            rect_s(px, w, h, bx, by, bw, 24, black);
            draw_text_s(px, w, h, bx + 3, by + 4, tail, black);
            fill_s(px, w, h, bx + 3 + tw, by + 4, 2, 16, black);   /* caret */
            continue;
        }
        /* Label: full short names fit on one line; longer ones wrap to a
         * second line (#91) rather than hard-truncating ("Recycle Bin" no
         * longer clips to "Recycle B"). */
        char l1[64], l2[64];
        int nlines = desk_label_wrap(desk[i].name, CELL_W - 8, l1, l2, sizeof l1);
        int ly = cy + ICON_W + 10;
        int lw1 = text_w(l1), lx1 = cx + (CELL_W - lw1) / 2;
        /* Selection highlight: the 0029 navy label strip, per-set (0077),
         * one strip per rendered line. */
        if (desk_selmask >> i & 1)
            fill_s(px, w, h, lx1 - 2, ly - 2, lw1 + 4, 23, navy);
        draw_text_s(px, w, h, lx1, ly, l1, white);
        if (nlines == 2) {
            int ly2 = ly + CHROME_CAP + 6;         /* compact second-line pitch */
            int lw2 = text_w(l2), lx2 = cx + (CELL_W - lw2) / 2;
            if (desk_selmask >> i & 1)
                fill_s(px, w, h, lx2 - 2, ly2 - 2, lw2 + 4, 23, navy);
            draw_text_s(px, w, h, lx2, ly2, l2, white);
        }
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

/* Dismiss the ctx tracking (the engine tears the ov[] chain down; the
 * leaving track_state resets any keyboard move/size, 0102). */
static void ctx_dismiss(void) {
    if (__mc.open && mc_kind == MK_CTX) mc_close();
}

/* Begin a fresh ctx tracking: one popup at a time (0091), fresh tables
 * (the previous tracking's tables were kept alive for its fired id —
 * they die here). */
static MenuTbl *ctx_begin(void) {
    menu_dismiss();
    ctx_dismiss();
    transients_dismiss();              /* before the root is created, so the
                                          destroy's focus fall lands while
                                          ov[0].sid is still 0 and the
                                          EV_FOCUS gate ignores it */
    if (ctx_tbl) { mc_menu_destroy(ctx_tbl); ctx_tbl = NULL; }
    ctx_tbl = mc_menu_create();
    mc_kind = MK_CTX;
    return ctx_tbl;
}

static void ctx_grayable(MenuTbl *t, int id, const char *label, int grayed) {
    MenuItem *it = mc_append(t, 0, id, label, NULL);
    if (it && grayed) it->state = MF_GRAYED;
}

/* Track the built table anchored at screen (px, py) — the engine opens
 * level 0 through the wm ops (work-area clamp + "ctxmenu" title there). */
static void ctx_show(int px, int py) {
    /* the owner/cmd tokens are opaque engine currency; non-NULL so the
     * standalone fire path posts (the engine guards a NULL cmd) */
    mc_track_begin(&wm_mc, (void *)&wm_mc, (void *)&wm_mc, 1, 0);
    mc_level_open(ctx_tbl, 0, NULL, px, py);
}

/* Right-click empty desktop (Win95): New >, Sort by >, Refresh, then the
 * Display Properties shortcut into the Control Panel applet (0089). */
static void ctx_open_desktop(int x, int y) {
    MenuTbl *t = ctx_begin();
    ctx_target = 0;
    ctx_icon = -1;
    MenuTbl *nw = mc_menu_create();
    mc_append(nw, 0, CM_NEW_FOLDER, "Folder", NULL);
    mc_append(nw, 0, CM_NEW_FILE, "Text File", NULL);
    mc_append(t, 1, 0, "New", nw);
    MenuTbl *sb = mc_menu_create();
    mc_append(sb, 0, CM_SORT_NAME, "Name", NULL);
    mc_append(t, 1, 0, "Sort by", sb);
    mc_append(t, 0, CM_REFRESH, "Refresh", NULL);
    mc_append(t, 0, CM_ADD_DEFAULTS, "Add Default Icons", NULL);   /* Lane D */
    ctx_grayable(t, CM_PASTE, "Paste", !fo_clip_has());   /* 0092 */
    mc_append(t, 2, 0, NULL, NULL);
    mc_append(t, 0, CM_DISPLAY, "Display", NULL);
    ctx_show(x, y);
}

/* Right-click a desktop icon: Open + Cut/Copy of the selection set
 * (todos/0092 — the same format-2 clipboard file list fileman pastes)
 * + Delete to the Recycle Bin (todos/0093) + Rename (todos/0103, the inline
 * label editor — dir launchers rename like any file, the link name IS label).
 * The Recycle Bin icon itself gets its own menu: Open + Empty Recycle
 * Bin (grayed when the store is empty; unconfirmed by design — this
 * process has no dialog furniture, fileman's Empty confirms). */
static void ctx_open_icon(int idx, int x, int y) {
    MenuTbl *t = ctx_begin();
    ctx_target = 0;
    ctx_icon = idx;
    if (strcmp(desk[idx].name, "Recycle Bin") == 0) {
        mc_append(t, 0, CM_OPEN, "Open", NULL);
        mc_append(t, 2, 0, NULL, NULL);
        ctx_grayable(t, CM_EMPTY, "Empty Recycle Bin", !desk_trash_full);
    } else {
        mc_append(t, 0, CM_OPEN, "Open", NULL);
        /* EDIT (0202): documents only — regular files whose OPEN routes
         * through the openwith VIEWER (a .mgp deck). Launchers/binaries
         * and folders keep the pre-0202 rows, so their menu geometry (a
         * test-pinned contract) is unchanged. */
        char path[300];
        struct stat st;
        snprintf(path, sizeof path, "/root/Desktop/%s", desk[idx].name);
        if (stat(path, &st) == 0 && S_ISREG(st.st_mode) && !ow_is_runnable(path))
            mc_append(t, 0, CM_EDIT, "Edit", NULL);
        mc_append(t, 2, 0, NULL, NULL);
        mc_append(t, 0, CM_CUT, "Cut", NULL);
        mc_append(t, 0, CM_COPY, "Copy", NULL);
        mc_append(t, 0, CM_DELETE, "Delete", NULL);
        mc_append(t, 0, CM_RENAME, "Rename", NULL);   /* the inline editor (0103) */
    }
    ctx_show(x, y);
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
    MenuTbl *t = ctx_begin();
    ctx_target = w->sid;
    ctx_icon = -1;
    ctx_grayable(t, CM_RESTORE, "Restore",
                 !(w->minimized || w->maximized || w->snapped));
    ctx_grayable(t, CM_MINIMIZE, "Minimize", w->minimized);
    ctx_grayable(t, CM_MAXIMIZE, "Maximize", w->maximized || w->minimized);
    mc_append(t, 2, 0, NULL, NULL);
    mc_append(t, 0, CM_CLOSE, "Close", NULL);
    ctx_show(bx, scr_h);               /* clamp parks it above the bar */
}

/* Right-click the empty taskbar strip (todos/0101): the Win95 bar menu —
 * window-arrangement policy this process owns, plus Properties -> the
 * ctlpanel hub (todos/0089). Anchored at the click x, parked above the bar
 * by the win_create clamp. */
static void ctx_open_taskbar(int bx) {
    MenuTbl *t = ctx_begin();
    ctx_target = 0;
    ctx_icon = -1;
    mc_append(t, 0, CM_CASCADE, "Cascade", NULL);
    mc_append(t, 0, CM_TILE, "Tile", NULL);
    mc_append(t, 0, CM_MIN_ALL, "Minimize All", NULL);
    mc_append(t, 2, 0, NULL, NULL);
    mc_append(t, 0, CM_PROPERTIES, "Properties", NULL);
    ctx_show(bx, scr_h);
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
    MenuTbl *t = ctx_begin();
    ctx_target = w->sid;
    ctx_icon = -1;
    ctx_grayable(t, CM_RESTORE, "Restore",
                 !(w->minimized || w->maximized || w->snapped));
    ctx_grayable(t, CM_MOVE, "Move", w->minimized);
    ctx_grayable(t, CM_SIZE, "Size", w->minimized || !w->resizable);
    ctx_grayable(t, CM_MINIMIZE, "Minimize", w->minimized);
    ctx_grayable(t, CM_MAXIMIZE, "Maximize", w->maximized || w->minimized);
    mc_append(t, 2, 0, NULL, NULL);
    mc_append(t, 0, CM_CLOSE, "Close", NULL);
    /* Anchor just under the title bar's top-left; the win_create clamp
     * keeps it on-screen (right/bottom edges). */
    ctx_show(w->x, w->y);
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

/* Fire a ctx command id — the engine's post_command sink (0259): the
 * chain has already closed before this runs, preserving the 0091
 * dismiss-then-act order (a spawned child's create-focus finds no
 * popup). Grayed/separator rows never fired (engine rule); sub rows
 * cascaded in the engine; Move/Size never reach here (intercepted
 * BEFORE the engine fire so the popup stays up as the key grabber —
 * ctx_press/ctx_key below). */
static void ctx_command(int id) {
    int32_t target = ctx_target;
    int icon = ctx_icon;
    switch (id) {
    case CM_MOVE:
    case CM_SIZE:
        break;                         /* defensive: interception owns these */
    case CM_REFRESH:
        desk_resniff = 1;              /* re-sniff glyph kinds too (#82) */
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
        spawn_path("/bin/ctlpanel", argv, &nkids, "wm");
        break;
    }
    case CM_ADD_DEFAULTS: {        /* Lane D §6.3: fire-and-forget; the
                                      1s desk poll surfaces the result */
        char *argv[2] = { (char *)"desktop-defaults", 0 };
        spawn_path("/usr/bin/desktop-defaults", argv, &nkids, "wm");
        break;
    }
    case CM_OPEN: desk_launch(icon); break;
    case CM_EDIT: {                    /* 0202: open in the GUI text editor */
        if (icon < 0 || icon >= desk_n) break;
        char path[300], cmd[OW_CMD_MAX];
        snprintf(path, sizeof path, "/root/Desktop/%s", desk[icon].name);
        ow_editor(cmd, sizeof cmd);
        launch_assoc(cmd, path, &nkids, "wm");
        break;
    }
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
        spawn_path("/bin/ctlpanel", argv, &nkids, "wm");
        break;
    }
    }
}

/* The deepest open level's hot item, or NULL — the Move/Size
 * interception reads it (both mouse and keyboard paths). */
static MenuItem *mc_hot_item(void) {
    if (!__mc.open || __mc.nlev == 0) return NULL;
    MenuLevel *L = &__mc.lev[__mc.nlev - 1];
    if (!L->m || L->hot < 0 || L->hot >= L->m->n) return NULL;
    return &L->m->items[L->hot];
}

/* A press on chain level k (popup-local coords). Two front-end policies
 * ride ahead of the engine: (a) a dead-zone press inside the popup
 * dismisses (the 0091 rule; the engine alone would ignore it), and (b)
 * the sysmenu's Move/Size enter their keyboard mode WITHOUT firing —
 * the popup stays up as the key grabber (0102; the engine's fire path
 * would close it). */
static void ov_press(int k, int x, int y) {
    MenuLevel *L = &__mc.lev[k];
    RECT pr;
    SetRect(&pr, 0, 0, L->w, L->h);
    int row = mc_tbl_at(L->m, &pr, x, y);
    if (row < 0) {                     /* dead-zone press */
        if (mc_kind == MK_CTX) ctx_dismiss();
        else menu_dismiss();
        return;
    }
    MenuItem *it = &L->m->items[row];
    if (mc_kind == MK_CTX && it->kind == 0 &&
        !(it->state & (MF_GRAYED | MF_DISABLED)) &&
        (it->id == CM_MOVE || it->id == CM_SIZE)) {
        L->hot = row;
        mc_level_paint(k);
        sys_enter(it->id == CM_MOVE ? 1 : 2);
        return;
    }
    mc_level_mouse(k, WM_LBUTTONDOWN, x, y);
}

/* Keyboard on the open context menu: the engine walks/casades/fires
 * (arrows/Right/Left/Enter/Esc — arbitrary depth since 0259); a live
 * move/size mode owns the keys first (0102), and Enter on the Move/Size
 * rows enters the mode without firing (the popup stays up as the key
 * grabber — the click path's twin). */
static void ctx_key(int sym) {
    if (sys_mode) { sys_key(sym); return; }
    if (sym == SDLK_RETURN) {
        MenuItem *it = mc_hot_item();
        if (it && it->kind == 0 && !(it->state & (MF_GRAYED | MF_DISABLED)) &&
            (it->id == CM_MOVE || it->id == CM_SIZE)) {
            sys_enter(it->id == CM_MOVE ? 1 : 2);
            return;
        }
    }
    mc_route_key(sym);
}

static int ctx_owns_sid(int32_t sid) {
    return mc_kind == MK_CTX && ov_owns_sid(sid);
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
    if (h->plen < 12 || wmp_read_all(sock, head, 12) != 0) die("R_SHOT read");
    uint32_t n = h->plen - 12;
    int keep = peek_win && head[0] == peek_for &&
               head[1] > 0 && head[1] <= PEEK_W - 2 * PEEK_PAD &&
               head[2] > 0 && head[2] <= PEEK_H - 2 * PEEK_PAD &&
               (uint32_t)(head[1] * head[2] * 4) == n;
    if (!keep) { if (wmp_skip(sock, n) != 0) die("R_SHOT skip"); return; }
    if (wmp_read_all(sock, peek_px, (int)n) != 0) die("R_SHOT read");
    peek_tw = head[1];
    peek_th = head[2];
    peek_dirty = 1;
}

/* Raise the popup for wins[] entry `sid`, centered over its button. Its
 * EV_CREATED echo ("peek") parks it above the bar on the TOP layer and
 * hands focus straight back to whatever had it. */
static void peek_show(int32_t sid, int btn_x, int bw) {
    if (popup_holds_focus()) return;   /* a menu owns the focus: stand down */
    if (peek_win && peek_for == sid) return;     /* already up: just hold */
    peek_dismiss();
    peek_for = sid;
    peek_x = btn_x + bw / 2 - PEEK_W / 2;
    if (peek_x > scr_w - PEEK_W) peek_x = scr_w - PEEK_W;
    if (peek_x < 0) peek_x = 0;
    peek_win = SDL_CreateWindow("peek", PEEK_W, PEEK_H, SDL_WINDOW_BORDERLESS);
    if (!peek_win) { peek_for = 0; return; }
    peek_surf = SDL_GetWindowSurface(peek_win);
    peek_refresh_ms = peek_hover_ms = SDL_GetTicks();
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
    if (make_desk() != 0) fatal_sdl(2, "cannot recreate the desktop window");
    if (make_bar() != 0) fatal_sdl(2, "cannot recreate the taskbar window");
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

/* ---- window overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md) ----
 * The policy half of the 0025/0095 mechanism-split: the kernel composites live
 * miniatures at the cell rects WE compute and routes hover/pick; wm.c owns the
 * candidate set + grid layout + what a pick does. (overview_active is declared
 * up top with the other statics — saver_show references it.) */

/* Compute the Exposé grid and push it as WMP_OVERVIEW_SET. Candidate set =
 * every tracked window (wins[], LAUNCH order so the grid reads like the taskbar
 * — NOT recency; minimized INCLUDED, "find the window I lost" being the point;
 * furniture and foreign borderless popups never enter wins[], so nothing to
 * filter). Grid is aspect-fit (todos/EXPOSE §3): cols ~ sqrt(N*W/H), each
 * window letterboxed into its cell at scale <= 1 (never magnified), last row
 * centered. Returns the candidate count (0 = nothing to show). */
static int overview_layout_send(void) {
    int n = nwins;
    if (n <= 0) return 0;
    if (n > MAX_WIN) n = MAX_WIN;
    int wx = 0, wy = TITLE_H;                      /* work area: below the kernel
                                                      title bar, above the bar */
    int W = scr_w, H = scr_h - BAR_H - TITLE_H;
    if (W < 32 || H < 32) return 0;                /* degenerate screen */
    /* cols = ceil(sqrt(N*W/H)), clamped [1,N] — integer isqrt (no libm, the
     * tile_windows precedent): the least cols with cols*cols*H >= N*W. */
    int cols = 1;
    while ((long)cols * cols * H < (long)n * W) cols++;
    if (cols < 1) cols = 1;
    if (cols > n) cols = n;
    int rows = (n + cols - 1) / cols;
    int cellW = (W - (cols + 1) * OV_GAP) / cols;
    int cellH = (H - (rows + 1) * OV_GAP - rows * OV_CAPTION_H) / rows;
    if (cellW < 8) cellW = 8;                       /* no min-size floor (v1),
                                                       just a positive clamp */
    if (cellH < 8) cellH = 8;
    int32_t args[1 + 5 * MAX_WIN];
    args[0] = n;
    for (int i = 0; i < n; i++) {
        win_t *w = &wins[i];
        int r = i / cols, c = i % cols;
        int rowN = (r == rows - 1) ? (n - r * cols) : cols;    /* last row count */
        int rowW = rowN * cellW + (rowN + 1) * OV_GAP;
        int rowX0 = wx + (W - rowW) / 2 + OV_GAP;              /* centers the last
                                                                 row; full rows
                                                                 land at wx+GAP */
        int cellX = rowX0 + c * (cellW + OV_GAP);
        int cellY = wy + OV_GAP + r * (cellH + OV_CAPTION_H + OV_GAP);
        /* Aspect-fit the window's ON-SCREEN size into the cell, scale <= 1
         * (never magnify a small window), centered. It is a presentation rect,
         * not a SET_DST — no interaction with the scaled/configurable
         * exclusivity (todos/0024). */
        int sw = w->dst_w > 0 ? w->dst_w : (w->w > 0 ? w->w : cellW);
        int sh = w->dst_h > 0 ? w->dst_h : (w->h > 0 ? w->h : cellH);
        double sc = (double)cellW / (double)sw;
        double scy = (double)cellH / (double)sh;
        if (scy < sc) sc = scy;
        if (sc > 1.0) sc = 1.0;
        int fw = (int)(sw * sc + 0.5); if (fw < 1) fw = 1;
        int fh = (int)(sh * sc + 0.5); if (fh < 1) fh = 1;
        args[1 + 5 * i] = w->sid;
        args[2 + 5 * i] = cellX + (cellW - fw) / 2;
        args[3 + 5 * i] = cellY + (cellH - fh) / 2;
        args[4 + 5 * i] = fw;
        args[5 + 5 * i] = fh;
    }
    wmp_sendv(sock, WMP_OVERVIEW_SET, args, 1 + 5 * n);
    return n;
}

/* Recompute + re-push while active (EV_SCREEN / window created / destroyed):
 * a vacated cell closes up, a new window joins. If the last window went, exit. */
static void overview_relayout(void) {
    if (!overview_active) return;
    if (overview_layout_send() == 0) {
        wmp_send(sock, WMP_OVERVIEW_END, NULL, 0);
        overview_active = 0;
    }
}

/* wm.overview (Ctrl+Alt+E, `wmctl overview`, or the taskbar Task-View button):
 * toggle the window overview. Entering dismisses open popup furniture (the
 * saver_show precedent) and is mutually exclusive with the screensaver; N=0
 * refuses to enter (nothing to pick). */
static void overview_toggle(void) {
    if (overview_active) {
        wmp_send(sock, WMP_OVERVIEW_END, NULL, 0);
        overview_active = 0;
        return;
    }
    if (saver_win) { saver_dismiss(); return; }    /* mutually exclusive: the
                                                      chord just woke the saver */
    if (nwins <= 0) return;                         /* N=0: no empty state */
    menu_dismiss();
    ctx_dismiss();
    run_dismiss();
    peek_dismiss();
    date_dismiss();
    snapprev_dismiss();
    if (overview_layout_send() > 0) overview_active = 1;
}

/* The user picked (WMP_EV_OVERVIEW_PICK): sid 0 = dismiss (background click or
 * Esc), else that window — restore-if-minimized, focus, raise to top (the
 * taskbar-click codepath). Always exit first (a pure presentation clear). */
static void overview_pick(int32_t sid) {
    if (!overview_active) return;
    wmp_send(sock, WMP_OVERVIEW_END, NULL, 0);
    overview_active = 0;
    if (sid == 0) return;                           /* dismissed */
    win_t *w = find(sid);
    if (!w) return;
    int32_t f[1] = { sid };
    wmp_send(sock, WMP_FOCUS, f, 1);                /* focus un-minimizes (0014) */
    int32_t rs[2] = { sid, 0 };
    wmp_send(sock, WMP_RESTACK, rs, 2);             /* raise to top of its layer */
}

/* WMP_EV_HOTKEY (todos/KEYBINDING-OVERRIDE-SYSTEM.md §4): a non-reserved
 * grab-table entry matched. Dispatch by KTOK_* token to the SAME policy
 * handlers the legacy events reach — which still arrive from wmctl commands and,
 * pre-GRAB_SET at startup, from the kernel's default table, so wm.c keeps its
 * EV_CYCLE/MENU/SNAP_KEY/SYSMENU cases too. flags bit0 = Shift (cycle-reverse),
 * bit1 = key repeat; sid = the focused surface the event carries. */
static void hotkey_dispatch(int token, int flags, int sid) {
    switch (token) {
        case KTOK_SNAP_LEFT:  snap_key(0); break;
        case KTOK_SNAP_RIGHT: snap_key(1); break;
        case KTOK_SNAP_UP:    snap_key(2); break;
        case KTOK_SNAP_DOWN:  snap_key(3); break;
        case KTOK_CYCLE:      cycle((flags & 1) ? -1 : 1); break;
        case KTOK_START_MENU: menu_toggle(); break;
        case KTOK_SYSMENU: {
            win_t *w = find(sid);
            if (w && !w->minimized) ctx_open_sysmenu(w);
            break;
        }
        case KTOK_OVERVIEW:
            if (!(flags & 2)) overview_toggle();   /* skip auto-repeat */
            break;
        default: break;                  /* unknown token: ignore, never crash */
    }
}

static void handle_event(wmp_hdr *h) {
    if (h->type == WMP_EV_CREATED) {
        wmp_rec r;
        if (h->plen != sizeof r || wmp_read_all(sock, &r, (int)sizeof r) != 0) die("EV_CREATED read");
        if (r.pid == own_pid) {        /* our own furniture: park by title */
            if (r.flags & WMP_F_ANCHORED) {
                /* A menucore chain level (todos/0282): kernel-positioned
                 * from its owner + (dx,dy), layer-inherited, re-slotted
                 * above the owner by _wmZNormalize, never focused — nothing
                 * to park, and policy ops would EPERM (0256). The echo
                 * carries no title (the popup API takes none; it lands via
                 * SET_TITLE right after create), so record the sid by
                 * CREATION ORDER: echoes are emitted inside the create RPC,
                 * so the lowest live-but-unfilled ov slot is this level. */
                for (int d = 0; d < MENU_MAX_DEPTH; d++)
                    if (ov[d].win && !ov[d].sid) { ov[d].sid = r.sid; break; }
                return;
            }
            if (strncmp(r.title, "startmenu", 9) == 0) {   /* 0028/0078 */
                /* the root panel — chain levels are anchored (0282, above) */
                if (r.title[9] || !smroot.win) return;    /* dismissed pre-echo */
                smroot.sid = r.sid;
                int32_t a[3] = { r.sid, smroot.x, smroot.y };
                wmp_send(sock, WMP_MOVE, a, 3);
                /* Top layer like the bar (todos/0038) — created later,
                 * so the stable sort keeps the menu above it. */
                int32_t ly[2] = { r.sid, 1 };
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
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
                /* the ROOT level only — it opens at the pointer with no
                 * owner surface; chain levels ("ctxmenu2"+) are anchored
                 * children handled above (todos/0282) */
                if (r.title[7] || mc_kind != MK_CTX || !ov[0].win) return;
                ov[0].sid = r.sid;
                int32_t a[3] = { r.sid, ov[0].x, ov[0].y };
                wmp_send(sock, WMP_MOVE, a, 3);
                int32_t ly[2] = { r.sid, 1 };  /* top layer, like the menu */
                wmp_send(sock, WMP_SET_LAYER, ly, 2);
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
                /* Creating furniture steals focus (create-focus is kernel
                 * mechanism); hand it back like the desktop branch does.
                 * The bar was the ONE furniture echo without this, which
                 * only shows at the EV_SCREEN re-lay: a window whose
                 * EV_CREATED interleaves the destroy+recreate arrives in
                 * the stream between our two creates, so screen_changed's
                 * own hand-back ran before that window was in the model
                 * and the recreated bar kept the stolen focus (found by
                 * the 0181 gate: os-term's title went grey when faster
                 * pipes flipped the race). */
                for (int i = 0; i < nwins; i++)
                    if (wins[i].focused && !wins[i].minimized) {
                        int32_t f[1] = { wins[i].sid };
                        wmp_send(sock, WMP_FOCUS, f, 1);
                        break;
                    }
            }
            return;
        }
        if (r.flags & WMP_F_BORDERLESS) return;   /* not ours to manage */
        if (r.flags & WMP_F_TRANSIENT) {
            /* Owned/modal popup (todos/0281): a real framed, focusable window
             * — a MessageBox or dialog — but Win95 never lists owned dialogs
             * in the taskbar, so it stays OUT of wins[]: no taskbar button,
             * and cycle/cascade/tile/minimize-all (all wins[] walks) skip it.
             * It IS non-borderless, so the kernel keeps it unmapped until our
             * first geometry op (map-on-placement, 0069) — place() maps it and
             * gives it a sensible cascade position; the kernel owns its chrome
             * (title bar, drag, close box) from there. Its create-focus stands
             * (we send no FOCUS), so the modal has the keyboard as it should.
             * (The WMP_F_TRANSIENT flag could later also suppress the min/max
             * title-bar boxes on modals — deliberately NOT done here, 0281.) */
            place(r.sid, r.w, r.h);
            return;
        }
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
        overview_relayout();            /* a new window joins the grid (EXPOSE) */
        return;
    }
    /* All other events lead with the sid; none exceeds 8 words except
     * EV_TITLE (sid + 32-byte title), which reads its pieces directly. */
    int32_t p[8];
    if (h->plen > sizeof p && h->type != WMP_EV_TITLE) { wmp_skip(sock, h->plen); return; }
    switch (h->type) {
    case WMP_EV_DESTROYED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_DESTROYED read");
        if (p[0] == smroot.sid) smroot.sid = 0;           /* defensive (0028) */
        if (p[0] == run_sid) run_sid = 0;                 /* likewise (0078) */
        for (int d = 0; d < MENU_MAX_DEPTH; d++)          /* likewise (0091) */
            if (ov[d].win && p[0] == ov[d].sid) ov[d].sid = 0;
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
        overview_relayout();            /* a vacated cell closes up (EXPOSE) */
        break;
    }
    case WMP_EV_FOCUS: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_FOCUS read");
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
        if (smroot.win && smroot.sid && !menu_owns_sid(p[0])) menu_dismiss();
        if (run_win && run_sid && p[0] != run_sid) run_dismiss();
        /* Focus leaving the context menu dismisses it — outside-click on
         * any app window lands here (todos/0091). Gated on the root echo
         * having arrived, the run-dialog precedent. */
        if (__mc.open && mc_kind == MK_CTX && ov[0].sid &&
            !ctx_owns_sid(p[0])) ctx_dismiss();
        /* Desktop focus tracking (todos/0077): keys route to the icon grid
         * only while it holds focus; losing it also resets the tracked
         * modifiers (their keyups would land elsewhere). */
        if (desk_sid) {
            desk_focused = p[0] == desk_sid;
            if (desk_focused) {
                if (desk_edit >= 0) desk_edit_armed = 1;   /* editor focus landed */
            } else {
                mod_ctrl = mod_shift = mod_gui = 0;
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
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_CYCLE read");
        cycle(p[0]);
        break;
    }
    case WMP_EV_MENU: {                /* Start chord / wmctl menu (0078) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_MENU read");
        menu_toggle();
        break;
    }
    case WMP_EV_MINIMIZED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_MINIMIZED read");
        win_t *w = find(p[0]);
        if (w) { w->minimized = p[1] ? 1 : 0; if (w->minimized) w->focused = 0; }
        break;
    }
    case WMP_EV_TITLE: {
        int32_t sid;
        char t[32];
        if (h->plen != 4 + 32 || wmp_read_all(sock, &sid, 4) != 0 ||
            wmp_read_all(sock, t, 32) != 0) die("EV_TITLE read");
        win_t *w = find(sid);
        if (w) { memcpy(w->title, t, 32); w->title[31] = 0; }
        break;
    }
    case WMP_EV_MOVED: {                /* tracked for the EV_SCREEN re-clamp */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_MOVED read");
        win_t *w = find(p[0]);
        if (w) { w->x = p[1]; w->y = p[2]; }
        break;
    }
    case WMP_EV_CONFIGURED: {
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_CONFIGURED read");
        win_t *w = find(p[0]);
        /* configure implies resizable: dst tracks the buffer (todos/0024) */
        if (w) { w->w = p[1]; w->h = p[2]; w->dst_w = p[1]; w->dst_h = p[2]; }
        break;
    }
    case WMP_EV_SCALED: {               /* dst viewport changed (todos/0024) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SCALED read");
        win_t *w = find(p[0]);
        if (w) { w->dst_w = p[1]; w->dst_h = p[2]; }
        break;
    }
    case WMP_EV_SCALE_REQ: {            /* drag box -> aspect-fit SET_DST */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SCALE_REQ read");
        scale_request(p[0], p[1], p[2]);
        break;
    }
    case WMP_EV_TITLE_ACTIVATE: {       /* maximize toggle (todos/0025) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_TITLE_ACTIVATE read");
        title_activate(p[0]);
        break;
    }
    case WMP_EV_SNAP_EDGE: {            /* mid-drag edge zone (todos/0095) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SNAP_EDGE read");
        if (p[1] > 0 && find(p[0])) snapprev_show(p[1]);
        else snapprev_dismiss();
        break;
    }
    case WMP_EV_SNAP_DROP: {            /* title-drag release (todos/0095) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SNAP_DROP read");
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
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SNAP_KEY read");
        snap_key(p[0]);
        break;
    }
    case WMP_EV_HOTKEY: {               /* user grab-table chord (KEYBINDING §4) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_HOTKEY read");
        hotkey_dispatch(p[0], p[1], p[2]);   /* token, flags, focused sid */
        break;
    }
    case WMP_EV_SAVER: {                /* wmctl saver / Preview (0096) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SAVER read");
        saver_force();
        break;
    }
    case WMP_EV_OVERVIEW: {             /* wmctl overview / command twin (EXPOSE) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_OVERVIEW read");
        overview_toggle();
        break;
    }
    case WMP_EV_OVERVIEW_PICK: {        /* overview pick / dismiss (EXPOSE) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_OVERVIEW_PICK read");
        overview_pick(p[0]);
        break;
    }
    case WMP_EV_SYSMENU: {              /* Alt+Space / wmctl sysmenu (0102) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SYSMENU read");
        win_t *w = find(p[0]);          /* the focused sid it carries */
        if (w && !w->minimized) ctx_open_sysmenu(w);
        break;
    }
    case WMP_EV_SCREEN: {               /* dynamic resolution (todos/0023) */
        if (wmp_read_all(sock, p, (int)h->plen) != 0) die("EV_SCREEN read");
        scr_w = p[0]; scr_h = p[1];
        screen_changed();
        overview_relayout();            /* re-fit the grid to the new screen */
        break;
    }
    default:
        if (wmp_skip(sock, h->plen) != 0) die("event skip");
    }
}

/* Drain the socket: replies (fire-and-forget acks) are skipped, events
 * update the model. select() keeps the loop non-blocking. Returns the
 * frame count consumed — the event loop's "did anything happen" signal
 * (todos/0168). */
static int drain_socket(void) {
    int n = 0;
    for (;;) {
        fd_set rf;
        struct timeval tv = { 0, 0 };
        FD_ZERO(&rf);
        FD_SET(sock, &rf);
        if (select(sock + 1, &rf, NULL, NULL, &tv) <= 0) return n;
        wmp_hdr h;
        if (wmp_next(sock, &h) != 0) die("event stream");  /* endpoint gone: give up */
        if (h.type >= 0x80) handle_event(&h);
        else if (h.type == WMP_R_SHOT) peek_consume(&h);   /* THUMB (0063) */
        else if (h.type == WMP_R_IDLE) idle_consume(&h);   /* GET_IDLE (0096) */
        else if (wmp_skip(sock, h.plen) != 0) die("reply skip");
        n++;
    }
}

/* ---- the taskbar ---- */

/* Left edge of the right-aligned clock cell (todos/0101): the Show Desktop
 * sliver sits past it, so the button strip and clock both budget against
 * this, not bar_w. */
static int clock_left(void) { return bar_w - SHOWDESK_W - CLOCK_W; }

/* Left edge of the app-button strip: past the Start strip AND the Task-View
 * (overview) button right of it (Win10 position, todos/EXPOSE). btn_width /
 * draw_bar / bar_click / bar_rclick / bar_motion all budget from here. */
static int strip_left(void) { return START_W + TASKVIEW_W; }

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
    draw_text_s(px, DATE_W, DATE_H, 8, (DATE_H - CHROME_CAP) / 2, s, txt);
    SDL_UpdateWindowSurface(date_win);
}

/* Raise the date tooltip above the clock (right-aligned). pin=1 keeps it up
 * (a click toggle); pin=0 is a hover, idle-dismissed by the frame loop. Its
 * EV_CREATED echo ("datepop") parks it and hands focus back (the peek
 * pattern) so it never steals focus from an app. */
static void date_show(int pin) {
    if (popup_holds_focus()) return;   /* likewise (this branch had the only
                                          copy of the rule before) */
    date_hover_ms = SDL_GetTicks();
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
    int avail = clock_left() - strip_left() - BTN_GAP - 2;
    int w = avail / nwins - BTN_GAP;
    if (w > BTN_W) w = BTN_W;
    if (w < BTN_MIN) w = BTN_MIN;
    return w;
}

/* Taskbar hover (todos/0063 Aero Peek): motion over a drawn button raises
 * the live thumbnail popup for its window; anywhere else on the bar drops
 * it. An open menu wins every conflict — both raises below go through
 * peek_show/date_show, which stand down on popup_holds_focus(), so neither
 * a preview nor a tooltip can appear while one is up (the Start-menu early
 * return stays: with the root panel over the strip there is nothing here
 * worth computing). */
static void bar_motion(float fx) {
    if (smroot.win) return;
    int cx = clock_left();             /* the clock cell: date tooltip (0101) */
    if ((int)fx >= cx && (int)fx < cx + CLOCK_W) {
        date_show(0);
        peek_dismiss();
        return;
    }
    if (date_win && !date_pinned) date_dismiss();   /* left the clock: drop */
    int bw = btn_width();
    int rel = (int)fx - strip_left() - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = strip_left() + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if (rel >= 0 && rel % (bw + BTN_GAP) < bw && i < nwins &&
        x + bw <= cx) {                /* same overflow gate as draw_bar */
        peek_show(wins[i].sid, x, bw);
        peek_hover_ms = SDL_GetTicks();   /* still hovering: hold the popup */
    } else peek_dismiss();
}

static void bar_click(float fx) {
    peek_dismiss();                    /* a click acts; the preview drops */
    if ((int)fx < START_W) { date_dismiss(); menu_toggle(); return; }  /* Start */
    menu_dismiss();                    /* any other taskbar click dismisses */
    ctx_dismiss();                     /* likewise (todos/0091) */
    /* The Task-View button right of Start (todos/EXPOSE): toggle the overview
     * straight to layout+SET — no self-round-trip through the kernel needed. */
    if ((int)fx < strip_left()) { date_dismiss(); overview_toggle(); return; }
    /* Show Desktop sliver, then the clock cell (todos/0101): the sliver
     * toggles minimize-all/restore, the clock toggles the date tooltip. */
    if ((int)fx >= bar_w - SHOWDESK_W) { date_dismiss(); show_desktop_toggle(); return; }
    if ((int)fx >= clock_left()) { date_toggle(); return; }
    date_dismiss();
    int bw = btn_width();
    int rel = (int)fx - strip_left() - BTN_GAP;
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
    if ((int)fx < strip_left()) { ctx_dismiss(); return; }   /* Start + Task-View:
                                                                reserved */
    int bw = btn_width();
    int rel = (int)fx - strip_left() - BTN_GAP;
    int i = rel / (bw + BTN_GAP);
    int x = strip_left() + BTN_GAP + i * (bw + BTN_GAP) + 2;
    if (rel >= 0 && rel % (bw + BTN_GAP) < bw && i < nwins &&
        x + bw <= clock_left()) {      /* on a drawn button */
        ctx_open_bar(&wins[i], x);
        return;
    }
    ctx_open_taskbar((int)fx);         /* empty strip / clock / show-desktop */
}

/* Present the taskbar only when its pixels actually changed (todos/0168
 * piece D, recovered from the reverted 0160 attempt). frame_cb redraws the
 * bar every wake, but SDL_UpdateWindowSurface bumps the surface's frame-seq
 * UNCONDITIONALLY — so an unconditional present churned the compositor's
 * damage signature on every wake and would defeat the 0169 idle-GPU skip
 * (the bar was the one surface never going quiet on a static desktop; the
 * desktop layer is already desk_dirty-gated, the popups activity-gated). A
 * cheap memcmp against the last-presented bytes keeps the bar off the
 * present path while it is visually static and still catches everything
 * draw_bar renders — the clock's per-minute tick, focus relief, overflow
 * shrink, the Show Desktop press state. */
static uint32_t *bar_snap = NULL;   /* last-presented bar pixels */
static int bar_snap_w = 0;          /* its width (mismatch => force a present) */
static void bar_present(void) {
    size_t bytes = (size_t)bar_w * BAR_H * 4;
    if (bar_snap_w != bar_w || !bar_snap) {   /* first present or a resize */
        free(bar_snap);
        bar_snap = malloc(bytes);
        bar_snap_w = bar_snap ? bar_w : 0;
        if (bar_snap) memcpy(bar_snap, bar_surf->pixels, bytes);
        SDL_UpdateWindowSurface(bar_win);
        return;
    }
    if (memcmp(bar_snap, bar_surf->pixels, bytes) == 0) return;   /* static */
    memcpy(bar_snap, bar_surf->pixels, bytes);
    SDL_UpdateWindowSurface(bar_win);
}

static void draw_bar(void) {
    uint32_t *px = (uint32_t *)bar_surf->pixels;
    uint32_t face = rgb(192, 192, 192), hi = rgb(255, 255, 255),
             sh = rgb(96, 96, 96), txt = rgb(0, 0, 0);
    fill(px, 0, 0, bar_w, BAR_H, face);
    fill(px, 0, 0, bar_w, 1, hi);                       /* top edge highlight */
    /* The Start button (todos/0028): raised normally, sunken while open. */
    {
        int down = smroot.win != NULL;
        fill(px, 2, 3, START_W - 4, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, 2, 3, START_W - 4, 1, down ? sh : hi);
        fill(px, 2, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, 2, BAR_H - 4, START_W - 4, 1, down ? hi : sh);
        fill(px, START_W - 3, 3, 1, BAR_H - 6, down ? hi : sh);
        draw_text(px, 8, (BAR_H - CHROME_CAP) / 2, "START", txt);
    }
    /* The Task-View / overview button (todos/EXPOSE): right of Start, a small
     * three-pane glyph; sunken while the overview is active. */
    {
        int bx = START_W, down = overview_active;
        fill(px, bx + 1, 3, TASKVIEW_W - 2, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, bx + 1, 3, TASKVIEW_W - 2, 1, down ? sh : hi);
        fill(px, bx + 1, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, bx + 1, BAR_H - 4, TASKVIEW_W - 2, 1, down ? hi : sh);
        fill(px, bx + TASKVIEW_W - 2, 3, 1, BAR_H - 6, down ? hi : sh);
        uint32_t g = rgb(0, 0, 128);              /* three offset window panes */
        int gx = bx + 4, gy = 9;
        fill(px, gx, gy, 8, 6, g);                /* top-left */
        fill(px, gx + 10, gy, 6, 6, g);           /* top-right */
        fill(px, gx + 3, gy + 8, 10, 6, g);       /* bottom-center */
    }
    int bw = btn_width();              /* overflow shrink (todos/0031) */
    int cx = clock_left();
    for (int i = 0; i < nwins; i++) {
        int x = strip_left() + BTN_GAP + i * (bw + BTN_GAP) + 2;
        if (x + bw > cx) break;                /* never under the clock */
        int down = wins[i].focused && !wins[i].minimized;
        /* Win95 button relief: raised normally, sunken when active. */
        fill(px, x, 3, bw, BAR_H - 6, down ? rgb(222, 222, 222) : face);
        fill(px, x, 3, bw, 1, down ? sh : hi);
        fill(px, x, 3, 1, BAR_H - 6, down ? sh : hi);
        fill(px, x, BAR_H - 4, bw, 1, down ? hi : sh);
        fill(px, x + bw - 1, 3, 1, BAR_H - 6, down ? hi : sh);
        char label[40];
        int n = text_fit(wins[i].title, bw - 10);
        if (n > (int)sizeof label - 1) n = (int)sizeof label - 1;
        memcpy(label, wins[i].title, (size_t)n);
        label[n] = 0;
        draw_text(px, x + 6, (BAR_H - CHROME_CAP) / 2, label,
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
        draw_text(px, cx + 8, (BAR_H - CHROME_CAP) / 2, hhmm, txt);
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
    bar_present();                     /* present only on change (0168/0160) */
}

/* One iteration of the event loop (todos/0168 renamed this from a per-rAF
 * frame callback — it now runs per WAKE: input, socket data, or the park
 * timeout, ~1/s idle). Returns nothing; main() parks between calls. */
static void frame_cb(void) {
    int activity = drain_socket();
    reap_kids(&nkids);
    uint64_t now_ms = SDL_GetTicks();
    /* Coarse /root/Desktop watch (todos/0029): one readdir per second of
     * wall clock — the loop wakes at least that often (the 1s park), and
     * no watch API exists or is needed. */
    if (now_ms - desk_poll_ms >= 1000) { desk_poll_ms = now_ms; desk_load(); }
    /* The screensaver's idle poll rides the same cadence (todos/0096). */
    if (now_ms - saver_poll_ms >= 1000) { saver_poll_ms = now_ms; saver_poll(); }
    /* Rebuild+push the kernel key-grab table when scheme/overrides change
     * (todos/KEYBINDING-OVERRIDE-SYSTEM.md §4) — same 1 Hz config cadence. */
    if (now_ms - grab_poll_ms >= 1000) { grab_poll_ms = now_ms; grab_table_push(); }
    /* Many windows, one queue: dispatch by windowID (0028/0029/0063/0078).
     * Menu columns and the run dialog come and go inside handlers, so
     * their ids are resolved per event (ov_level_for), not cached. */
    SDL_WindowID did = desk_win ? SDL_GetWindowID(desk_win) : 0;
    SDL_WindowID pkid = peek_win ? SDL_GetWindowID(peek_win) : 0;
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        activity = 1;
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
            int lv = ov_level_for(e.button.windowID);
            if (smroot.win && e.button.windowID == SDL_GetWindowID(smroot.win))
                sm_root_click((int)e.button.x, (int)e.button.y);   /* 0098 */
            else if (lv >= 0) {        /* a chain level (0091/0259) */
                if (e.button.button == 1)
                    ov_press(lv, (int)e.button.x, (int)e.button.y);
            }
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
            int lv = ov_level_for(e.button.windowID);
            if (lv >= 0 && e.button.button == 1) {
                /* press-drag-release (0259) — but not while a keyboard
                 * move/size holds the popup as its grabber: the Move/Size
                 * press was intercepted (never fired), and its release
                 * must not fire the row through the engine either */
                if (!sys_mode)
                    mc_level_mouse(lv, WM_LBUTTONUP,
                                   (int)e.button.x, (int)e.button.y);
            }
            else if (desk_win && e.button.windowID == did && e.button.button == 1)
                desk_up(e.button.x, e.button.y);   /* marquee/drag end (0077) */
        } else if (e.type == SDL_EVENT_MOUSE_MOTION) {
            int lv = ov_level_for(e.motion.windowID);
            if (smroot.win && e.motion.windowID == SDL_GetWindowID(smroot.win))
                sm_root_motion((int)e.motion.x, (int)e.motion.y);   /* 0098 */
            else if (lv >= 0)          /* hover-track a chain level (0259) */
                mc_level_mouse(lv, WM_MOUSEMOVE,
                               (int)e.motion.x, (int)e.motion.y);
            else if (desk_win && e.motion.windowID == did) {
                peek_dismiss();        /* pointer left the bar (0063) */
                desk_motion(e.motion.x, e.motion.y, e.motion.state);
            } else if (peek_win && e.motion.windowID == pkid) {
                peek_hover_ms = SDL_GetTicks();  /* hovering the preview holds it */
            } else if (date_win && e.motion.windowID == SDL_GetWindowID(date_win)) {
                date_hover_ms = SDL_GetTicks();  /* hovering the tooltip holds it (0101) */
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
            else if (k == SDLK_LGUI || k == SDLK_RGUI) mod_gui = down;
            /* Keyboard (todos/0078): an open context menu owns the keys
             * first (its root holds focus — todos/0091); then the Start
             * menu, the run dialog, and the focused desktop's icon grid
             * (todos/0077), in that order. */
            if (down) {
                if (sys_mode || (__mc.open && mc_kind == MK_CTX)) ctx_key(k);
                else if (smroot.win) menu_key(k);
                else if (run_win) run_key(k);
                else if (desk_focused) desk_key(k);
            }
        } else if (e.type == SDL_EVENT_QUIT) exit(0);
    }
    /* Aero Peek housekeeping (todos/0063): keep the thumbnail live while
     * the popup is up; drop it once nothing has hovered it for a while.
     * RE-READ the clock here: now_ms is from frame entry, but the hover/
     * refresh stamps are written DURING the event handling above
     * (peek_show / bar_motion / date_show) — against an entry-time now a
     * fresh stamp sits in the future and the unsigned delta wraps huge,
     * dismissing a popup the same frame it was shown (the 60%-flaky
     * os-aero peek leg that caught this). A fresh read is >= any stamp
     * taken this iteration. */
    uint64_t hk_ms = SDL_GetTicks();
    if (peek_win) {
        if (hk_ms - peek_hover_ms >= PEEK_IDLE_MS) peek_dismiss();
        else if (hk_ms - peek_refresh_ms >= PEEK_REFRESH_MS) {
            peek_refresh_ms = hk_ms;
            peek_request();
        }
    }
    /* The date tooltip (todos/0101): a hover (unpinned) drops once the
     * pointer has been off the clock for a while — the wm only sees motion
     * over its own windows, so this backstop mirrors PEEK_IDLE_MS. A pinned
     * (click-opened) tooltip stays until clicked away. */
    if (date_win && !date_pinned && hk_ms - date_hover_ms >= PEEK_IDLE_MS)
        date_dismiss();
    draw_bar();
    /* Popup furniture redraws on ACTIVITY only (todos/0168): its content
     * changes exclusively in the event/socket handlers above — an idle
     * 1s-tick wake must not re-present a static menu (present churn keeps
     * the 0169 compositor awake). */
    if (activity) {
        draw_root_menu();              /* chain levels paint themselves in
                                          the engine on state change (0259) */
        draw_run();
    }
    draw_desk();
    if (peek_dirty) { peek_dirty = 0; draw_peek(); }
    draw_saver();                      /* every wake: frame-paced while live (0096) */
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
    if (wmp_send(sock, WMP_SUBSCRIBE, NULL, 0) != 0) die("subscribe send");
    wmp_hdr h;
    if (wmp_next_reply(sock, &h) != 0) die("subscribe reply");
    if (h.type != WMP_R_OK || h.plen < 8) {
        fprintf(stderr, "wm: unexpected subscribe reply (type 0x%x, %u bytes)\n",
                h.type, h.plen);
        return 1;
    }
    int32_t dims[2];
    if (wmp_read_all(sock, dims, 8) != 0) die("subscribe reply read");
    if (wmp_skip(sock, h.plen - 8) != 0) die("subscribe reply skip");
    scr_w = dims[0]; scr_h = dims[1];

    /* Push the key-grab table BEFORE the loop so the active scheme is in
     * effect from boot (todos/KEYBINDING-OVERRIDE-SYSTEM.md §4) — otherwise
     * the macos scheme would spend the first poll interval on the kernel
     * default (windows) table. In the windows scheme this is behaviour-
     * identical to that default, so it changes nothing there. */
    grab_table_push();

    /* The snapshot (EV_CREATED per existing surface + EV_FOCUS) follows on
     * the socket; the frame loop's drain consumes it like live events, so
     * pre-existing windows get buttons AND get re-placed — (re)starting
     * the WM deliberately tidies the desktop. */
    SDL_Init(SDL_INIT_VIDEO);
    if (make_desk() != 0)              /* bottom of z; created first (0029) */
        fatal_sdl(2, "cannot create the desktop window");
    if (make_bar() != 0)
        fatal_sdl(2, "cannot create the taskbar window");
    /* Desktop is up: the startup chime (todos/0094; sounds.h fire-and-
     * forget — the kernel drains the clip, pumpless kernels drop it).
     * Deliberately per wm start, not per boot: a `wm &` respawn is a new
     * session, like a Windows logon. */
    snd_play_event("SystemStart");
    /* Event-driven main loop (todos/0168, IDLE-POWER piece W; unified
     * wait todos/0178): wm was a frame-callback app — 60 wakes/s whether
     * or not anything happened, and the one app that would forever keep
     * the 0169 compositor from parking. Each iteration handles whatever
     * woke it (frame_cb drains the socket AND the SDL queue), then parks
     * in the kernel's unified WAIT on wm's TWO event sources — the WMP
     * socket and the input ring. Readiness-check and park are atomic
     * kernel-side, so nothing can land in a check→park gap (the 0168
     * ring kick + pre-park select this replaced). Import returns are
     * cooperative-signal safe points, and a posted signal completes the
     * park promptly as -1. While the screensaver animates it paces
     * ~60Hz; otherwise 1s parks (the clock / saver-idle / Desktop-watch
     * cadence). */
    for (;;) {
        frame_cb();
        __wait(&sock, 1, 1, saver_win ? 16 : 1000);
    }
}
