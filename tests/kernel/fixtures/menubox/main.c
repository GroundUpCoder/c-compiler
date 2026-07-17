/* menubox — the Spike-1 anchored-child acceptance fixture (todos/0256,
 * menu-uniform architecture). A winbox-class SDL app that exercises the
 * whole kernel primitive through the stock SDL3 popup API, with NO user32
 * and NO menu code:
 *
 *   - "mb-two"   a second plain top-level (200x150): the grab's outside-
 *                click target — every MOUSE_BUTTON_DOWN it receives bumps a
 *                counter mirrored into its TITLE ("mb-two-N"), so a test can
 *                prove a consumed click was NEVER delivered by fencing on
 *                the next allowed click's count (kernel titles are
 *                synchronous; pixels are not).
 *   - "menubox"  the framed RESIZABLE parent (300x200). Fill mirrors the
 *                owner focus pair: gray until the first event, green on
 *                SDL_EVENT_WINDOW_FOCUS_GAINED, red on FOCUS_LOST — and the
 *                BAR's title mirrors it too ("mb-bar-act"/"mb-bar-inact"),
 *                the deterministic wait target.
 *   - "mb-bar"   a persistent full-width strip child (SDL_CreatePopupWindow,
 *                SDL_WINDOW_TOOLTIP — no grab) at (0,0), parent-width x 20:
 *                light gray with black 5x7 "MB" glyphs at 2x — app-rendered
 *                TEXT PIXELS the headless composite must show over the
 *                parent. On the parent's SDL_EVENT_WINDOW_RESIZED the app
 *                SDL_SetWindowSize()s the bar to the new width (the A5
 *                owner-initiated child resize — user32's WM_SIZE move).
 *   - key 't' -> "mb-tpop" (yellow 120x300 at (4,20), OVERFLOWS the parent)
 *                + "mb-tsub" (magenta 100x80 at (110,8) OF THE POPUP — the
 *                A1 two-level chain), both TOOLTIP (no grab) so title drags
 *                can prove follow-the-parent without dismissing anything.
 *   - key 'c' -> SDL_DestroyWindow(mb-tpop) ONLY: the kernel must cascade
 *                mb-tsub (the app never destroys it — its SDL_Window is
 *                deliberately leaked, this is a fixture).
 *   - bar click -> "mb-menu" (blue 120x300 at (4,20), SDL_WINDOW_POPUP_MENU
 *                = GRAB); menu click -> "mb-menu2" (cyan 100x80, POPUP_MENU,
 *                child of mb-menu). CLOSE_REQUESTED on either menu window
 *                (the kernel grab's outside-press dismissal) closes the
 *                WHOLE chain, Win95-style.
 *   - CLOSE_REQUESTED on "menubox" -> SDL_DestroyWindow(menubox) ONLY: the
 *                kernel must cascade the bar + any open popups while mb-two
 *                (a sibling top-level, NOT a child) survives.
 */
#include <SDL_popup.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PW 300
#define PH 200
#define BAR_H 20

static SDL_Window *win, *two, *bar, *tpop, *tsub, *menu, *menu2;
static int focus_state = 0;     /* 0 never, 1 gained, 2 lost */
static int two_clicks = 0;
static int bar_w = PW;

static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}

static void fill_win(SDL_Window *w, uint32_t color) {
    SDL_Surface *s = SDL_GetWindowSurface(w);
    uint32_t *px = (uint32_t *)s->pixels;
    for (int i = 0; i < s->w * s->h; i++) px[i] = color;
}

/* 5x7 glyphs, drawn at 2x — deterministic app-rendered text pixels. */
static const uint8_t GLYPH_M[7] = { 0x11, 0x1B, 0x15, 0x11, 0x11, 0x11, 0x11 };
static const uint8_t GLYPH_B[7] = { 0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E };

static void draw_glyph(SDL_Surface *s, const uint8_t *g, int x0, int y0, uint32_t c) {
    uint32_t *px = (uint32_t *)s->pixels;
    for (int r = 0; r < 7; r++) {
        for (int col = 0; col < 5; col++) {
            if (!(g[r] & (0x10 >> col))) continue;
            for (int dy = 0; dy < 2; dy++) {
                for (int dx = 0; dx < 2; dx++) {
                    int x = x0 + col * 2 + dx, y = y0 + r * 2 + dy;
                    if (x >= 0 && x < s->w && y >= 0 && y < s->h)
                        px[y * s->w + x] = c;
                }
            }
        }
    }
}

static void paint_bar(void) {
    if (!bar) return;
    fill_win(bar, rgb(200, 200, 200));
    SDL_Surface *s = SDL_GetWindowSurface(bar);
    draw_glyph(s, GLYPH_M, 4, 3, rgb(0, 0, 0));
    draw_glyph(s, GLYPH_B, 18, 3, rgb(0, 0, 0));
}

static void close_menu_chain(void) {
    if (menu2) { SDL_DestroyWindow(menu2); menu2 = NULL; }
    if (menu) { SDL_DestroyWindow(menu); menu = NULL; }
}

static SDL_WindowID wid(SDL_Window *w) { return w ? SDL_GetWindowID(w) : 0; }

static void frame_cb(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_WINDOW_FOCUS_GAINED && e.window.windowID == wid(win)) {
            focus_state = 1;
            if (bar) SDL_SetWindowTitle(bar, "mb-bar-act");
        } else if (e.type == SDL_EVENT_WINDOW_FOCUS_LOST && e.window.windowID == wid(win)) {
            focus_state = 2;
            if (bar) SDL_SetWindowTitle(bar, "mb-bar-inact");
        } else if (e.type == SDL_EVENT_KEY_DOWN && e.key.windowID == wid(win)) {
            if (e.key.scancode == 23 && !tpop) {          /* 't': tooltip chain */
                tpop = SDL_CreatePopupWindow(win, 4, BAR_H, 120, 300, SDL_WINDOW_TOOLTIP);
                if (tpop) {
                    SDL_SetWindowTitle(tpop, "mb-tpop");
                    tsub = SDL_CreatePopupWindow(tpop, 110, 8, 100, 80, SDL_WINDOW_TOOLTIP);
                    if (tsub) SDL_SetWindowTitle(tsub, "mb-tsub");
                }
            } else if (e.key.scancode == 6 && tpop) {     /* 'c': destroy tpop ONLY */
                SDL_DestroyWindow(tpop);
                tpop = NULL;
                tsub = NULL;   /* the KERNEL cascades it; struct leaks by design */
            }
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
            if (e.button.windowID == wid(two)) {
                two_clicks++;
                char t[32];
                snprintf(t, sizeof t, "mb-two-%d", two_clicks);
                SDL_SetWindowTitle(two, t);
            } else if (e.button.windowID == wid(bar) && !menu) {
                menu = SDL_CreatePopupWindow(win, 4, BAR_H, 120, 300, SDL_WINDOW_POPUP_MENU);
                if (menu) SDL_SetWindowTitle(menu, "mb-menu");
            } else if (e.button.windowID == wid(menu) && !menu2) {
                menu2 = SDL_CreatePopupWindow(menu, 110, 8, 100, 80, SDL_WINDOW_POPUP_MENU);
                if (menu2) SDL_SetWindowTitle(menu2, "mb-menu2");
            }
        } else if (e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
            if (e.window.windowID == wid(menu) || e.window.windowID == wid(menu2)) {
                close_menu_chain();                       /* Win95: whole chain */
            } else if (e.window.windowID == wid(win)) {
                SDL_DestroyWindow(win);   /* children cascade KERNEL-side */
                win = NULL;
                bar = NULL;
                tpop = NULL;
                tsub = NULL;
                close_menu_chain();       /* app-side structs only if still up */
            }
        } else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            if (e.window.windowID == wid(win) && win) {
                /* A5: the strip follows the parent's width, owner-initiated. */
                bar_w = e.window.data1;
                if (bar) SDL_SetWindowSize(bar, bar_w, BAR_H);
            }
            /* the bar's own RESIZED just re-derives its surface (below) */
        } else if (e.type == SDL_EVENT_QUIT) {
            exit(0);
        }
    }
    if (win) {
        fill_win(win, focus_state == 1 ? rgb(0, 200, 80)
                      : focus_state == 2 ? rgb(200, 30, 30) : rgb(128, 128, 128));
        SDL_UpdateWindowSurface(win);
    }
    if (two) { fill_win(two, rgb(255, 140, 0)); SDL_UpdateWindowSurface(two); }
    if (bar) { paint_bar(); SDL_UpdateWindowSurface(bar); }
    if (tpop) { fill_win(tpop, rgb(230, 210, 40)); SDL_UpdateWindowSurface(tpop); }
    if (tsub) { fill_win(tsub, rgb(200, 40, 180)); SDL_UpdateWindowSurface(tsub); }
    if (menu) { fill_win(menu, rgb(40, 80, 220)); SDL_UpdateWindowSurface(menu); }
    if (menu2) { fill_win(menu2, rgb(40, 200, 220)); SDL_UpdateWindowSurface(menu2); }
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    /* mb-two FIRST so the main window's create-steal leaves "menubox"
       focused (and its first FOCUS_GAINED already delivered) at startup. */
    two = SDL_CreateWindow("mb-two-0", 200, 150, 0);
    if (!two) return 3;
    win = SDL_CreateWindow("menubox", PW, PH, SDL_WINDOW_RESIZABLE);
    if (!win) return 3;
    bar = SDL_CreatePopupWindow(win, 0, 0, PW, BAR_H, SDL_WINDOW_TOOLTIP);
    if (!bar) {
        fprintf(stderr, "menubox: SDL_CreatePopupWindow failed: %s\n", SDL_GetError());
        return 4;
    }
    SDL_SetWindowTitle(bar, "mb-bar");
    /* SDL_GetDisplayBounds smoke: print once so the e2e can assert it. */
    SDL_Rect scr;
    if (SDL_GetDisplayBounds(0, &scr))
        printf("menubox: display %dx%d\n", scr.w, scr.h);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
