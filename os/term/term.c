/* term.c — the wasm terminal (todos/0020): an SDL surface app that owns a
 * kernel pty master and renders a character grid with freetype.
 *
 *   term [cmd args...]     defaults to /bin/sh (hush, interactive on the pty)
 *
 * Shape:
 *   - openpty() -> posix_spawnp the session leader on the slave (fd 0/1/2,
 *     own pgroup; the kernel claims it as the pty's foreground).
 *   - Event-driven loop (unified WAIT on {master, input ring}, todos/0178;
 *     an idle term wakes zero times a second): SDL key events -> bytes ->
 *     master; master bytes -> escape-sequence state machine -> cell grid ->
 *     freetype glyph blits -> SDL_UpdateWindowSurface (shm present;
 *     bit-exact headless).
 *   - The escape parser is scoped to what hush lineedit + busybox vi emit
 *     (TERM=xterm-256color): CUP/CUU..CUB/CHA/VPA, ED/EL, IL/DL/ICH/DCH/
 *     ECH, SU/SD, DECSTBM, SGR (16/256-color, bold, reverse), alt screen
 *     (?1049), cursor show/hide (?25), autowrap (?7), DECCKM (?1),
 *     DSR-6/DA replies. Not full vt100 — grow it when a program needs it.
 *   - WINDOW_RESIZED (todos/0019) -> grid realloc + TIOCSWINSZ (SIGWINCH
 *     reflows vi); closing the window (or the child exiting) ends the
 *     session — the kernel HUPs the pty's foreground pgroup at master
 *     close, so a plain exit(0) is a clean teardown.
 */
#include <SDL.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <pty.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include "../keys.h"     /* the system keyboard scheme (todos/0149) */
#include "../launch.h"   /* LAUNCH_ENV_PATH/HOME — the canonical env strings */

/* User-override font first, then the baked vendor default (todos/0040 —
 * systemd-style /etc: an empty /etc must boot). */
#define FONT_PATH      "/etc/fonts/mono.ttf"
#define FONT_FALLBACK  "/usr/share/fonts/mono.ttf"
#define FONT_SIZE  14
#define INIT_COLS  80
#define INIT_ROWS  24
#define MAX_PARAMS 16

/* ---- cell grid ---- */

typedef struct {
    unsigned char ch;      /* 32..126; anything else renders as space */
    unsigned char fg, bg;  /* palette index: 0..15 ANSI, 16 defFg, 17 defBg */
    unsigned char attr;    /* bit0 bold, bit1 reverse */
} Cell;

#define A_BOLD    1
#define A_REVERSE 2
#define DEF_FG    16
#define DEF_BG    17

static const uint8_t PAL[18][3] = {
    {0, 0, 0},       {205, 49, 49},   {13, 188, 121},  {229, 229, 16},
    {36, 114, 200},  {188, 63, 188},  {17, 168, 205},  {229, 229, 229},
    {102, 102, 102}, {241, 76, 76},   {35, 209, 139},  {245, 245, 67},
    {59, 142, 234},  {214, 112, 214}, {41, 184, 219},  {255, 255, 255},
    {220, 220, 220},                  /* default foreground */
    {0, 0, 0},                        /* default background */
};

static int cols, rows;
static Cell *grid_main, *grid_alt, *grid;   /* grid points at one of the two */
static int on_alt;
static int cx, cy;                 /* cursor */
static int saved_cx, saved_cy;
static int scroll_top, scroll_bot; /* inclusive rows */
static int wrap_pending;
static int cursor_visible = 1;
static int autowrap = 1;
static int appcursor;              /* DECCKM: arrows send ESC O x */
static unsigned char cur_fg = DEF_FG, cur_bg = DEF_BG, cur_attr = 0;
static int dirty = 1;

/* ---- pty / child ---- */
static int mfd = -1;
static pid_t child = -1;

/* The unified multi-source wait (kernel FS_WAIT via host.js, todos/0178):
 * park until an fd in rfds is readable (1), the input ring has records —
 * already drained into the SDL queue at return (2), timeout_ms elapses
 * (0; < 0 waits forever), or a signal was posted (-1). term's two event
 * sources are the pty master and the input ring, so an idle term wakes
 * ZERO times a second instead of polling the master at 60Hz. */
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

/* ---- selection / clipboard (todos/0090) ----
   Mouse drag selects a linear (row-major, xterm-style) cell range on the
   CURRENT screen; Ctrl+Shift+C copies it to the system clipboard
   (SDL_SetClipboardText -> the kernel's one slot), Ctrl+Shift+V pastes the
   slot into the pty master. Selection is screen coordinates — output that
   scrolls under it moves the highlight's content, like xterm; it clears on
   the next click or a resize. */
static int sel_on;                 /* a selection exists (rendered inverted) */
static int sel_drag;               /* left button held: extending */
static int sel_ax, sel_ay;         /* anchor cell */
static int sel_ex, sel_ey;         /* extent cell (inclusive) */

/* ---- SDL / freetype ---- */
static SDL_Window *win;
static SDL_Surface *surf;
static FT_Library ft_lib;
static FT_Face face;
static int cell_w, cell_h, ascent;

typedef struct { int w, h, left, top; unsigned char *bmp; } Glyph;
static Glyph glyphs[95];           /* ASCII 32..126, rendered once */

/* ============================================================ grid ops */

static Cell blank_cell(void) {
    Cell c;
    c.ch = ' ';
    c.fg = cur_fg;
    c.bg = cur_bg;
    c.attr = 0;
    return c;
}

static void clear_cells(Cell *g, int from, int count) {
    Cell b = blank_cell();
    for (int i = 0; i < count; i++) g[from + i] = b;
}

static void scroll_up(int n) {
    if (n < 1) n = 1;
    int span = scroll_bot - scroll_top + 1;
    if (n > span) n = span;
    memmove(&grid[scroll_top * cols], &grid[(scroll_top + n) * cols],
            (size_t)(span - n) * cols * sizeof(Cell));
    clear_cells(grid, (scroll_bot - n + 1) * cols, n * cols);
}

static void scroll_down(int n) {
    if (n < 1) n = 1;
    int span = scroll_bot - scroll_top + 1;
    if (n > span) n = span;
    memmove(&grid[(scroll_top + n) * cols], &grid[scroll_top * cols],
            (size_t)(span - n) * cols * sizeof(Cell));
    clear_cells(grid, scroll_top * cols, n * cols);
}

static void linefeed(void) {
    wrap_pending = 0;
    if (cy == scroll_bot) scroll_up(1);
    else if (cy < rows - 1) cy++;
}

static void put_char(unsigned char b) {
    if (wrap_pending && autowrap) {
        cx = 0;
        linefeed();
    }
    wrap_pending = 0;
    Cell *c = &grid[cy * cols + cx];
    c->ch = (b >= 32 && b < 127) ? b : '?';
    c->fg = cur_fg;
    c->bg = cur_bg;
    c->attr = cur_attr;
    if (cx == cols - 1) wrap_pending = 1;
    else cx++;
}

static void full_reset(void) {
    cur_fg = DEF_FG; cur_bg = DEF_BG; cur_attr = 0;
    scroll_top = 0; scroll_bot = rows - 1;
    cx = cy = saved_cx = saved_cy = 0;
    wrap_pending = 0;
    cursor_visible = 1; autowrap = 1; appcursor = 0;
    on_alt = 0; grid = grid_main;
    clear_cells(grid_main, 0, rows * cols);
    clear_cells(grid_alt, 0, rows * cols);
}

/* ============================================================ parser */

enum { ST_GROUND, ST_ESC, ST_CSI, ST_OSC, ST_CHARSET };
static int pstate = ST_GROUND;
static int params[MAX_PARAMS], nparams, priv, csi_ignore;
static char osc_buf[128];
static int osc_len, osc_esc;

/* Param i with a default: params[] holds 0 for empty, and 0 defaults for
 * every op this parser implements (xterm agrees). */
static int P(int i, int def) {
    return (i <= nparams && params[i] > 0) ? params[i] : def;
}

static void clamp_cursor(void) {
    if (cx < 0) cx = 0;
    if (cx > cols - 1) cx = cols - 1;
    if (cy < 0) cy = 0;
    if (cy > rows - 1) cy = rows - 1;
    wrap_pending = 0;
}

/* 256-color -> nearest of the 16-color palette (vi themes use 38;5;n). */
static unsigned char nearest16(int r, int g, int b) {
    int best = 0;
    long bestd = 0x7fffffff;
    for (int i = 0; i < 16; i++) {
        long dr = r - PAL[i][0], dg = g - PAL[i][1], db = b - PAL[i][2];
        long d = dr * dr + dg * dg + db * db;
        if (d < bestd) { bestd = d; best = i; }
    }
    return (unsigned char)best;
}

static unsigned char color256(int n) {
    if (n < 0) return DEF_FG;
    if (n < 16) return (unsigned char)n;
    if (n < 232) {
        static const int lv[6] = {0, 95, 135, 175, 215, 255};
        n -= 16;
        return nearest16(lv[(n / 36) % 6], lv[(n / 6) % 6], lv[n % 6]);
    }
    int gray = 8 + (n - 232) * 10;
    return nearest16(gray, gray, gray);
}

static void do_sgr(void) {
    for (int i = 0; i <= nparams; i++) {
        int p = params[i];
        if (p == 0) { cur_fg = DEF_FG; cur_bg = DEF_BG; cur_attr = 0; }
        else if (p == 1) cur_attr |= A_BOLD;
        else if (p == 22) cur_attr &= ~A_BOLD;
        else if (p == 7) cur_attr |= A_REVERSE;
        else if (p == 27) cur_attr &= ~A_REVERSE;
        else if (p >= 30 && p <= 37) cur_fg = (unsigned char)(p - 30);
        else if (p == 39) cur_fg = DEF_FG;
        else if (p >= 40 && p <= 47) cur_bg = (unsigned char)(p - 40);
        else if (p == 49) cur_bg = DEF_BG;
        else if (p >= 90 && p <= 97) cur_fg = (unsigned char)(p - 90 + 8);
        else if (p >= 100 && p <= 107) cur_bg = (unsigned char)(p - 100 + 8);
        else if ((p == 38 || p == 48) && i + 1 <= nparams) {
            unsigned char v = DEF_FG;
            if (params[i + 1] == 5 && i + 2 <= nparams) {
                v = color256(params[i + 2]);
                i += 2;
            } else if (params[i + 1] == 2 && i + 4 <= nparams) {
                v = nearest16(params[i + 2], params[i + 3], params[i + 4]);
                i += 4;
            }
            if (p == 38) cur_fg = v; else cur_bg = v;
        }
        /* 3 (italic), 4 (underline), 5 (blink)... : no cell budget, ignore */
    }
}

static void reply(const char *s) { write(mfd, s, strlen(s)); }

static void enter_alt(int enter) {
    if (enter && !on_alt) {
        saved_cx = cx; saved_cy = cy;
        on_alt = 1; grid = grid_alt;
        clear_cells(grid, 0, rows * cols);
        cx = cy = 0;
        scroll_top = 0; scroll_bot = rows - 1;
    } else if (!enter && on_alt) {
        on_alt = 0; grid = grid_main;
        cx = saved_cx; cy = saved_cy;
        scroll_top = 0; scroll_bot = rows - 1;
        clamp_cursor();
    }
    wrap_pending = 0;
}

static void do_decset(int set) {
    for (int i = 0; i <= nparams; i++) {
        switch (params[i]) {
        case 1:    appcursor = set; break;
        case 7:    autowrap = set; break;
        case 25:   cursor_visible = set; break;
        case 47: case 1047: case 1049: enter_alt(set); break;
        default: break;   /* mouse modes, bracketed paste, ... */
        }
    }
}

static void csi_dispatch(unsigned char final) {
    if (csi_ignore) return;
    switch (final) {
    case 'A': cy -= P(0, 1); clamp_cursor(); break;
    case 'B': cy += P(0, 1); clamp_cursor(); break;
    case 'C': cx += P(0, 1); clamp_cursor(); break;
    case 'D': cx -= P(0, 1); clamp_cursor(); break;
    case 'E': cx = 0; cy += P(0, 1); clamp_cursor(); break;
    case 'F': cx = 0; cy -= P(0, 1); clamp_cursor(); break;
    case 'G': cx = P(0, 1) - 1; clamp_cursor(); break;
    case 'd': cy = P(0, 1) - 1; clamp_cursor(); break;
    case 'H': case 'f':
        cy = P(0, 1) - 1;
        cx = P(1, 1) - 1;
        clamp_cursor();
        break;
    case 'J': {
        int m = params[0];
        wrap_pending = 0;
        if (m == 0) {
            clear_cells(grid, cy * cols + cx, cols - cx);
            if (cy < rows - 1) clear_cells(grid, (cy + 1) * cols, (rows - 1 - cy) * cols);
        } else if (m == 1) {
            if (cy > 0) clear_cells(grid, 0, cy * cols);
            clear_cells(grid, cy * cols, cx + 1);
        } else {
            clear_cells(grid, 0, rows * cols);
        }
        break;
    }
    case 'K': {
        int m = params[0];
        wrap_pending = 0;
        if (m == 0) clear_cells(grid, cy * cols + cx, cols - cx);
        else if (m == 1) clear_cells(grid, cy * cols, cx + 1);
        else clear_cells(grid, cy * cols, cols);
        break;
    }
    case 'L': {  /* insert lines at the cursor (within the scroll region) */
        if (cy >= scroll_top && cy <= scroll_bot) {
            int save = scroll_top;
            scroll_top = cy;
            scroll_down(P(0, 1));
            scroll_top = save;
        }
        break;
    }
    case 'M': {  /* delete lines at the cursor */
        if (cy >= scroll_top && cy <= scroll_bot) {
            int save = scroll_top;
            scroll_top = cy;
            scroll_up(P(0, 1));
            scroll_top = save;
        }
        break;
    }
    case 'P': {  /* delete chars: pull the rest of the row left */
        int n = P(0, 1);
        if (n > cols - cx) n = cols - cx;
        Cell *row = &grid[cy * cols];
        memmove(&row[cx], &row[cx + n], (size_t)(cols - cx - n) * sizeof(Cell));
        clear_cells(row, cols - n, n);
        break;
    }
    case '@': {  /* insert blank chars: push the rest of the row right */
        int n = P(0, 1);
        if (n > cols - cx) n = cols - cx;
        Cell *row = &grid[cy * cols];
        memmove(&row[cx + n], &row[cx], (size_t)(cols - cx - n) * sizeof(Cell));
        clear_cells(row, cx, n);
        break;
    }
    case 'X': {  /* erase chars in place */
        int n = P(0, 1);
        if (n > cols - cx) n = cols - cx;
        clear_cells(grid, cy * cols + cx, n);
        break;
    }
    case 'S': scroll_up(P(0, 1)); break;
    case 'T': scroll_down(P(0, 1)); break;
    case 'r': {  /* DECSTBM */
        int top = P(0, 1) - 1;
        int bot = P(1, rows) - 1;
        if (top < 0) top = 0;
        if (bot > rows - 1) bot = rows - 1;
        if (top < bot) {
            scroll_top = top;
            scroll_bot = bot;
            cx = cy = 0;
            wrap_pending = 0;
        }
        break;
    }
    case 'm': do_sgr(); break;
    case 'h': if (priv) do_decset(1); break;
    case 'l': if (priv) do_decset(0); break;
    case 's': saved_cx = cx; saved_cy = cy; break;
    case 'u': cx = saved_cx; cy = saved_cy; clamp_cursor(); break;
    case 'n':
        if (params[0] == 6) {   /* DSR: cursor position report */
            char rep[32];
            snprintf(rep, sizeof rep, "\x1b[%d;%dR", cy + 1, cx + 1);
            reply(rep);
        }
        break;
    case 'c': reply("\x1b[?1;2c"); break;   /* DA: vt100 with AVO */
    default: break;
    }
}

static void term_putc(unsigned char b) {
    switch (pstate) {
    case ST_GROUND:
        if (b == 0x1b) { pstate = ST_ESC; break; }
        if (b == 0x08) { if (cx > 0) cx--; wrap_pending = 0; break; }
        if (b == 0x09) {
            cx = ((cx / 8) + 1) * 8;
            if (cx > cols - 1) cx = cols - 1;
            wrap_pending = 0;
            break;
        }
        if (b == 0x0a || b == 0x0b || b == 0x0c) { linefeed(); break; }
        if (b == 0x0d) { cx = 0; wrap_pending = 0; break; }
        if (b == 0x07 || b < 32) break;      /* BEL + other C0: ignore */
        put_char(b);
        break;
    case ST_ESC:
        switch (b) {
        case '[':
            memset(params, 0, sizeof params);
            nparams = 0; priv = 0; csi_ignore = 0;
            pstate = ST_CSI;
            break;
        case ']': osc_len = 0; osc_esc = 0; pstate = ST_OSC; break;
        case '7': saved_cx = cx; saved_cy = cy; pstate = ST_GROUND; break;
        case '8': cx = saved_cx; cy = saved_cy; clamp_cursor(); pstate = ST_GROUND; break;
        case 'D': linefeed(); pstate = ST_GROUND; break;
        case 'E': cx = 0; linefeed(); pstate = ST_GROUND; break;
        case 'M':   /* reverse index */
            wrap_pending = 0;
            if (cy == scroll_top) scroll_down(1);
            else if (cy > 0) cy--;
            pstate = ST_GROUND;
            break;
        case 'c': full_reset(); pstate = ST_GROUND; break;
        case '(': case ')': pstate = ST_CHARSET; break;
        default: pstate = ST_GROUND; break;  /* =, >, unknown */
        }
        break;
    case ST_CSI:
        if (b >= '0' && b <= '9') {
            params[nparams] = params[nparams] * 10 + (b - '0');
            if (params[nparams] > 32767) params[nparams] = 32767;
        } else if (b == ';') {
            if (nparams < MAX_PARAMS - 1) nparams++;
        } else if (b == '?') {
            priv = 1;
        } else if (b >= 0x20 && b <= 0x2f) {
            csi_ignore = 1;                  /* intermediates: ignore the op */
        } else if (b >= 0x40 && b <= 0x7e) {
            csi_dispatch(b);
            pstate = ST_GROUND;
        } else if (b == 0x1b) {
            pstate = ST_ESC;
        }
        /* other bytes (e.g. stray C0): swallowed */
        break;
    case ST_OSC:
        if (b == 0x07 || (osc_esc && b == '\\')) {
            osc_buf[osc_len] = 0;
            if ((osc_buf[0] == '0' || osc_buf[0] == '2') && osc_buf[1] == ';')
                SDL_SetWindowTitle(win, osc_buf + 2);
            pstate = ST_GROUND;
        } else if (b == 0x1b) {
            osc_esc = 1;
        } else {
            osc_esc = 0;
            if (osc_len < (int)sizeof osc_buf - 1) osc_buf[osc_len++] = (char)b;
        }
        break;
    case ST_CHARSET:
        pstate = ST_GROUND;                  /* consume the charset byte */
        break;
    }
}

/* ============================================================ selection
 * / clipboard (todos/0090) */

static int cell_clamp(int v, int lim) {
    if (v < 0) return 0;
    if (v >= lim) return lim - 1;
    return v;
}

static void sel_bounds(int *s, int *e) {         /* linear cell indices */
    int a = sel_ay * cols + sel_ax;
    int b = sel_ey * cols + sel_ex;
    if (a <= b) { *s = a; *e = b; } else { *s = b; *e = a; }
}

static int sel_has(int r, int c) {
    int s, e;
    if (!sel_on) return 0;
    sel_bounds(&s, &e);
    int i = r * cols + c;
    return i >= s && i <= e;
}

static void copy_selection(void) {
    if (!sel_on) return;
    int s, e;
    sel_bounds(&s, &e);
    int r0 = s / cols, r1 = e / cols;
    /* worst case: every cell + a newline per row + NUL */
    char *buf = malloc((size_t)(e - s + 1) + (size_t)(r1 - r0) + 1);
    if (!buf) return;
    int n = 0;
    for (int r = r0; r <= r1; r++) {
        int c0 = r == r0 ? s % cols : 0;
        int c1 = r == r1 ? e % cols : cols - 1;
        int line = n;
        for (int c = c0; c <= c1; c++) {
            unsigned char ch = grid[r * cols + c].ch;
            buf[n++] = (ch >= 32 && ch <= 126) ? (char)ch : ' ';
        }
        while (n > line && buf[n - 1] == ' ') n--;   /* trim trailing blanks */
        if (r < r1) buf[n++] = '\n';
    }
    buf[n] = 0;
    SDL_SetClipboardText(buf);
    free(buf);
}

static void paste_clipboard(void) {
    char *t = SDL_GetClipboardText();
    if (!t) return;
    /* Newlines become CR on the wire (what Enter sends; the line
       discipline's ICRNL hands the session \n back), \r\n folds to one. */
    size_t len = strlen(t), n = 0;
    for (size_t i = 0; i < len; i++) {
        char b = t[i];
        if (b == '\r' && t[i + 1] == '\n') continue;   /* CRLF -> one CR */
        t[n++] = b == '\n' ? '\r' : b;
    }
    for (size_t off = 0; off < n; ) {
        ssize_t w = write(mfd, t + off, n - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    SDL_free(t);
}

/* ============================================================ input */

static void send_named(int sym) {
    switch (sym) {
    case SDLK_UP:       reply(appcursor ? "\x1bOA" : "\x1b[A"); break;
    case SDLK_DOWN:     reply(appcursor ? "\x1bOB" : "\x1b[B"); break;
    case SDLK_RIGHT:    reply(appcursor ? "\x1bOC" : "\x1b[C"); break;
    case SDLK_LEFT:     reply(appcursor ? "\x1bOD" : "\x1b[D"); break;
    case SDLK_HOME:     reply("\x1b[1~"); break;
    case SDLK_END:      reply("\x1b[4~"); break;
    case SDLK_PAGEUP:   reply("\x1b[5~"); break;
    case SDLK_PAGEDOWN: reply("\x1b[6~"); break;
    default: break;
    }
}

static void handle_key(const SDL_KeyboardEvent *k) {
    int sym = (int)k->key;
    int mod = (int)k->mod;
    char b;
    /* The terminal's copy/paste chords resolve through the scheme table
       (todos/0149, os/keys.h): Ctrl+Shift+C/V under the windows keymap,
       ⌘C/V under macos — plain Ctrl+C stays the tty's SIGINT byte either
       way. Keysyms are modifier-applied, so the shifted letter usually
       arrives uppercase (key_action case-folds). */
    if (sym >= 32 && sym <= 126) {
        int act = key_action(KCTX_TERM, km_from_sdl(mod), sym);
        if (act == KA_COPY) { copy_selection(); return; }
        if (act == KA_PASTE) { paste_clipboard(); return; }
    }
    /* GUI is never a text modifier: an unbound ⌘chord DROPS here instead
       of typing its letter (the ⌘C-typed-'c' bug, folded into 0149). */
    if (mod & SDL_KMOD_GUI) return;
    if (sym == SDLK_RETURN) { b = '\r'; write(mfd, &b, 1); return; }
    if (sym == SDLK_BACKSPACE) { b = 0x7f; write(mfd, &b, 1); return; }  /* VERASE */
    if (sym == SDLK_TAB) { b = '\t'; write(mfd, &b, 1); return; }
    if (sym == SDLK_ESCAPE) { b = 0x1b; write(mfd, &b, 1); return; }
    if (sym == SDLK_DELETE) { reply("\x1b[3~"); return; }
    if (sym >= 0x40000000) { send_named(sym); return; }
    if (sym < 32 || sym > 126) return;
    if (mod & SDL_KMOD_CTRL) {
        /* SDL3 keycodes are modifier-applied chars; fold to the control
           code the tty expects (^A..^Z, ^@ ^[ ^\ ^] ^^ ^_). */
        int c = sym;
        if (c >= 'a' && c <= 'z') c -= 32;
        if (c >= '@' && c <= '_') {
            b = (char)(c & 0x1f);
            write(mfd, &b, 1);
        } else if (c == ' ') {
            b = 0;
            write(mfd, &b, 1);
        }
        return;
    }
    if (mod & SDL_KMOD_ALT) { b = 0x1b; write(mfd, &b, 1); }  /* ESC prefix */
    b = (char)sym;
    write(mfd, &b, 1);
}

/* ============================================================ render */

static uint32_t pack(const uint8_t *rgb) {
    return (uint32_t)rgb[0] | ((uint32_t)rgb[1] << 8) | ((uint32_t)rgb[2] << 16) | 0xFF000000u;
}

static void render(void) {
    uint32_t *px = (uint32_t *)surf->pixels;
    int sw = surf->w, sh = surf->h;
    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            Cell *cell = &grid[r * cols + c];
            int fg = cell->fg, bg = cell->bg;
            if (cell->attr & A_BOLD) { if (fg < 8) fg += 8; }
            if (cell->attr & A_REVERSE) { int t = fg; fg = bg; bg = t; }
            if (sel_has(r, c)) { int t = fg; fg = bg; bg = t; }   /* 0090 */
            if (cursor_visible && r == cy && c == cx) { int t = fg; fg = bg; bg = t; }
            int x0 = c * cell_w, y0 = r * cell_h;
            uint32_t bgp = pack(PAL[bg]);
            for (int y = y0; y < y0 + cell_h && y < sh; y++) {
                uint32_t *rowp = &px[y * sw];
                for (int x = x0; x < x0 + cell_w && x < sw; x++) rowp[x] = bgp;
            }
            if (cell->ch <= 32 || cell->ch > 126) continue;
            Glyph *g = &glyphs[cell->ch - 32];
            if (!g->bmp) continue;
            int gx0 = x0 + g->left;
            int gy0 = y0 + ascent - g->top;
            int fr = PAL[fg][0], fgg = PAL[fg][1], fb = PAL[fg][2];
            int br = PAL[bg][0], bgg = PAL[bg][1], bb = PAL[bg][2];
            for (int gy = 0; gy < g->h; gy++) {
                int dy = gy0 + gy;
                if (dy < y0 || dy >= y0 + cell_h || dy >= sh) continue;
                for (int gx = 0; gx < g->w; gx++) {
                    int dx = gx0 + gx;
                    if (dx < x0 || dx >= x0 + cell_w || dx >= sw) continue;
                    unsigned a = g->bmp[gy * g->w + gx];
                    if (!a) continue;
                    int rr = br + (int)(a * (unsigned)(fr - br) / 255);
                    int gg = bgg + (int)(a * (unsigned)(fgg - bgg) / 255);
                    int bbv = bb + (int)(a * (unsigned)(fb - bb) / 255);
                    px[dy * sw + dx] = (uint32_t)rr | ((uint32_t)gg << 8) |
                                       ((uint32_t)bbv << 16) | 0xFF000000u;
                }
            }
        }
    }
    /* Uncovered right/bottom margins (window not an exact cell multiple). */
    uint32_t defbg = pack(PAL[DEF_BG]);
    for (int y = 0; y < sh; y++) {
        for (int x = cols * cell_w; x < sw; x++) px[y * sw + x] = defbg;
    }
    for (int y = rows * cell_h; y < sh; y++) {
        for (int x = 0; x < cols * cell_w; x++) px[y * sw + x] = defbg;
    }
}

/* ============================================================ resize */

static void set_winsize(void) {
    struct winsize ws;
    ws.ws_row = (unsigned short)rows;
    ws.ws_col = (unsigned short)cols;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    ioctl(mfd, TIOCSWINSZ, &ws);
}

static void apply_resize(int ncols, int nrows) {
    if (ncols < 2) ncols = 2;
    if (nrows < 2) nrows = 2;
    if (ncols == cols && nrows == rows) return;
    Cell *nmain = malloc((size_t)ncols * nrows * sizeof(Cell));
    Cell *nalt = malloc((size_t)ncols * nrows * sizeof(Cell));
    if (!nmain || !nalt) { free(nmain); free(nalt); return; }
    Cell b = blank_cell();
    for (int i = 0; i < ncols * nrows; i++) { nmain[i] = b; nalt[i] = b; }
    int copyr = rows < nrows ? rows : nrows;
    int copyc = cols < ncols ? cols : ncols;
    for (int r = 0; r < copyr; r++) {
        memcpy(&nmain[r * ncols], &grid_main[r * cols], (size_t)copyc * sizeof(Cell));
        memcpy(&nalt[r * ncols], &grid_alt[r * cols], (size_t)copyc * sizeof(Cell));
    }
    free(grid_main);
    free(grid_alt);
    grid_main = nmain;
    grid_alt = nalt;
    grid = on_alt ? grid_alt : grid_main;
    cols = ncols;
    rows = nrows;
    scroll_top = 0;
    scroll_bot = rows - 1;
    clamp_cursor();
    if (saved_cx > cols - 1) saved_cx = cols - 1;
    if (saved_cy > rows - 1) saved_cy = rows - 1;
    sel_on = sel_drag = 0;         /* stale cell coords (0090) */
    set_winsize();                 /* SIGWINCH: the session reflows */
    dirty = 1;
}

/* ============================================================ main loop */

/* SIGCHLD is only a WAKE: the state change is observed by frame_cb's
 * waitpid(WNOHANG). The flag closes the app-level check→park gap: if the
 * signal is CLAIMED at an import return inside frame_cb (after its waitpid
 * ran), SIGPEND is clear and the next __wait would park past the zombie —
 * the main loop re-runs frame_cb instead. Signals dispatch ONLY at import
 * returns (cooperative delivery), so a pure-wasm flag check directly
 * before the park has no gap a handler can slip into. */
static volatile int chld_seen = 0;
static void on_chld(int sig) { (void)sig; chld_seen = 1; }

static void frame_cb(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN) {
            handle_key(&e.key);
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && e.button.button == 1) {
            /* Left press: clear any selection, anchor a new one (0090). */
            sel_ax = sel_ex = cell_clamp((int)e.button.x / cell_w, cols);
            sel_ay = sel_ey = cell_clamp((int)e.button.y / cell_h, rows);
            sel_drag = 1;
            if (sel_on) { sel_on = 0; dirty = 1; }
        } else if (e.type == SDL_EVENT_MOUSE_MOTION && sel_drag) {
            int c = cell_clamp((int)e.motion.x / cell_w, cols);
            int r = cell_clamp((int)e.motion.y / cell_h, rows);
            if (c != sel_ex || r != sel_ey || !sel_on) {
                sel_ex = c;
                sel_ey = r;
                sel_on = c != sel_ax || r != sel_ay ? 1 : sel_on;
                dirty = 1;
            }
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_UP && e.button.button == 1) {
            sel_drag = 0;
        } else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            surf = SDL_GetWindowSurface(win);   /* re-derive (SDL3 contract) */
            apply_resize(surf->w / cell_w, surf->h / cell_h);
        } else if (e.type == SDL_EVENT_QUIT) {
            exit(0);   /* master close HUPs the pty's foreground pgroup */
        }
    }
    if (child > 0) {
        int st;
        if (waitpid(child, &st, WNOHANG) == child) exit(0);   /* session over */
    }
    /* Drain the master (bounded per frame so rendering stays live). */
    int budget = 65536;
    while (budget > 0) {
        fd_set rf;
        struct timeval tv;
        FD_ZERO(&rf);
        FD_SET(mfd, &rf);
        tv.tv_sec = 0;
        tv.tv_usec = 0;
        if (select(mfd + 1, &rf, 0, 0, &tv) <= 0) break;
        char buf[4096];
        ssize_t n = read(mfd, buf, sizeof buf);
        if (n <= 0) exit(0);                    /* EOF: every slave fd closed */
        for (ssize_t i = 0; i < n; i++) term_putc((unsigned char)buf[i]);
        budget -= (int)n;
        dirty = 1;
    }
    if (dirty) {
        render();
        SDL_UpdateWindowSurface(win);
        dirty = 0;
    }
}

static int load_glyphs(void) {
    if (FT_Init_FreeType(&ft_lib)) return -1;
    if (FT_New_Face(ft_lib, FONT_PATH, 0, &face) &&
        FT_New_Face(ft_lib, FONT_FALLBACK, 0, &face)) return -1;
    FT_Set_Pixel_Sizes(face, 0, FONT_SIZE);
    cell_h = (int)(face->size->metrics.height >> 6);
    ascent = (int)(face->size->metrics.ascender >> 6);
    if (cell_h < FONT_SIZE) cell_h = FONT_SIZE + 3;
    /* Monospace: every advance matches 'M'. */
    FT_UInt mi = FT_Get_Char_Index(face, 'M');
    if (FT_Load_Glyph(face, mi, FT_LOAD_DEFAULT)) return -1;
    cell_w = (int)(face->glyph->advance.x >> 6);
    if (cell_w <= 0) cell_w = (FONT_SIZE * 3) / 5;
    for (int ch = 32; ch < 127; ch++) {
        Glyph *g = &glyphs[ch - 32];
        FT_UInt gi = FT_Get_Char_Index(face, (FT_ULong)ch);
        if (FT_Load_Glyph(face, gi, FT_LOAD_DEFAULT)) continue;
        if (FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL)) continue;
        FT_Bitmap *bm = &face->glyph->bitmap;
        g->w = (int)bm->width;
        g->h = (int)bm->rows;
        g->left = face->glyph->bitmap_left;
        g->top = face->glyph->bitmap_top;
        if (g->w > 0 && g->h > 0) {
            g->bmp = malloc((size_t)g->w * g->h);
            if (!g->bmp) return -1;
            for (int y = 0; y < g->h; y++)
                memcpy(&g->bmp[y * g->w], &bm->buffer[y * bm->pitch], (size_t)g->w);
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    if (load_glyphs() != 0) {
        fprintf(stderr, "term: cannot load %s (or %s)\n", FONT_PATH, FONT_FALLBACK);
        return 1;
    }

    cols = INIT_COLS;
    rows = INIT_ROWS;
    grid_main = malloc((size_t)cols * rows * sizeof(Cell));
    grid_alt = malloc((size_t)cols * rows * sizeof(Cell));
    if (!grid_main || !grid_alt) return 1;
    grid = grid_main;
    scroll_top = 0;
    scroll_bot = rows - 1;
    clear_cells(grid_main, 0, rows * cols);
    clear_cells(grid_alt, 0, rows * cols);

    int sfd;
    if (openpty(&mfd, &sfd, 0, 0, 0) != 0) {
        fprintf(stderr, "term: openpty failed (kernel pty layer required)\n");
        return 1;
    }
    set_winsize();

    /* The session leader on the slave: default /bin/sh, or term's argv. */
    char *sh_argv[16];
    const char *path;
    if (argc > 1) {
        int n = argc - 1;
        if (n > 15) n = 15;
        for (int i = 0; i < n; i++) sh_argv[i] = argv[i + 1];
        sh_argv[n] = 0;
        path = argv[1];
    } else {
        sh_argv[0] = "-sh";   /* login shell: /etc/profile + ~/.profile (0174) */
        sh_argv[1] = 0;
        path = "/bin/sh";
    }
    char *envp[] = { LAUNCH_ENV_PATH, LAUNCH_ENV_HOME, "TERM=xterm-256color", 0 };
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, sfd, 0);
    posix_spawn_file_actions_adddup2(&fa, sfd, 1);
    posix_spawn_file_actions_adddup2(&fa, sfd, 2);
    posix_spawn_file_actions_addclose(&fa, mfd);
    posix_spawn_file_actions_addclose(&fa, sfd);
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);
    int e = posix_spawnp(&child, path, &fa, &at, sh_argv, envp);
    posix_spawn_file_actions_destroy(&fa);
    if (e != 0) {
        fprintf(stderr, "term: cannot spawn %s (%d)\n", path, e);
        return 1;
    }
    close(sfd);   /* the child holds the slave; master EOF = session end */

    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("term", cols * cell_w, rows * cell_h,
                           SDL_WINDOW_RESIZABLE);
    if (!win) return 3;
    surf = SDL_GetWindowSurface(win);
    render();
    SDL_UpdateWindowSurface(win);
    /* Event-driven main loop (todos/0178): term was a frame-callback app —
     * 60 wakes/s polling the master even when nothing moved. Each
     * iteration handles whatever woke it (frame_cb drains the SDL queue,
     * the master, and reaps the child), then parks in the kernel's
     * unified WAIT on term's TWO sources: the pty master and the input
     * ring. Child death normally surfaces as master EOF (last slave fd
     * closed); the no-op SIGCHLD handler covers the direct child dying
     * while grandchildren still hold the slave — the EINTR wake runs
     * frame_cb's waitpid promptly instead of at the next output. */
    signal(SIGCHLD, on_chld);
    for (;;) {
        frame_cb();
        if (chld_seen) { chld_seen = 0; continue; }   /* claimed mid-frame:
                                                         re-run the waitpid */
        __wait(&mfd, 1, 1, -1);
    }
}
