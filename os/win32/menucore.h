/* menucore.h — the ONE menu engine's public surface (todos/0257 A7/A13,
 * extracted to menucore.c by the M4 milestone, todos/0259).
 *
 * The engine (model + geometry + tracking + raster over HDC) lives in
 * menucore.c and touches the world outside itself ONLY through the
 * MenuCoreOps vtable below — a real struct-of-fn-pointers, so the
 * compiler enforces the boundary instead of a prose promise (A7). The
 * engine's outward dependencies (design note §7 + A5):
 *
 *   (a) an HDC over the overlay window's pixels   -> win_begin/win_present
 *   (b) overlay windows create/destroy            -> win_create/win_destroy
 *       (user32: SDL_CreatePopupWindow — the kernel anchored-child
 *       primitive of todos/0256, POPUP_MENU levels hold the kernel grab;
 *       wm.c: its borderless top-layer furniture windows, which must hold
 *       kernel focus to receive keys — the WM has no parent app window)
 *   (c) a command sink                            -> post_command
 *       (user32: PostMessage WM_COMMAND; wm.c: the CM-id/launch dispatch)
 *   (d) popup-state notifications                 -> track_state/popup_opening
 *       (user32: WM_ENTERMENULOOP + WM_INITMENU / WM_EXITMENULOOP /
 *       WM_INITMENUPOPUP — fired BEFORE a level is measured, so live
 *       check/gray mutations land in the paint; wm.c: lazy directory
 *       population of Start-menu flyout levels)
 *   (e) screen dimensions for the level size cap  -> screen_size
 *       (user32: SDL_GetDisplayBounds; wm.c: its tracked work area) —
 *       keeps the engine SDL-free; on-screen POSITION is the window
 *       layer's job (user32: the kernel anchored-child slide clamp;
 *       wm.c: its own work-area clamp in win_create)
 *
 * Both front-ends instantiate the vtable: user32.c (the win32 HMENU API,
 * bar strip furniture, WndProc notifications, the agent protocol) and
 * os/wm.c (Start-menu flyouts + context menus — the fork this seam
 * existed to delete, per A13; reseated by M4, curing wm.c's MENU_DEPTH-4
 * flyout and one-ctxmenu2 depth caps). The raster dependency is only
 * gdi32 (HDC); nothing here knows about HWNDs, SDL, or the transport
 * under the overlay windows. Deliberately NOT a registration framework:
 * one plain vtable, passed at tracking start, instantiated once per
 * front-end.
 *
 * One engine instance per process (menus are modal; one open chain), so
 * the chain state is a single extern — front-ends READ it freely (agent
 * dumps, bar highlight, windowID demux) but mutate only through the API.
 */
#pragma once

#include <windows.h>

/* Engine geometry (shared with any front-end; SM_CYMENU must agree). */
#define MENU_BAR_H 30
#define MENU_ITEM_H 30
#define MENU_SEP_H 10
#define MENU_GUTTER 20

/* Open-chain depth bound (A12: a CHAIN, the Win32 #32768 stack — not the
 * old one-nested-level scalar). 16 is far past what any screen can hang;
 * exceeding it is a LOUD refusal, never a silent no-op. */
#define MENU_MAX_DEPTH 16

typedef void *MCWIN;            /* an overlay window handle
                                   (user32 front-end: SDL_Window *;
                                   wm.c front-end: its furniture window) */

typedef struct MenuCoreOps {
    /* Fire tracked item `id` at `owner` (an opaque front-end token given
     * to the engine when tracking started; standalone trackings post at
     * the separate `cmd` token). Called AFTER the chain has closed. */
    void (*post_command)(void *owner, int id);
    /* Tracking bracket: entering (1) / leaving (0) the modal menu loop.
     * `standalone` marks a TrackPopupMenu-style tracking vs a bar one. */
    void (*track_state)(void *owner, int entering, int standalone);
    /* Level table `tbl` is about to open as the chain level anchored on
     * item `idx` — fired BEFORE measuring/creating its window, so the
     * front-end may mutate (or lazily populate) the table's items. */
    void (*popup_opening)(void *owner, void *tbl, int idx);
    /* Create an overlay window: a child of `parent` at (dx, dy) in the
     * parent's space (parent == the ownerWin passed to mc_level_open for
     * level 0), w x h. grab != 0 = a press outside the window tree
     * dismisses (delivered as a close request) and is consumed — the
     * kernel grab. NULL on failure (fail loud upstream). */
    MCWIN (*win_create)(MCWIN parent, int dx, int dy, int w, int h, int grab);
    void (*win_destroy)(MCWIN win);
    /* Wrap the overlay's pixels as a DC for one paint; the matching
     * win_present unwraps AND presents. wOut/hOut get the live dims. */
    HDC (*win_begin)(MCWIN win, int *wOut, int *hOut);
    void (*win_present)(MCWIN win, HDC dc);
    /* Screen (or work-area) dims — the open level's SIZE cap (a menu
     * taller/wider than the screen is clipped, not refused). */
    void (*screen_size)(int *wOut, int *hOut);
} MenuCoreOps;

/* ---- the model: an item tree ------------------------------------- */

typedef struct MenuTbl MenuTbl;

typedef struct MenuItem {
    int kind;                   /* 0 item, 1 popup, 2 separator */
    int id;
    UINT state;                 /* MF_CHECKED | MF_GRAYED | MF_DISABLED */
    char *text;                 /* UTF-8; '&' mnemonic kept, '\t' splits accel */
    MenuTbl *sub;
} MenuItem;

struct MenuTbl {
    int n, cap;
    MenuItem *items;
};

#define MENU_T(m) ((MenuTbl *)(m))

MenuTbl *mc_menu_create(void);
/* Free the table's items (texts + sub-tables, recursively); the table
 * itself survives for repopulation (wm.c's lazy directory levels). */
void mc_menu_clear(MenuTbl *m);
void mc_menu_destroy(MenuTbl *m);
MenuItem *mc_append(MenuTbl *m, int kind, int id, const char *text,
                    MenuTbl *sub);
/* Label lookup ('&' stripped, accel tab cut) / command-id lookup /
 * the (table, row) holding `it` anywhere under root — ANY depth. */
MenuItem *mc_find_label(MenuTbl *m, const char *label);
MenuItem *mc_find_cmd(MenuTbl *m, int id);
MenuTbl *mc_locate(MenuTbl *m, const MenuItem *it, int *rowOut);
MenuItem *mc_item_of(MenuTbl *m, UINT id, UINT flags);   /* MF_BYPOSITION */

/* '&'-mnemonic strip (shared with the agent protocol's label matching). */
void mc_strip_amp(const char *in, char *out, int cap);

/* ---- geometry + raster ------------------------------------------- */

HDC mc_measure_dc(void);            /* the cached measuring memory DC */
int mc_text_w(const char *text);    /* label width up to the accel tab */
int mc_row_h(const MenuItem *it);
void mc_tbl_size(MenuTbl *m, int *wOut, int *hOut);
int mc_tbl_at(MenuTbl *m, const RECT *pr, int x, int y);
/* The Win95 raised/sunken 3D edge (shared with user32's controls). */
void mc_draw_raised(HDC dc, RECT r, int sunken);
void mc_draw_tbl(HDC dc, MenuTbl *m, const RECT *prp, int hotRow);

/* ---- the open-popup CHAIN (A12: the Win32 #32768 stack) ----------- */

typedef struct {
    MenuTbl *m;                 /* the level's items */
    MCWIN win;                  /* its overlay window (front-end handle) */
    int w, h;                   /* its dims (mc_tbl_size, screen-capped) */
    int ax, ay;                 /* anchor offset in the level above's space
                                   (level 0: the ownerWin's space) */
    int hot;                    /* hot row, -1 none */
} MenuLevel;

typedef struct {
    const MenuCoreOps *ops;     /* registered at mc_track_begin */
    void *owner;                /* notify target (track_state / popup_opening
                                   / bar-tracking post_command) */
    void *cmd;                  /* standalone post_command target */
    int open;                   /* a tracking is live */
    int standalone;             /* TrackPopupMenu-style vs bar tracking */
    unsigned tpmFlags;          /* standalone: TPM_* word */
    int retcmd;                 /* standalone TPM_RETURNCMD result */
    int nlev;                   /* open levels; the root popup is lev[0] */
    MenuLevel lev[MENU_MAX_DEPTH];
} MenuChain;

extern MenuChain __mc;

/* Begin a tracking: register the ops + owner tokens, fire
 * track_state(entering). Any prior tracking must be closed first. */
void mc_track_begin(const MenuCoreOps *ops, void *owner, void *cmd,
                    int standalone, unsigned tpmFlags);
/* Destroy open levels >= k, deepest first. */
void mc_trunc(int k);
/* Close the whole tracking (fires track_state(leaving)). */
void mc_close(void);
/* Tear the tracking down WITHOUT the leaving notification — the owner
 * window is dying (user32's WM_DESTROY path). */
void mc_abort(void);
/* Open `tbl` as the next chain level anchored at (ax, ay) in parentWin's
 * space (level 0: parentWin = the front-end's owner window). Fires
 * popup_opening BEFORE measuring. Loud refusal past MENU_MAX_DEPTH. */
void mc_level_open(MenuTbl *tbl, int idx, MCWIN parentWin, int ax, int ay);
/* Open the cascade of level k's row as level k+1 (deeper levels close
 * first); no-op unless the row is an enabled popup item. */
void mc_sub_open(int k, int row);
/* Fire row `row` of `m`: close the chain, then post the command. */
void mc_fire(MenuTbl *m, int row);
/* Mouse on open chain level k's window, popup-local coords
 * (WM_MOUSEMOVE / WM_LBUTTONDOWN / WM_LBUTTONDBLCLK / WM_LBUTTONUP). */
void mc_level_mouse(int k, UINT msg, int x, int y);
/* Keyboard while a tracking is open (SDL keysyms): Up/Down walk enabled
 * rows of the DEEPEST level, Enter fires/opens, Right opens a hot
 * cascade, Left/Esc close the deepest level (Esc at the root closes the
 * tracking). Returns 1 if the key was one of those; 0 (printables and
 * anything else) so a front-end can layer type-ahead on top — an open
 * menu is modal either way, the front-end swallows what it doesn't use. */
int mc_route_key(int key);
void mc_level_paint(int k);
/* First-letter type-ahead over the DEEPEST level (wm.c's flyout
 * behavior, kept front-end-opt-in): cycle the hot row to the next
 * enabled row whose label starts with `ch` (case-insensitive). */
void mc_typeahead(int ch);
