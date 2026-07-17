/* menucore.h — the menu engine's structural outward seam (todos/0257,
 * menu-uniform architecture A7/A13).
 *
 * The ONE menu engine (model + geometry + tracking + raster) lives in
 * user32.c today, but it touches the world outside itself ONLY through
 * the MenuCoreOps vtable below — a real struct-of-fn-pointers, so the
 * compiler enforces the boundary instead of a prose promise (A7). The
 * engine's four outward dependencies (design note §7):
 *
 *   (a) an HDC over the overlay window's pixels   -> win_begin/win_present
 *   (b) anchored overlay windows create/destroy   -> win_create/win_destroy
 *       (user32: SDL_CreatePopupWindow — the kernel anchored-child
 *       primitive of todos/0256; POPUP_MENU levels hold the kernel grab)
 *   (c) a command sink                            -> post_command
 *       (user32: PostMessage WM_COMMAND)
 *   (d) popup-state notifications                 -> track_state/popup_opening
 *       (user32: WM_ENTERMENULOOP + WM_INITMENU / WM_EXITMENULOOP /
 *       WM_INITMENUPOPUP — fired BEFORE a level is measured, so live
 *       check/gray mutations land in the paint)
 *
 * This header is standalone (not user32-private win32_internal.h) by
 * decision A13: wm.c is customer #2 on the record — its Start-menu and
 * ctxmenu engines are the fork this seam exists to delete — and the
 * extraction of the engine into menucore.c consumed by BOTH is its own
 * milestone (M4, after M2 proves the engine). Landing the seam here from
 * day one makes that a mechanical lift. Deliberately NOT a registration
 * framework: one plain vtable, passed nowhere, instantiated once per
 * front-end.
 *
 * The raster dependency is only gdi32 (HDC); nothing here knows about
 * HWNDs, SDL, or the transport under the overlay windows.
 */
#pragma once

#include <windows.h>

/* Engine geometry (shared with any front-end; SM_CYMENU must agree). */
#define MENU_BAR_H 20
#define MENU_ITEM_H 18
#define MENU_SEP_H 8
#define MENU_GUTTER 16

/* Open-chain depth bound (A12: a CHAIN, the Win32 #32768 stack — not the
 * old one-nested-level scalar). 16 is far past what any screen can hang;
 * exceeding it is a LOUD refusal, never a silent no-op. */
#define MENU_MAX_DEPTH 16

typedef void *MCWIN;            /* an overlay window handle
                                   (user32 front-end: SDL_Window *) */

typedef struct MenuCoreOps {
    /* Fire tracked item `id` at `owner` (an opaque front-end token given
     * to the engine when tracking started). */
    void (*post_command)(void *owner, int id);
    /* Tracking bracket: entering (1) / leaving (0) the modal menu loop.
     * `standalone` marks a TrackPopupMenu-style tracking vs a bar one. */
    void (*track_state)(void *owner, int entering, int standalone);
    /* Level table `hmenu` is about to open as the chain level anchored on
     * item `idx` — fired BEFORE measuring/creating its window. */
    void (*popup_opening)(void *owner, void *hmenu, int idx);
    /* Create an overlay window: an anchored child of `parent` at (dx, dy)
     * in the parent's client space, w x h. grab != 0 = a press outside the
     * window tree dismisses (delivered as a close request) and is
     * consumed — the kernel grab. NULL on failure (fail loud upstream). */
    MCWIN (*win_create)(MCWIN parent, int dx, int dy, int w, int h, int grab);
    void (*win_destroy)(MCWIN win);
    /* Wrap the overlay's pixels as a DC for one paint; the matching
     * win_present unwraps AND presents. wOut/hOut get the live dims. */
    HDC (*win_begin)(MCWIN win, int *wOut, int *hOut);
    void (*win_present)(MCWIN win, HDC dc);
} MenuCoreOps;
