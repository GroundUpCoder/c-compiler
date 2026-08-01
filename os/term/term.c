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
 *   - A macOS-Terminal-style menu bar (todos/0273c): a "menubar" strip
 *     child window over the top MENU_BAR_H px (the kernel anchored-child
 *     primitive, todos/0256) whose dropdowns ride the ONE menu engine
 *     (os/win32/menucore.h — term is customer #3 after user32 and wm.c)
 *     as real POPUP_MENU anchored children titled "#32768". The grid
 *     renders below the bar (GRID_Y offset).
 *   - Shell > Settings… (todos/0273d) opens a hand-drawn settings window
 *     (font size / theme / scrollback / cursor / bell); config lives in
 *     the cfgstore.h three-layer overlay `~/.config/term > /etc/term >
 *     /usr/share/term`, loads at startup, applies live, and live-reloads
 *     across processes via an FS_WATCH on ~/.config.
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
#include "../cfgstore.h" /* the three-layer per-key config overlay (CS3) —
                          * term's settings store (todos/0273d) */
#include "../sounds.h"   /* the 0094 event-sound scheme: the audible bell */
#include "../fswatch.h"  /* FS_WATCH (#75): live settings reload across
                          * processes — term is consumer #3 after mgp and
                          * fileman (todos/0273d) */
#include "../fontcore.h"  /* the shared glyph pipeline (todos/0277) — pulls
                           * freetype, fontchain.h (fallback list) and
                           * wcwidth.h (double-width; MUST MATCH kernel.js) */
#include <SDL_popup.h>    /* the kernel anchored-child popup primitive (0256) */
#include "../win32/menucore.h"        /* the ONE menu engine (0259 A13): term
                                       * is customer #3 — the wm.c pattern,
                                       * menucore.json only, no user32/
                                       * kernel32 (todos/0273c) */
#include "../win32/win32_internal.h"  /* __gdi_dc_wrap: engine raster over an
                                       * SDL surface's pixels */

/* User-override font first, then the baked vendor default (todos/0040 —
 * systemd-style /etc: an empty /etc must boot). */
#define FONT_PATH      "/etc/fonts/mono.ttf"
#define FONT_FALLBACK  "/usr/share/fonts/mono.ttf"
#define INIT_COLS  80
#define INIT_ROWS  24
#define MAX_PARAMS 16

/* ---- cell grid ---- */

typedef struct {
    uint32_t cp;           /* Unicode code point; one per cell (combining
                              marks get their own spacing cell — D5). A
                              wide (wcwidth 2) char owns TWO cells: the
                              lead cell holds the cp, its right neighbor
                              holds CP_WIDE_CONT (Phase D) */
    unsigned char fg, bg;  /* palette index: 0..15 ANSI, 16 defFg, 17 defBg */
    unsigned char attr;    /* bit0 bold, bit1 reverse, bit2 dim */
} Cell;

/* The continuation half of a wide pair. Renders as bg only (its colors
 * mirror the lead's at write time so reverse/selection span the pair);
 * an ORPHANED continuation (its lead overwritten by grid surgery like
 * ICH/DCH) degrades to a blank cell — never a stray glyph. Copy skips
 * it. 0 can't collide with content: cells otherwise never hold < 32. */
#define CP_WIDE_CONT 0u

#define A_BOLD    1
#define A_REVERSE 2
#define A_DIM     4
#define DEF_FG    16
#define DEF_BG    17

/* Slots 16/17 (default fg/bg) are the THEME pair — the one mutable part
 * of the palette (todos/0273d): a theme swaps the default pair only, the
 * 16 ANSI colors stay fixed, so SGR-colored output keeps its colors on
 * any theme (Terminal profiles behave the same). */
static uint8_t PAL[18][3] = {
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

/* ---- configuration (todos/0273d) ----
 * The store is `term` in the cfgstore.h three-layer per-key overlay
 * (arch CS3): ~/.config/term (what the settings window's cfg_set writes,
 * one key per change) > /etc/term > baked /usr/share/term. Keys — the
 * defaults below EQUAL the baked file, so a factory image and a
 * storeless run agree:
 *   fontsize    14      (grid font px, 8..32)
 *   theme       dark    (dark | light | green | amber | ocean)
 *   scrollback  2000    (history lines, 0..10000; 0 disables)
 *   cursor      block   (block | under | bar)
 *   bell        sound   (sound | visual | none)
 *   autoscroll  on      (on | off; 0/1 accepted — snap the view back to
 *                        live when new output arrives, #354)
 * Loaded BEFORE glyph metrics / ring allocation at startup; applied live
 * by the settings window; live-reloaded on a ~/.config FS_WATCH event so
 * a settings change in ANY term reaches every open one (macOS Terminal
 * applies profile edits to all windows). */
#define TC_DEF_FONTSIZE   14
#define TC_FONT_MIN        8
#define TC_FONT_MAX       32
#define TC_DEF_SCROLLBACK 2000
#define TC_SB_CAP         10000
#define TC_SB_STEP        500

typedef struct { const char *name; uint8_t fg[3], bg[3]; } Theme;
static const Theme THEMES[] = {
    { "dark",  { 220, 220, 220 }, { 0, 0, 0 } },     /* the classic default */
    { "light", { 0, 0, 0 },       { 255, 255, 255 } },
    { "green", { 51, 255, 51 },   { 0, 0, 0 } },
    { "amber", { 255, 191, 0 },   { 0, 0, 0 } },
    { "ocean", { 224, 236, 255 }, { 16, 44, 84 } },
};
#define N_THEMES ((int)(sizeof THEMES / sizeof THEMES[0]))

enum { CUR_BLOCK, CUR_UNDER, CUR_BAR };
enum { BELL_SOUND, BELL_VISUAL, BELL_NONE };
static const char *const CURSOR_NAMES[3] = { "block", "under", "bar" };
static const char *const BELL_NAMES[3]   = { "sound", "visual", "none" };
static const char *const ONOFF_NAMES[2]  = { "off", "on" };

static int font_size = TC_DEF_FONTSIZE;
static int theme_idx;              /* index into THEMES */
static int cursor_style = CUR_BLOCK;
static int bell_mode = BELL_SOUND;
static int autoscroll_on = 1;      /* snap the view to live on new output
                                      (#354; the `autoscroll` config key) */
static int bell_pending;           /* BELs coalesce: one per drain pass */
static int flash_on;               /* visual bell: grid band inverted */

static void theme_apply(int idx) {
    if (idx < 0 || idx >= N_THEMES) idx = 0;
    theme_idx = idx;
    memcpy(PAL[DEF_FG], THEMES[idx].fg, 3);
    memcpy(PAL[DEF_BG], THEMES[idx].bg, 3);
    dirty = 1;
}

static int tc_clamp(int v, int lo, int hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

static int tc_enum(const char *val, const char *const names[], int n,
                   int def) {
    for (int i = 0; i < n; i++)
        if (strcasecmp(val, names[i]) == 0) return i;
    return def;
}

typedef struct { int fontsize, theme, scrollback, cursor, bell,
                 autoscroll; } TermCfg;

/* The effective configuration: defaults overlaid by whatever store
 * layers exist (cfg_load3 already reported any read error loudly; a
 * partial load degrades to the valid prefix). Malformed values fall back
 * per key. */
static void tc_load(TermCfg *c) {
    char text[CFG_STORE_MAX], val[64], user[300];
    c->fontsize = TC_DEF_FONTSIZE;
    c->theme = 0;
    c->scrollback = TC_DEF_SCROLLBACK;
    c->cursor = CUR_BLOCK;
    c->bell = BELL_SOUND;
    c->autoscroll = 1;
    cfg_user_path(user, sizeof user, "term");
    text[0] = 0;
    cfg_load3(text, sizeof text, user, "/etc/term", "/usr/share/term");
    if (cfg_find(text, "fontsize", val, sizeof val))
        c->fontsize = tc_clamp(atoi(val), TC_FONT_MIN, TC_FONT_MAX);
    if (cfg_find(text, "theme", val, sizeof val))
        for (int i = 0; i < N_THEMES; i++)
            if (strcasecmp(val, THEMES[i].name) == 0) c->theme = i;
    if (cfg_find(text, "scrollback", val, sizeof val))
        c->scrollback = tc_clamp(atoi(val), 0, TC_SB_CAP);
    if (cfg_find(text, "cursor", val, sizeof val))
        c->cursor = tc_enum(val, CURSOR_NAMES, 3, CUR_BLOCK);
    if (cfg_find(text, "bell", val, sizeof val))
        c->bell = tc_enum(val, BELL_NAMES, 3, BELL_SOUND);
    if (cfg_find(text, "autoscroll", val, sizeof val))
        /* on|off per tc_enum; a bare 0 also reads as off, anything else
         * (incl. malformed) falls back to the on default (#354). */
        c->autoscroll = tc_enum(val, ONOFF_NAMES, 2,
                                strcmp(val, "0") == 0 ? 0 : 1);
}

/* ---- scrollback history ring (todos/0273a) ----
 * Lines that scroll off the TOP of the main screen (a real terminal scroll:
 * a linefeed at the bottom with the scroll region anchored at row 0) are
 * pushed here instead of discarded, so the user can scroll UP into output
 * that has left the viewport. This is DELIBERATELY independent of the ANSI
 * scroll region (scroll_top/scroll_bot): that region is an in-screen VT100
 * concept (DECSTBM, IL/DL, SU/SD); this is user-facing history. Only
 * linefeed() with scroll_top==0 on the main grid feeds it — DL/IL/SU and
 * any scroll under a non-top region do NOT (xterm's rule), so an editor's
 * in-screen scrolling never pollutes history.
 *
 * Each history line stores its own captured width (HistLine.len), so a
 * resize needs no reflow and can't corrupt the ring: render clamps to the
 * live cols and pads short/absent cells with the default background. The
 * alt screen has no scrollback (vi/less); entering it forces the view live.
 *
 * view_off is how many lines the viewport is scrolled UP from the live
 * bottom (0 = live grid). Writing ALWAYS targets the live grid regardless
 * of view_off; rendering and the selection anchors (#355) map through the
 * offset. New output or any non-
 * scroll keypress snaps back to live (Terminal behaviour). The ring's
 * capacity is the `scrollback` config key (todos/0273d, default 2000):
 * a heap array of sb_max slots, re-sized live by sb_set_max. */
typedef struct { Cell *cells; int len; } HistLine;
static HistLine *hist;              /* ring, sb_max slots (todos/0273d) */
static int sb_max;                  /* configured capacity; 0 = disabled */
static int hist_count;              /* valid lines, <= sb_max */
static int hist_head;               /* ring index of the oldest line */
static int view_off;                /* lines scrolled up from live; 0 = live */

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

/* ---- selection / clipboard (todos/0090; virtual rows since #355) ----
   Mouse drag selects a linear (row-major, xterm-style) cell range;
   Ctrl+Shift+C copies it to the system clipboard (SDL_SetClipboardText ->
   the kernel's one slot), Ctrl+Shift+V pastes the slot into the pty
   master. Selection rows are VIRTUAL line indices — the renderer's
   view_row space: virt = hist_count - view_off + viewport_row, so
   [0, hist_count) is history (oldest first) and [hist_count,
   hist_count + rows) is the live grid. Virtual indices are anchored to
   CONTENT, like xterm: a hist_push moves a live line into history without
   changing its virt index, so the highlight follows its text; a ring
   eviction shifts every index down one (hist_push shifts the anchors and
   clears a selection whose content is evicted). The selection clears on
   the next click, a resize, or a history reset (RIS / Clear Scrollback,
   #355). Columns are plain cell columns. */
static int sel_on;                 /* a selection exists (rendered inverted) */
static int sel_drag;               /* left button held: extending */
static int sel_ax, sel_ay;         /* anchor cell (col, virt row) */
static int sel_ex, sel_ey;         /* extent cell (inclusive; col, virt row) */

/* ---- SDL / freetype ---- */
static SDL_Window *win;
static SDL_Surface *surf;
static FT_Library ft_lib;
static FT_Face face;
static int cell_w, cell_h, ascent;

/* Two-tier glyph cache (fontcore FcCache, todos/0277): ASCII in a flat
 * array rendered eagerly at startup, everything else in a lazily-grown
 * linear-scan side cache. A code point the face lacks renders as a
 * synthesized tofu box — a LOUD gap marker, never a '?' that reads as
 * data corruption. NB a side-cache pointer is only stable until the next
 * cp_glyph call (the cache reallocs). */
static FcCache g_cache;

/* ============================================================ grid ops */

static Cell blank_cell(void) {
    Cell c;
    c.cp = ' ';
    c.fg = cur_fg;
    c.bg = cur_bg;
    c.attr = 0;
    return c;
}

static void clear_cells(Cell *g, int from, int count) {
    Cell b = blank_cell();
    for (int i = 0; i < count; i++) g[from + i] = b;
}

/* The i-th oldest history line (0 = oldest). Callers guarantee
 * hist_count > 0, which implies sb_max > 0. */
static HistLine *hist_at(int i) { return &hist[(hist_head + i) % sb_max]; }

/* Dropping n lines off the FRONT of history shifts every virtual index
 * down by n: the selection anchors follow their content, and a selection
 * whose content is gone clears (#355). Shared by the hist_push eviction
 * and the sb_set_max shrink. */
static void sel_evict(int n) {
    if (!sel_on && !sel_drag) return;
    sel_ay -= n;
    sel_ey -= n;
    if (sel_ay < 0 || sel_ey < 0) { sel_on = sel_drag = 0; dirty = 1; }
}

/* Push one about-to-be-discarded screen row into the ring (oldest evicted
 * at the cap). The line keeps the width it was captured at. */
static void hist_push(const Cell *row, int len) {
    HistLine *slot;
    if (!sb_max) return;               /* scrollback disabled (0273d) */
    if (hist_count < sb_max) {
        slot = &hist[(hist_head + hist_count) % sb_max];
        hist_count++;
    } else {
        slot = &hist[hist_head];
        free(slot->cells);
        hist_head = (hist_head + 1) % sb_max;
        sel_evict(1);
    }
    slot->cells = malloc((size_t)len * sizeof(Cell));
    if (!slot->cells) { slot->len = 0; return; }
    memcpy(slot->cells, row, (size_t)len * sizeof(Cell));
    slot->len = len;
    /* Content anchor (#354): a scrolled-up view (or a held thumb) tracks
     * the LINE it shows, not its distance from live — without this every
     * pushed line slides the content under the viewport. The snap paths
     * (autoscroll on, any keypress) still reset to live afterwards. At a
     * full ring's top the clamp holds: the anchored line is being evicted. */
    if (view_off && view_off < hist_count) { view_off++; dirty = 1; }
}

static void hist_clear(void) {
    for (int i = 0; i < hist_count; i++) free(hist_at(i)->cells);
    hist_count = 0; hist_head = 0; view_off = 0;
    sel_on = sel_drag = 0;             /* virt anchors just dangled (#355) */
}

/* Scroll the viewport by delta lines (+ = toward history/up), clamped to
 * [0, hist_count]. */
static void scroll_view(int delta) {
    int nv = view_off + delta;
    if (nv < 0) nv = 0;
    if (nv > hist_count) nv = hist_count;
    if (nv != view_off) { view_off = nv; dirty = 1; }
}

/* Snap the viewport back to the live bottom. */
static void snap_live(void) {
    if (view_off != 0) { view_off = 0; dirty = 1; }
}

/* Re-size the ring to the configured capacity (todos/0273d): keep the
 * NEWEST min(count, n) lines, free the rest, compact to index 0. Also
 * the startup allocator (sb_max starts 0). */
static void sb_set_max(int n) {
    if (n < 0) n = 0;
    if (n > TC_SB_CAP) n = TC_SB_CAP;
    if (n == sb_max) return;
    HistLine *nh = n ? calloc((size_t)n, sizeof(HistLine)) : NULL;
    if (n && !nh) return;              /* OOM: keep the old ring */
    int keep = hist_count < n ? hist_count : n;
    for (int i = 0; i < hist_count - keep; i++) free(hist_at(i)->cells);
    sel_evict(hist_count - keep);      /* a shrink drops oldest lines (#355) */
    for (int i = 0; i < keep; i++) nh[i] = *hist_at(hist_count - keep + i);
    free(hist);
    hist = nh;
    sb_max = n;
    hist_head = 0;
    hist_count = keep;
    if (view_off > hist_count) view_off = hist_count;
    dirty = 1;
}

/* ---- side scrollbar (todos/0273b) ----
 * A macOS-style OVERLAY bar at the surface's right edge — a pure view +
 * controller over the (a) model above: hist_count/view_off are the ONLY
 * position state (wheel, keys and bar can never disagree). Overlay, not
 * reserved columns: cols stays surf->w / cell_w, so the 80x24-at-640x456
 * geometry contract is untouched; the bar alpha-blends over the last
 * column's pixels instead. Hidden when there is no history (and on the
 * alt screen — no scrollback there), so a no-history term renders
 * byte-identical to the pre-scrollbar output; persistent while history
 * exists — a macOS-style fade-out would need timed wakeups, and term is
 * an event-driven zero-wakes-when-idle app (0178). */
#define SB_W    8                  /* overlay width, px */
#define SB_MIN 12                  /* thumb never shrinks below a grab target */
static int sb_drag;                /* left button holds the thumb */
static int sb_grab;                /* pointer offset into the thumb at grab */

static int sb_visible(void) { return !on_alt && hist_count > 0; }

/* Thumb geometry at surface height sh (only called when sb_visible():
 * hist_count > 0). Proportional to viewport/total with a floor; view_off
 * 0 lands the thumb flush at the bottom (ty + th == sh exactly). */
static void sb_geom(int sh, int *ty, int *th) {
    int total = hist_count + rows;
    int t = sh * rows / total;
    if (t < SB_MIN) t = SB_MIN;
    if (t > sh) t = sh;
    int travel = sh - t;
    *ty = travel > 0 ? travel * (hist_count - view_off) / hist_count : 0;
    *th = t;
}

/* Map a dragged pointer y back to view_off (the sb_geom inverse, with
 * symmetric rounding), clamped like scroll_view. */
static void sb_drag_to(int y, int sh) {
    int ty, th;
    sb_geom(sh, &ty, &th);
    int travel = sh - th;
    if (travel < 1) return;
    int ny = y - sb_grab;
    if (ny < 0) ny = 0;
    if (ny > travel) ny = travel;
    int nv = hist_count - (ny * hist_count + travel / 2) / travel;
    if (nv != view_off) { view_off = nv; dirty = 1; }
}

/* to_hist: this is a real top-of-screen scroll that should feed scrollback
 * (linefeed at the bottom). DL/IL/SU pass 0 — they scroll in-screen only. */
static void scroll_up(int n, int to_hist) {
    if (n < 1) n = 1;
    int span = scroll_bot - scroll_top + 1;
    if (n > span) n = span;
    if (to_hist && !on_alt && scroll_top == 0)
        for (int i = 0; i < n; i++)
            hist_push(&grid[(scroll_top + i) * cols], cols);
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
    if (cy == scroll_bot) scroll_up(1, 1);   /* real scroll: feed scrollback */
    else if (cy < rows - 1) cy++;
}

static void put_char(uint32_t cp) {
    int w = wcwidth_cp(cp);          /* 1 or 2 (D5: combining = own cell) */
    if (wrap_pending && autowrap) {
        cx = 0;
        linefeed();
    }
    wrap_pending = 0;
    if (w == 2 && cx == cols - 1) {  /* wide chars never split across rows */
        if (autowrap) { cx = 0; linefeed(); }
        else w = 1;                  /* no-wrap edge: clipped single cell */
    }
    Cell *row = &grid[cy * cols];
    /* Overwriting half of an existing wide pair blanks the other half —
     * a lead may not survive without its continuation or vice versa. */
    uint32_t old = row[cx].cp;
    if (old == CP_WIDE_CONT && cx > 0 && wcwidth_cp(row[cx - 1].cp) == 2)
        row[cx - 1].cp = ' ';
    if (wcwidth_cp(old) == 2 && cx + 1 < cols && row[cx + 1].cp == CP_WIDE_CONT)
        row[cx + 1].cp = ' ';
    Cell *c = &row[cx];
    c->cp = cp;
    c->fg = cur_fg;
    c->bg = cur_bg;
    c->attr = cur_attr;
    if (w == 2) {
        Cell *n = c + 1;             /* guaranteed in-row by the check above */
        n->cp = CP_WIDE_CONT;
        n->fg = cur_fg;
        n->bg = cur_bg;
        n->attr = cur_attr;
    }
    if (cx + w > cols - 1) { cx = cols - 1; wrap_pending = 1; }
    else cx += w;
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
    hist_clear();          /* RIS clears scrollback (and snaps the view live) */
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
        else if (p == 2) cur_attr |= A_DIM;
        else if (p == 22) cur_attr &= ~(A_BOLD | A_DIM);   /* ECMA-48: 22 = normal intensity */
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
    view_off = 0;          /* alt screen has no scrollback; keep the view live */
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
            scroll_up(P(0, 1), 0);   /* DL: in-screen only, not scrollback */
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
    case 'S': scroll_up(P(0, 1), 0); break;   /* SU: in-screen, not scrollback */
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

/* Stateful UTF-8 accumulator (todos: gucOS Unicode Phase A). Lives across
 * term_putc calls because pty reads split sequences arbitrarily (the drain
 * loop feeds byte-at-a-time). Malformed input — stray/invalid lead, bad
 * continuation, overlong, surrogate, > U+10FFFF — becomes U+FFFD; an
 * interrupted sequence stamps U+FFFD and the interrupting byte is
 * reprocessed from ground. Only consulted in ST_GROUND: escape sequences
 * are pure ASCII (OSC title bytes pass through raw, still UTF-8). */
static uint32_t u8_acc;            /* accumulated code point bits */
static int u8_more;                /* continuation bytes still expected */
static uint32_t u8_min;            /* lowest cp the sequence may encode */

static void ground_byte(unsigned char b);

static void ground_utf8(unsigned char b) {
    if (u8_more) {
        if ((b & 0xC0) == 0x80) {
            u8_acc = (u8_acc << 6) | (b & 0x3Fu);
            if (--u8_more == 0) {
                uint32_t cp = u8_acc;
                if (cp < u8_min || cp > 0x10FFFF ||
                    (cp >= 0xD800 && cp <= 0xDFFF))
                    cp = 0xFFFD;             /* overlong / surrogate / range */
                put_char(cp);
            }
            return;
        }
        u8_more = 0;                         /* interrupted sequence */
        put_char(0xFFFD);
        ground_byte(b);                      /* reprocess from ground */
        return;
    }
    if (b >= 0xF0 && b <= 0xF4) { u8_more = 3; u8_acc = b & 0x07u; u8_min = 0x10000; }
    else if (b >= 0xE0)         { u8_more = 2; u8_acc = b & 0x0Fu; u8_min = 0x800; }
    else if (b >= 0xC2)         { u8_more = 1; u8_acc = b & 0x1Fu; u8_min = 0x80; }
    else put_char(0xFFFD);      /* stray continuation, 0xC0/0xC1, 0xF5+ */
}

static void ground_byte(unsigned char b) {
    if (b >= 0x80 || u8_more) { ground_utf8(b); return; }
    if (b == 0x1b) { pstate = ST_ESC; return; }
    if (b == 0x08) { if (cx > 0) cx--; wrap_pending = 0; return; }
    if (b == 0x09) {
        cx = ((cx / 8) + 1) * 8;
        if (cx > cols - 1) cx = cols - 1;
        wrap_pending = 0;
        return;
    }
    if (b == 0x0a || b == 0x0b || b == 0x0c) { linefeed(); return; }
    if (b == 0x0d) { cx = 0; wrap_pending = 0; return; }
    if (b == 0x07) { bell_pending = 1; return; }   /* BEL: serviced once per
                                                      drain pass (0273d) */
    if (b < 32) return;                      /* other C0: ignore */
    put_char(b);
}

static void term_putc(unsigned char b) {
    switch (pstate) {
    case ST_GROUND:
        ground_byte(b);
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

/* Encode cp as UTF-8 into u (>= 4 bytes); returns the byte count. Cells
 * and keysyms are already validated, so > U+10FFFF cannot occur. */
static int u8_encode(uint32_t cp, char *u) {
    if (cp < 0x80) { u[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        u[0] = (char)(0xC0 | (cp >> 6));
        u[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        u[0] = (char)(0xE0 | (cp >> 12));
        u[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        u[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    u[0] = (char)(0xF0 | (cp >> 18));
    u[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    u[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    u[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static int cell_clamp(int v, int lim) {
    if (v < 0) return 0;
    if (v >= lim) return lim - 1;
    return v;
}

static void sel_bounds(int *s, int *e) {   /* linear cell indices, virt rows */
    int a = sel_ay * cols + sel_ax;
    int b = sel_ey * cols + sel_ex;
    if (a <= b) { *s = a; *e = b; } else { *s = b; *e = a; }
}

static int sel_has(int r, int c) {               /* r is a VIRT row (#355) */
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
    /* worst case: 4 UTF-8 bytes per cell + a newline per row + NUL */
    char *buf = malloc((size_t)(e - s + 1) * 4 + (size_t)(r1 - r0) + 1);
    if (!buf) return;
    int n = 0;
    for (int r = r0; r <= r1; r++) {
        int c0 = r == r0 ? s % cols : 0;
        int c1 = r == r1 ? e % cols : cols - 1;
        /* Virt row source (#355): history below hist_count (a captured
         * line's own width; cells past it read as blanks and trim away),
         * the live grid above it. */
        const Cell *src;
        int slen;
        if (r < hist_count) {
            HistLine *h = hist_at(r);
            src = h->cells; slen = h->len;
        } else {
            src = &grid[(r - hist_count) * cols]; slen = cols;
        }
        int line = n;
        for (int c = c0; c <= c1; c++) {
            uint32_t cp = c < slen ? src[c].cp : ' ';
            if (cp == CP_WIDE_CONT) continue; /* the lead already encoded it */
            if (cp < 32) cp = ' ';           /* defensive: cells never hold C0 */
            n += u8_encode(cp, buf + n);
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
    /* Scrollback navigation (todos/0273a): plain PageUp/PageDown page through
     * history on the MAIN screen — alt-screen apps (vi/less, no scrollback)
     * keep the keys for themselves. These deliberately do NOT snap to live;
     * scrolling into history is the point. */
    if (!on_alt && (mod & (SDL_KMOD_CTRL | SDL_KMOD_GUI | SDL_KMOD_ALT)) == 0) {
        if (sym == SDLK_PAGEUP)   { scroll_view(rows > 1 ? rows - 1 : 1); return; }
        if (sym == SDLK_PAGEDOWN) { scroll_view(-(rows > 1 ? rows - 1 : 1)); return; }
    }
    /* A pure modifier press is not input: Ctrl going down ahead of a copy
       chord must not yank a scrolled view back to live (#355). */
    if (sym >= SDLK_LCTRL && sym <= SDLK_RGUI) return;
    /* The terminal's copy/paste chords resolve through the scheme table
       (todos/0149, os/keys.h): Ctrl+Shift+C/V under the windows keymap,
       ⌘C/V under macos — plain Ctrl+C stays the tty's SIGINT byte either
       way. Keysyms are modifier-applied, so the shifted letter usually
       arrives uppercase (key_action case-folds). Copy resolves BEFORE the
       snap — copying what you scrolled to see must not scroll you away
       from it (#355); paste types into the pty, so it snaps like any key. */
    if (sym >= 32 && sym <= 126) {
        int act = key_action(KCTX_TERM, km_from_sdl(mod), sym);
        if (act == KA_COPY) { copy_selection(); return; }
        if (act == KA_PASTE) { snap_live(); paste_clipboard(); return; }
    }
    /* Any other key snaps the viewport back to the live bottom (Terminal). */
    snap_live();
    /* GUI is never a text modifier: an unbound ⌘chord DROPS here instead
       of typing its letter (the ⌘C-typed-'c' bug, folded into 0149). */
    if (mod & SDL_KMOD_GUI) return;
    if (sym == SDLK_RETURN) { b = '\r'; write(mfd, &b, 1); return; }
    if (sym == SDLK_BACKSPACE) { b = 0x7f; write(mfd, &b, 1); return; }  /* VERASE */
    if (sym == SDLK_TAB) { b = '\t'; write(mfd, &b, 1); return; }
    if (sym == SDLK_ESCAPE) { b = 0x1b; write(mfd, &b, 1); return; }
    if (sym == SDLK_DELETE) { reply("\x1b[3~"); return; }
    if (sym >= 0x40000000) { send_named(sym); return; }
    if (sym < 32 || sym == 127 || sym > 0x10FFFF) return;
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
    /* The keysym IS a Unicode code point (host.js carries BMP chars and —
       via the surrogate-pair fix — astral chars in the ring's Int32 word);
       UTF-8-encode it onto the wire, 1-4 bytes. */
    char u[4];
    write(mfd, u, u8_encode((uint32_t)sym, u));
}

/* ============================================================ menu bar
 * (todos/0273c) — a macOS-Terminal-style top menu riding the OS's ONE
 * menu facility at both layers: the strip and every dropdown are kernel
 * anchored-child popup surfaces (SDL_CreatePopupWindow, todos/0256), and
 * the dropdown model/geometry/tracking/raster are the menucore engine
 * (todos/0259 A13) — term is the engine's customer #3 after user32 and
 * wm.c, linking win32/menucore.json (menucore.c + gdi32.c) WITHOUT
 * user32/kernel32, exactly the wm.c pattern. The bar strip itself is
 * front-end furniture (as in user32): painted through a __gdi_dc_wrap DC
 * in the engine's own font/colors, so bar and dropdowns are pixel-uniform
 * with every other OS menu. Dropdown levels hold the kernel grab
 * (SDL_WINDOW_POPUP_MENU, titled "#32768" like any Win32 menu window —
 * `wmctl wait win "#32768"` works on term's menus too); an outside press
 * dismisses kernel-side (CLOSE_REQUESTED) and is consumed. While a chain
 * is open the menu is MODAL: keys drive the engine (never the pty, so
 * browsing a menu can't snap the scrollback view or type into the shell)
 * and a main-window press just closes it. The grid lives below the strip:
 * everything grid-facing offsets by GRID_Y. */
#define GRID_Y MENU_BAR_H

enum { CM_NEWWIN = 1, CM_SETTINGS, CM_CLOSEWIN,
       CM_COPY, CM_PASTE, CM_SELALL,
       CM_TOP, CM_BOTTOM, CM_CLEARSB };

static SDL_Window *bar_win;        /* the persistent "menubar" strip child */
static MenuTbl *menu_root;         /* bar level: Shell / Edit / View */
static int bar_idx = -1;           /* open bar title, -1 none */
/* Live-grayed items, refreshed in the popup_opening op (the
 * WM_INITMENUPOPUP analog — fired before the level is measured, so the
 * paint reflects the moment it opens). */
static MenuItem *mi_copy, *mi_paste, *mi_top, *mi_bottom, *mi_clear;

static void bar_paint(void);
static void settings_open(void);   /* the 0273d settings window, below */

/* Window (Minimize/Zoom) and Help menus are deliberately absent: they
 * need WMP chrome ops term doesn't speak (it is not a wm.sock client) /
 * dialog furniture term doesn't have — recorded in the 0273c design
 * note, not silently cut. */
static void menu_build(void) {
    MenuTbl *shell = mc_menu_create(), *edit = mc_menu_create(),
            *view = mc_menu_create();
    mc_append(shell, 0, CM_NEWWIN, "New Window", NULL);
    mc_append(shell, 0, CM_SETTINGS, "Settings...", NULL);
    mc_append(shell, 2, 0, NULL, NULL);
    mc_append(shell, 0, CM_CLOSEWIN, "Close Window", NULL);
    mi_copy = mc_append(edit, 0, CM_COPY, "Copy", NULL);
    mi_paste = mc_append(edit, 0, CM_PASTE, "Paste", NULL);
    mc_append(edit, 0, CM_SELALL, "Select All", NULL);
    mi_top = mc_append(view, 0, CM_TOP, "Scroll to Top", NULL);
    mi_bottom = mc_append(view, 0, CM_BOTTOM, "Scroll to Bottom", NULL);
    mc_append(view, 2, 0, NULL, NULL);
    mi_clear = mc_append(view, 0, CM_CLEARSB, "Clear Scrollback", NULL);
    menu_root = mc_menu_create();
    mc_append(menu_root, 1, 0, "Shell", shell);
    mc_append(menu_root, 1, 0, "Edit", edit);
    mc_append(menu_root, 1, 0, "View", view);
}

static void spawn_sibling_term(void) {
    /* Shell > New Window: an independent sibling session (macOS
     * Terminal's ⌘N shape, not a nested term). Own pgroup; the pty
     * master must NOT leak into it (a second holder would defeat
     * master-close EOF). Reaped by frame_cb's WNOHANG loop. */
    char *argv[] = { "term", NULL };
    char *envp[] = { LAUNCH_ENV_PATH, LAUNCH_ENV_HOME,
                     "TERM=xterm-256color", NULL };
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addclose(&fa, mfd);
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);
    pid_t pid;
    posix_spawnp(&pid, "/bin/term", &fa, &at, argv, envp);
    posix_spawnattr_destroy(&at);
    posix_spawn_file_actions_destroy(&fa);
}

/* ---- the menucore seam instance (A7) — the u32_mc / wmmc pattern ---- */

static void tmc_post_command(void *owner, int id) {
    (void)owner;                       /* one window; the ids say it all */
    switch (id) {
    case CM_NEWWIN:   spawn_sibling_term(); break;
    case CM_SETTINGS: settings_open(); break;      /* todos/0273d */
    case CM_CLOSEWIN: exit(0); break;  /* master close HUPs the session (0020) */
    case CM_COPY:     copy_selection(); break;
    case CM_PASTE:    paste_clipboard(); break;
    case CM_SELALL:
        /* The VISIBLE viewport, in virt rows (#355) — while scrolled it
         * selects what is on screen, not the live bottom. */
        sel_ax = 0; sel_ay = hist_count - view_off;
        sel_ex = cols - 1; sel_ey = hist_count - view_off + rows - 1;
        sel_on = 1; sel_drag = 0;
        dirty = 1;
        break;
    case CM_TOP:      scroll_view(hist_count); break;
    case CM_BOTTOM:   snap_live(); break;
    case CM_CLEARSB:  hist_clear(); dirty = 1; break;
    default: break;
    }
}

static void tmc_track_state(void *owner, int entering, int standalone) {
    (void)owner; (void)standalone;
    if (!entering) { bar_idx = -1; bar_paint(); }    /* un-highlight */
}

static void tmc_popup_opening(void *owner, void *tbl, int idx) {
    (void)owner; (void)tbl; (void)idx;
    mi_copy->state = sel_on ? 0 : MF_GRAYED;
    mi_paste->state = SDL_HasClipboardText() ? 0 : MF_GRAYED;
    /* View drives the (a) scrollback model; the alt screen has none. */
    mi_top->state = (!on_alt && view_off < hist_count) ? 0 : MF_GRAYED;
    mi_bottom->state = (!on_alt && view_off > 0) ? 0 : MF_GRAYED;
    mi_clear->state = (!on_alt && hist_count > 0) ? 0 : MF_GRAYED;
}

static MCWIN tmc_win_create(MCWIN parent, int dx, int dy, int w, int h,
                            int grab) {
    SDL_Window *pw = SDL_CreatePopupWindow((SDL_Window *)parent, dx, dy, w, h,
                                           grab ? SDL_WINDOW_POPUP_MENU
                                                : SDL_WINDOW_TOOLTIP);
    if (!pw) {
        fprintf(stderr, "term: menu overlay window failed: %s\n",
                SDL_GetError());
        return NULL;
    }
    /* The real Win32 menu window class name: tests wait on it exactly as
     * on any win32 app's menus. */
    SDL_SetWindowTitle(pw, grab ? "#32768" : "menubar");
    return (MCWIN)pw;
}

static void tmc_win_destroy(MCWIN w) { SDL_DestroyWindow((SDL_Window *)w); }

static HDC tmc_win_begin(MCWIN w, int *wOut, int *hOut) {
    SDL_Surface *s = SDL_GetWindowSurface((SDL_Window *)w);
    if (!s) return NULL;
    if (wOut) *wOut = s->w;
    if (hOut) *hOut = s->h;
    return __gdi_dc_wrap(s->pixels, s->w, s->h, s->pitch / 4);
}

static void tmc_win_present(MCWIN w, HDC dc) {
    __gdi_dc_unwrap(dc);
    SDL_UpdateWindowSurface((SDL_Window *)w);
}

static void tmc_screen_size(int *wOut, int *hOut) {
    SDL_Rect scr;
    if (SDL_GetDisplayBounds(0, &scr)) { *wOut = scr.w; *hOut = scr.h; }
    else { *wOut = 0; *hOut = 0; }     /* no cap */
}

static const MenuCoreOps term_mc = {
    tmc_post_command, tmc_track_state, tmc_popup_opening,
    tmc_win_create, tmc_win_destroy, tmc_win_begin, tmc_win_present,
    tmc_screen_size,
};

/* ---- bar furniture (the user32 menu_bar_* shape, single top-level) ---- */

static int bar_pad(void) {
    int pw, ph;
    if (!menu_root || !menu_root->n || !win ||
        !SDL_GetWindowSize(win, &pw, &ph))
        return 16;
    int text = 0;
    for (int i = 0; i < menu_root->n; i++)
        text += mc_text_w(menu_root->items[i].text);
    if (2 + text + menu_root->n * 16 <= pw) return 16;
    int pad = (pw - 2 - text) / menu_root->n;   /* overflow: shrink (0280) */
    return pad < 6 ? 6 : pad;
}

/* Bar title i's rect in strip coords; 0 past the end. */
static int bar_rect(int i, RECT *r) {
    if (!menu_root || i < 0 || i >= menu_root->n) return 0;
    int pad = bar_pad();
    int x = 2;
    for (int k = 0; k < i; k++)
        x += mc_text_w(menu_root->items[k].text) + pad;
    SetRect(r, x, 0, x + mc_text_w(menu_root->items[i].text) + pad,
            MENU_BAR_H);
    return 1;
}

static int bar_at(int x, int y) {
    if (y < 0 || y >= MENU_BAR_H) return -1;
    for (int i = 0; menu_root && i < menu_root->n; i++) {
        RECT r;
        if (bar_rect(i, &r) && x >= r.left && x < r.right) return i;
    }
    return -1;
}

/* Presented only on menu-STATE changes (open/close/switch/resize ack) —
 * never per term frame; the strip and the grid never touch each other's
 * pixels. */
static void bar_paint(void) {
    if (!bar_win) return;
    SDL_Surface *s = SDL_GetWindowSurface(bar_win);
    if (!s) return;
    HDC dc = __gdi_dc_wrap(s->pixels, s->w, s->h, s->pitch / 4);
    if (!dc) return;
    RECT r;
    SetRect(&r, 0, 0, s->w, s->h);
    FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
    SetRect(&r, 0, MENU_BAR_H - 1, s->w, MENU_BAR_H);
    FillRect(dc, &r, GetSysColorBrush(COLOR_BTNSHADOW));
    SetBkMode(dc, TRANSPARENT);
    int pad = bar_pad();
    for (int i = 0; menu_root && i < menu_root->n; i++) {
        if (!bar_rect(i, &r)) break;
        int open = __mc.open && bar_idx == i;
        if (open) FillRect(dc, &r, GetSysColorBrush(COLOR_HIGHLIGHT));
        SetTextColor(dc, GetSysColor(open ? COLOR_HIGHLIGHTTEXT
                                          : COLOR_BTNTEXT));
        const char *t = menu_root->items[i].text ? menu_root->items[i].text
                                                 : "";
        TextOut(dc, r.left + pad / 2, 2, t, (int)strlen(t));
    }
    __gdi_dc_unwrap(dc);
    SDL_UpdateWindowSurface(bar_win);
}

/* Open bar title idx as chain level 0 (a hover/click switch reuses the
 * live tracking — the user32 menu_open_popup shape). */
static void bar_open(int idx) {
    if (!menu_root || idx < 0 || idx >= menu_root->n) return;
    MenuItem *it = &menu_root->items[idx];
    if (it->kind != 1 || !it->sub) return;
    if (__mc.open) mc_trunc(0);
    else mc_track_begin(&term_mc, (void *)&term_mc, (void *)&term_mc, 0, 0);
    /* NB the owner token must be non-NULL: mc_fire posts a bar tracking's
     * command only `if (owner)` (the wm.c pattern — the vtable address). */
    bar_idx = idx;
    RECT br;
    bar_rect(idx, &br);
    mc_level_open(it->sub, idx, (MCWIN)win, br.left, MENU_BAR_H);
    bar_paint();                       /* highlight the open title */
}

static void bar_mouse(int press, int x, int y) {
    int bi = bar_at(x, y);
    if (!press) {                      /* motion: hover-switch while open */
        if (__mc.open && bi >= 0 && bi != bar_idx) bar_open(bi);
        return;
    }
    if (__mc.open && bi == bar_idx) { mc_close(); return; }
    if (bi >= 0) bar_open(bi);
    else if (__mc.open) mc_close();
}

static int menu_level_by_wid(Uint32 id) {
    for (int k = 0; k < __mc.nlev; k++)
        if (__mc.lev[k].win &&
            SDL_GetWindowID((SDL_Window *)__mc.lev[k].win) == id)
            return k;
    return -1;
}

/* Menu-layer event demux, FIRST in frame_cb's poll loop (the user32
 * pump's coupling-#5 shape: real input arrives on the CHILD windowIDs
 * with child-local coords). Returns 1 when the event was the menu's. */
static int menu_event(const SDL_Event *e) {
    switch (e->type) {
    case SDL_EVENT_KEY_DOWN: {
        if (!__mc.open) return 0;
        int sym = (int)e->key.key;     /* modal: engine keys, rest swallowed */
        if (!mc_route_key(sym) && sym >= 32 && sym <= 126)
            mc_typeahead(sym);         /* wm.c's opt-in first-letter cycle */
        return 1;
    }
    case SDL_EVENT_MOUSE_MOTION: {
        int k = menu_level_by_wid(e->motion.windowID);
        if (k >= 0) {
            mc_level_mouse(k, WM_MOUSEMOVE,
                           (int)e->motion.x, (int)e->motion.y);
            return 1;
        }
        if (bar_win && e->motion.windowID == SDL_GetWindowID(bar_win)) {
            bar_mouse(0, (int)e->motion.x, (int)e->motion.y);
            return 1;
        }
        return 0;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        int down = e->type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        int k = menu_level_by_wid(e->button.windowID);
        if (k >= 0) {
            if (e->button.button == 1)
                mc_level_mouse(k, down ? WM_LBUTTONDOWN : WM_LBUTTONUP,
                               (int)e->button.x, (int)e->button.y);
            return 1;
        }
        if (bar_win && e->button.windowID == SDL_GetWindowID(bar_win)) {
            if (down && e->button.button == 1)
                bar_mouse(1, (int)e->button.x, (int)e->button.y);
            return 1;
        }
        if (__mc.open) {               /* main window while open: modal — a
                                          press closes (the in-window twin
                                          of the kernel grab) and is
                                          swallowed */
            if (down) mc_close();
            return 1;
        }
        return 0;
    }
    case SDL_EVENT_MOUSE_WHEEL:
        return __mc.open ||
               menu_level_by_wid(e->wheel.windowID) >= 0 ||
               (bar_win && e->wheel.windowID == SDL_GetWindowID(bar_win));
    case SDL_EVENT_WINDOW_RESIZED:
        if (bar_win && e->window.windowID == SDL_GetWindowID(bar_win)) {
            bar_paint();               /* the strip's own resize ack (A5) */
            return 1;
        }
        return 0;
    case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
        if (menu_level_by_wid(e->window.windowID) >= 0) {
            mc_close();                /* kernel grab: the outside press
                                          dismissed the chain (consumed) */
            return 1;
        }
        return 0;
    default:
        return 0;
    }
}

/* ============================================================ glyphs */

/* ---- the fallback chain (Unicode Phase D, W7; fontcore FcChain) ----
 * Face 0 is the baked/user mono face `face`; fc_paths load once at
 * startup and each fallback face opens LAZILY the first time a code
 * point misses face 0 (a pure-ASCII session never touches a 12 MB CJK
 * face). The rendered bitmap lands in the cp glyph cache, so the chain
 * is probed once per code point, never per paint. */
static char fc_paths[FC_MAX_FALLBACKS][FC_PATH_MAX];
static FcChain g_chain;

static void term_fc_fail(const char *p) {
    fprintf(stderr, "term: fallback face %s failed to load (skipping)\n", p);
}

/* The face covering cp: face 0, else the chain in list order, else NULL
 * (tofu). ASCII always renders from face 0 (fontcore fc_probe). */
static FT_Face face_for(uint32_t cp, FT_UInt *gi) {
    return fc_probe(face, &g_chain, font_size, cp, gi);
}

/* Render callback (fontcore cache seam): fill g for cp — the covering
 * face via fc_probe, else the tofu box (cell_w x wcwidth). Term is
 * plain AA at one fixed size: no mono threshold, no embolden. */
static FcGlyph *term_render(void *ctx, FcGlyph *g, unsigned cp) {
    (void)ctx;
    g->loaded = 1;
    FT_UInt gi;
    FT_Face f = face_for(cp, &gi);
    if (!f) { fc_tofu(g, cell_w, ascent, cp); return g; }
    FcRenderOpts o = { 0, 0 };
    return fc_render_face(g, f, gi, o);
}

/* Glyph for one code point (control chars -> ' ', defensive; the render
 * loop already skips cp <= 32). ASCII from the flat array, everything
 * else from the linear-scan side cache, rendered on first use. */
static FcGlyph *cp_glyph(uint32_t cp) {
    if (cp < 32) cp = ' ';                   /* defensive: never stamped */
    return fc_cache_get(&g_cache, cp, term_render, NULL);
}

/* ============================================================ settings
 * runtime (todos/0273d) — the live-apply paths shared by the settings
 * window below, the startup load and the FS_WATCH reload. Each is
 * idempotent (same value = no work), so "reload everything and apply"
 * is safe from any of the three callers. */

/* Grid metrics at the current font_size (the load_glyphs math, factored
 * so a live size change reuses it verbatim). */
static void set_metrics(void) {
    FT_Set_Pixel_Sizes(face, 0, font_size);
    cell_h = (int)(face->size->metrics.height >> 6);
    ascent = (int)(face->size->metrics.ascender >> 6);
    if (cell_h < font_size) cell_h = font_size + 3;
    /* Monospace: every advance matches 'M' (fc_load_flags so the cell
     * pitch agrees with the hinted render path, todos/0279). */
    FT_UInt mi = FT_Get_Char_Index(face, 'M');
    cell_w = 0;
    if (!FT_Load_Glyph(face, mi, fc_load_flags(face)))
        cell_w = (int)(face->glyph->advance.x >> 6);
    if (cell_w <= 0) cell_w = (font_size * 3) / 5;
}

/* Drop every cached glyph (both tiers) — bitmaps are size-specific. */
static void flush_glyphs(void) {
    for (int i = 0; i < 95; i++) free(g_cache.ascii[i].bmp);
    memset(g_cache.ascii, 0, sizeof g_cache.ascii);
    for (int i = 0; i < g_cache.xn; i++) free(g_cache.xglyphs[i].bmp);
    free(g_cache.xglyphs);
    free(g_cache.xcps);
    g_cache.xglyphs = NULL;
    g_cache.xcps = NULL;
    g_cache.xn = g_cache.xcap = 0;
}

/* Live font-size change: new metrics, fresh glyph caches (the fallback
 * chain re-probes at the new px on demand), and a window re-size to the
 * SAME cols x rows grid at the new cell — macOS Terminal keeps the grid
 * and grows the window. SDL_SetWindowSize renegotiates the surface
 * (0019); the existing RESIZED handler re-derives it and reflows — to
 * identical cols/rows by construction. History stores CELLS, so
 * scrollback re-renders at the new size for free. */
static void apply_font_size(int n) {
    n = tc_clamp(n, TC_FONT_MIN, TC_FONT_MAX);
    if (n == font_size) return;
    font_size = n;
    set_metrics();
    flush_glyphs();
    for (uint32_t ch = 32; ch < 127; ch++)
        term_render(NULL, &g_cache.ascii[ch - 32], ch);
    if (win) SDL_SetWindowSize(win, cols * cell_w, GRID_Y + rows * cell_h);
    dirty = 1;
}

/* ---- the settings window ----
 * Shell > Settings…: a fixed-size top-level window (kernel chrome gives
 * move/close; not RESIZABLE, so it can't be sheared) hand-drawn in the
 * SAME __gdi_dc_wrap + gdi32 idiom as the 0273c bar strip — term links
 * the engine's raster already; user32's control tree would put a second
 * event model in the process (the 0273b scrollbar call, one level up —
 * design log logs/2026-07-23/term-settings-0273d.md). macOS Terminal is
 * the structural reference: five rows, every change applies IMMEDIATELY
 * and delta-writes its ONE key to ~/.config/term — no OK/Cancel row.
 * Numeric rows step (- / +), enum rows cycle (< / >); Esc or the close
 * box dismisses. Pointer-driven by scope (like the reference's pane);
 * keys on its windowID never reach the pty. */
#define SET_W      300
#define SET_ROW_H  34
#define SET_TOP    12
#define SET_H      (SET_TOP + 5 * SET_ROW_H + 10)
#define SET_LBL_X  12
#define SET_VAL_X  120
#define SET_VAL_W  112
#define SET_BTN1_X 244
#define SET_BTN2_X 270
#define SET_BTN_W  22
#define SET_BOX_H  22

static SDL_Window *set_win;

static const char *const SET_LABELS[5] =
    { "Font Size", "Theme", "Scrollback", "Cursor", "Bell" };

static void set_row_value(int row, char *out, size_t sz) {
    switch (row) {
    case 0: snprintf(out, sz, "%d px", font_size); break;
    case 1: snprintf(out, sz, "%s", THEMES[theme_idx].name); break;
    case 2: snprintf(out, sz, "%d lines", sb_max); break;
    case 3: snprintf(out, sz, "%s", CURSOR_NAMES[cursor_style]); break;
    case 4: snprintf(out, sz, "%s", BELL_NAMES[bell_mode]); break;
    }
}

/* A 1px BTNSHADOW frame around a filled box (the pane's only border
 * furniture). */
static void set_box(HDC dc, int x0, int y0, int x1, int y1, HBRUSH fill) {
    RECT r;
    SetRect(&r, x0, y0, x1, y1);
    FillRect(dc, &r, GetSysColorBrush(COLOR_BTNSHADOW));
    SetRect(&r, x0 + 1, y0 + 1, x1 - 1, y1 - 1);
    FillRect(dc, &r, fill);
}

static void settings_paint(void) {
    if (!set_win) return;
    SDL_Surface *s = SDL_GetWindowSurface(set_win);
    if (!s) return;
    HDC dc = __gdi_dc_wrap(s->pixels, s->w, s->h, s->pitch / 4);
    if (!dc) return;
    RECT r;
    SetRect(&r, 0, 0, s->w, s->h);
    FillRect(dc, &r, GetSysColorBrush(COLOR_BTNFACE));
    SetBkMode(dc, TRANSPARENT);
    char val[40];
    for (int i = 0; i < 5; i++) {
        int y = SET_TOP + i * SET_ROW_H;
        SetTextColor(dc, GetSysColor(COLOR_BTNTEXT));
        TextOut(dc, SET_LBL_X, y + 3, SET_LABELS[i],
                (int)strlen(SET_LABELS[i]));
        /* Value box; the theme row previews its own fg-on-bg pair. */
        if (i == 1) {
            HBRUSH tb = CreateSolidBrush(RGB(THEMES[theme_idx].bg[0],
                                             THEMES[theme_idx].bg[1],
                                             THEMES[theme_idx].bg[2]));
            set_box(dc, SET_VAL_X, y, SET_VAL_X + SET_VAL_W, y + SET_BOX_H, tb);
            DeleteObject(tb);
            SetTextColor(dc, RGB(THEMES[theme_idx].fg[0],
                                 THEMES[theme_idx].fg[1],
                                 THEMES[theme_idx].fg[2]));
        } else {
            set_box(dc, SET_VAL_X, y, SET_VAL_X + SET_VAL_W, y + SET_BOX_H,
                    GetSysColorBrush(COLOR_WINDOW));
            SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
        }
        set_row_value(i, val, sizeof val);
        TextOut(dc, SET_VAL_X + 6, y + 3, val, (int)strlen(val));
        /* Stepper (- +) on numeric rows, cycler (< >) on enum rows. */
        SetTextColor(dc, GetSysColor(COLOR_BTNTEXT));
        int num = i == 0 || i == 2;
        set_box(dc, SET_BTN1_X, y, SET_BTN1_X + SET_BTN_W, y + SET_BOX_H,
                GetSysColorBrush(COLOR_BTNFACE));
        TextOut(dc, SET_BTN1_X + 7, y + 3, num ? "-" : "<", 1);
        set_box(dc, SET_BTN2_X, y, SET_BTN2_X + SET_BTN_W, y + SET_BOX_H,
                GetSysColorBrush(COLOR_BTNFACE));
        TextOut(dc, SET_BTN2_X + 7, y + 3, num ? "+" : ">", 1);
    }
    __gdi_dc_unwrap(dc);
    SDL_UpdateWindowSurface(set_win);
}

static void settings_open(void) {
    if (set_win) { settings_paint(); return; }     /* one pane, no dupes */
    set_win = SDL_CreateWindow("Term Settings", SET_W, SET_H, 0);
    if (!set_win) {
        fprintf(stderr, "term: settings window failed: %s\n", SDL_GetError());
        return;
    }
    settings_paint();
}

static void settings_close(void) {
    if (!set_win) return;
    SDL_DestroyWindow(set_win);
    set_win = NULL;
}

static void set_persist(const char *key, const char *value) {
    if (cfg_set("term", key, value) != 0)
        fprintf(stderr, "term: settings write (%s): %s\n", key,
                strerror(errno));
}

/* One click on row `row`'s left (-1) / right (+1) button: apply LIVE,
 * then delta-write exactly that key to the user layer (the admin/baked
 * layers keep serving every other key — CS3). */
static void settings_adjust(int row, int dir) {
    char val[40];
    switch (row) {
    case 0:
        apply_font_size(font_size + dir);
        snprintf(val, sizeof val, "%d", font_size);
        set_persist("fontsize", val);
        break;
    case 1:
        theme_apply((theme_idx + dir + N_THEMES) % N_THEMES);
        set_persist("theme", THEMES[theme_idx].name);
        break;
    case 2:
        sb_set_max(tc_clamp(sb_max + dir * TC_SB_STEP, 0, TC_SB_CAP));
        snprintf(val, sizeof val, "%d", sb_max);
        set_persist("scrollback", val);
        break;
    case 3:
        cursor_style = (cursor_style + dir + 3) % 3;
        dirty = 1;
        set_persist("cursor", CURSOR_NAMES[cursor_style]);
        break;
    case 4:
        bell_mode = (bell_mode + dir + 3) % 3;
        set_persist("bell", BELL_NAMES[bell_mode]);
        break;
    default:
        return;
    }
    settings_paint();
}

static void settings_mouse(int x, int y) {
    if (y < SET_TOP) return;
    int row = (y - SET_TOP) / SET_ROW_H;
    if (row > 4 || (y - SET_TOP) % SET_ROW_H >= SET_BOX_H) return;
    if (x >= SET_BTN1_X && x < SET_BTN1_X + SET_BTN_W)
        settings_adjust(row, -1);
    else if (x >= SET_BTN2_X && x < SET_BTN2_X + SET_BTN_W)
        settings_adjust(row, +1);
}

/* Settings-window event demux (after the menu layer in frame_cb):
 * everything on its windowID is the pane's — keys there never reach the
 * pty, Esc and the close box dismiss. */
static int settings_event(const SDL_Event *e) {
    if (!set_win) return 0;
    Uint32 sid = SDL_GetWindowID(set_win);
    switch (e->type) {
    case SDL_EVENT_KEY_DOWN:
        if (e->key.windowID != sid) return 0;
        if ((int)e->key.key == SDLK_ESCAPE) settings_close();
        return 1;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        if (e->button.windowID != sid) return 0;
        if (e->button.button == 1)
            settings_mouse((int)e->button.x, (int)e->button.y);
        return 1;
    case SDL_EVENT_MOUSE_BUTTON_UP:
        return e->button.windowID == sid;
    case SDL_EVENT_MOUSE_MOTION:
        return e->motion.windowID == sid;
    case SDL_EVENT_MOUSE_WHEEL:
        return e->wheel.windowID == sid;
    case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
        if (e->window.windowID != sid) return 0;
        settings_close();
        return 1;
    default:
        return 0;
    }
}

/* ---- live config reload (FS_WATCH consumer #3, after mgp and fileman)
 * ---- a settings change in ANY term (or a hand edit of ~/.config/term)
 * reaches every open one: cfg_set's tmp+rename lands as a same-dir
 * RENAME record naming `term` under a ~/.config dir watch (a dir watch
 * survives the file not existing yet — __fs_watch is ENOENT on a missing
 * path, and a fresh HOME has no user file). Applies through the same
 * idempotent paths the settings window uses, so our own writes reload as
 * no-ops. */
static int cfgwatch_fd = -1;

static void cfg_apply(const TermCfg *c) {
    apply_font_size(c->fontsize);
    if (c->theme != theme_idx) theme_apply(c->theme);
    sb_set_max(c->scrollback);
    if (c->cursor != cursor_style) { cursor_style = c->cursor; dirty = 1; }
    bell_mode = c->bell;
    autoscroll_on = c->autoscroll;
    if (set_win) settings_paint();     /* the pane mirrors the store */
}

static void cfgwatch_arm(void) {
    char dir[300];
    snprintf(dir, sizeof dir, "%s/.config", cfg_home());
    mkdir(dir, 0755);                  /* EEXIST fine; the watch path must
                                          exist at creation */
    cfgwatch_fd = __fs_watch(dir, 0, 0);   /* settled mask */
    if (cfgwatch_fd < 0)
        fprintf(stderr, "term: config watch on %s failed: %s — "
                "cross-process settings sync off\n", dir, strerror(errno));
}

/* Drain the watch fd (never blocks: EAGAIN when dry) and reload once if
 * any settled event names `term` — RENAME carries "old\0new\0", so check
 * both — or the queue overflowed (rescan is the reload). */
static void cfgwatch_drain(void) {
    if (cfgwatch_fd < 0) return;
    char buf[512];
    int hit = 0;
    for (;;) {
        ssize_t n = read(cfgwatch_fd, buf, sizeof buf);
        if (n <= 0) break;
        for (ssize_t off = 0; off + 4 <= n; ) {
            const struct fsw_event *ev = (const struct fsw_event *)(buf + off);
            if (ev->len < 4 || off + ev->len > n) break;
            const char *name = ev->name;
            if (ev->type == FSW_OVERFLOW || strcmp(name, "term") == 0)
                hit = 1;
            else if (ev->type == FSW_RENAME) {
                const char *second = name + strlen(name) + 1;
                if (second < buf + off + ev->len &&
                    strcmp(second, "term") == 0)
                    hit = 1;
            }
            off += ev->len;
        }
    }
    if (hit) {
        TermCfg c;
        tc_load(&c);
        cfg_apply(&c);
    }
}

/* ============================================================ render */

static uint32_t pack(const uint8_t *rgb) {
    return (uint32_t)rgb[0] | ((uint32_t)rgb[1] << 8) | ((uint32_t)rgb[2] << 16) | 0xFF000000u;
}

/* Resolve a cell's effective fg/bg as packed pixels (bold brighten, dim
 * halve, reverse, selection, cursor inversion — the pre-Phase-D inline
 * logic, shared by both render passes). Dim (SGR 2) halves the resolved
 * fg RGB BEFORE the swaps — the xterm order, so a reversed dim cell
 * carries its faint color into the background patch. live_r is the cell's
 * LIVE grid row (or -1 for a history line — no cursor there); virt_r is
 * its VIRTUAL row, the selection's coordinate space (#355) — history and
 * live cells highlight alike, and a scrolled view shows its selection. */
static void cell_colors(const Cell *cell, int live_r, int virt_r, int c,
                        uint32_t *fgo, uint32_t *bgo) {
    int fg = cell->fg, bg = cell->bg;
    if (cell->attr & A_BOLD) { if (fg < 8) fg += 8; }
    uint32_t fgp = pack(PAL[fg]), bgp = pack(PAL[bg]);
    if (cell->attr & A_DIM) fgp = ((fgp >> 1) & 0x007F7F7Fu) | 0xFF000000u;
    if (cell->attr & A_REVERSE) { uint32_t t = fgp; fgp = bgp; bgp = t; }
    if (sel_has(virt_r, c)) { uint32_t t = fgp; fgp = bgp; bgp = t; } /* 0090/#355 */
    /* The block cursor is the classic cell inversion; under/bar draw an
     * overlay strip after the glyph pass instead (todos/0273d). */
    if (cursor_style == CUR_BLOCK && cursor_visible && live_r >= 0 &&
        live_r == cy && c == cx) { uint32_t t = fgp; fgp = bgp; bgp = t; }
    *fgo = fgp;
    *bgo = bgp;
}

/* Source cells for viewport row vr: a history line (sets *live_r = -1) when
 * the row is scrolled up into history, else the live grid row (0273a). The
 * returned run is *slen cells wide (a history line's captured width); the
 * caller pads columns past it with the default background. */
static const Cell *view_row(int vr, int *slen, int *live_r) {
    int virt = hist_count - view_off + vr;   /* view_off <= hist_count, vr >= 0 */
    if (virt < hist_count) {
        HistLine *h = hist_at(virt);
        *slen = h->len; *live_r = -1;
        return h->cells;
    }
    int lr = virt - hist_count;
    *slen = cols; *live_r = lr;
    return &grid[lr * cols];
}

static void render(void) {
    uint32_t *px = (uint32_t *)surf->pixels;
    int sw = surf->w, sh = surf->h;
    Cell pad; pad.cp = ' '; pad.fg = DEF_FG; pad.bg = DEF_BG; pad.attr = 0;
    for (int r = 0; r < rows; r++) {
        int slen, live_r;
        const Cell *src = view_row(r, &slen, &live_r);
        int virt_r = hist_count - view_off + r;    /* selection space (#355) */
        /* Pass 1: every cell's background. Separate from the glyph pass
         * because a wide lead's glyph spills into the continuation cell —
         * a single fused loop would paint the continuation's bg OVER the
         * spill (Phase D). */
        for (int c = 0; c < cols; c++) {
            const Cell *cell = c < slen ? &src[c] : &pad;
            uint32_t fgp, bgp;
            cell_colors(cell, live_r, virt_r, c, &fgp, &bgp);
            int x0 = c * cell_w, y0 = GRID_Y + r * cell_h;
            for (int y = y0; y < y0 + cell_h && y < sh; y++) {
                uint32_t *rowp = &px[y * sw];
                for (int x = x0; x < x0 + cell_w && x < sw; x++) rowp[x] = bgp;
            }
        }
        /* Pass 2: glyphs. */
        for (int c = 0; c < cols; c++) {
            const Cell *cell = c < slen ? &src[c] : &pad;
            uint32_t fgp, bgp;
            cell_colors(cell, live_r, virt_r, c, &fgp, &bgp);
            int x0 = c * cell_w, y0 = GRID_Y + r * cell_h;
            if (cell->cp <= 32) continue;    /* space + defensive C0 +
                                                CP_WIDE_CONT: bg only */
            FcGlyph *g = cp_glyph(cell->cp);
            if (!g->bmp) continue;
            /* A wide lead draws across its own cell AND the continuation
             * cell to its right (Phase D). */
            int clip_w = cell_w * (wcwidth_cp(cell->cp) == 2 ? 2 : 1);
            int gx0 = x0 + g->left;
            int gy0 = y0 + ascent - g->top;
            int fr = fgp & 0xFF, fgg = (fgp >> 8) & 0xFF, fb = (fgp >> 16) & 0xFF;
            int br = bgp & 0xFF, bgg = (bgp >> 8) & 0xFF, bb = (bgp >> 16) & 0xFF;
            for (int gy = 0; gy < g->h; gy++) {
                int dy = gy0 + gy;
                if (dy < y0 || dy >= y0 + cell_h || dy >= sh) continue;
                for (int gx = 0; gx < g->w; gx++) {
                    int dx = gx0 + gx;
                    if (dx < x0 || dx >= x0 + clip_w || dx >= sw) continue;
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
    /* Non-block cursor styles (0273d): a 2px default-fg strip — bottom
     * (under) or left (bar) of the cursor cell, live view only. The
     * block style is the classic cell inversion in cell_colors. */
    if (cursor_style != CUR_BLOCK && cursor_visible && view_off == 0) {
        int x0 = cx * cell_w, y0 = GRID_Y + cy * cell_h;
        uint32_t fgp = pack(PAL[DEF_FG]);
        int xa = x0, xb = x0 + cell_w, ya = y0, yb = y0 + cell_h;
        if (cursor_style == CUR_UNDER) ya = yb - 2;
        else xb = xa + 2;
        for (int y = ya; y < yb && y < sh; y++)
            for (int x = xa; x < xb && x < sw; x++)
                px[y * sw + x] = fgp;
    }
    /* Uncovered right/bottom margins (window not an exact cell multiple)
     * and the top GRID_Y band — the strip child covers the band visually,
     * but the surface pixels under it stay deterministic (0273c). */
    uint32_t defbg = pack(PAL[DEF_BG]);
    for (int y = 0; y < sh; y++) {
        for (int x = cols * cell_w; x < sw; x++) px[y * sw + x] = defbg;
    }
    for (int y = 0; y < GRID_Y && y < sh; y++) {
        for (int x = 0; x < cols * cell_w && x < sw; x++) px[y * sw + x] = defbg;
    }
    for (int y = GRID_Y + rows * cell_h; y < sh; y++) {
        for (int x = 0; x < cols * cell_w; x++) px[y * sw + x] = defbg;
    }
    /* Side scrollbar overlay (0273b): full-height track, proportional
     * thumb, alpha-blended over the content so the tinted last column
     * stays legible. Integer blends — the shm shot stays bit-exact:
     * track 25% toward mid-gray (over black bg -> 32,32,32), thumb 75%
     * toward light gray (-> ~150+, clearly brighter than the track). */
    if (sb_visible() && sh > GRID_Y) {
        /* The bar spans the GRID band only (0273c: the strip child owns
         * the top GRID_Y px); geometry is band-local. */
        int ty, th;
        sb_geom(sh - GRID_Y, &ty, &th);
        int x0 = sw - SB_W;
        if (x0 < 0) x0 = 0;
        for (int y = GRID_Y; y < sh; y++) {
            int thumb = y - GRID_Y >= ty && y - GRID_Y < ty + th;
            for (int x = x0; x < sw; x++) {
                uint32_t p = px[y * sw + x];
                unsigned r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
                if (thumb) {
                    r = (r + 3 * 200) / 4;
                    g = (g + 3 * 200) / 4;
                    b = (b + 3 * 200) / 4;
                } else {
                    r = (3 * r + 128) / 4;
                    g = (3 * g + 128) / 4;
                    b = (3 * b + 128) / 4;
                }
                px[y * sw + x] = (uint32_t)r | ((uint32_t)g << 8) |
                                 ((uint32_t)b << 16) | 0xFF000000u;
            }
        }
    }
    /* Visual bell (0273d): the whole grid band inverted while the flash
     * is on — cleared by the main loop's one-shot 120ms wait timeout. */
    if (flash_on) {
        for (int y = GRID_Y; y < sh; y++)
            for (int x = 0; x < sw; x++)
                px[y * sw + x] = (~px[y * sw + x] & 0x00FFFFFFu) | 0xFF000000u;
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
    /* History survives resize untouched: each HistLine keeps its captured
     * width, render clamps to the new cols — no reflow, no corruption
     * (0273a). view_off stays valid (hist_count is unchanged); clamp anyway. */
    if (view_off > hist_count) view_off = hist_count;
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
        /* Menu layer first (0273c): bar strip + open dropdown chain, and
         * the modal swallow while a chain is open. Then the settings
         * pane's windowID (0273d) — its keys never reach the pty. */
        if (menu_event(&e)) continue;
        if (settings_event(&e)) continue;
        if (e.type == SDL_EVENT_KEY_DOWN) {
            handle_key(&e.key);
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && e.button.button == 1 &&
                   sb_visible() && (int)e.button.x >= surf->w - SB_W &&
                   (int)e.button.y >= GRID_Y) {
            /* Scrollbar press (0273b): thumb -> start a drag; track ->
             * page toward the click (one viewport, like PageUp/Down).
             * Never anchors a selection; with the bar hidden the region
             * falls through to the selection branch below unchanged.
             * Band-local coords (0273c: the strip owns y < GRID_Y). */
            int y = (int)e.button.y - GRID_Y, ty, th;
            sb_geom(surf->h - GRID_Y, &ty, &th);
            if (y >= ty && y < ty + th) { sb_drag = 1; sb_grab = y - ty; }
            else scroll_view(y < ty ? (rows > 1 ? rows - 1 : 1)
                                    : -(rows > 1 ? rows - 1 : 1));
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && e.button.button == 1) {
            /* Left press: clear any selection, anchor a new one (0090).
             * Rows anchor in VIRT space — the content under the pointer,
             * scrolled or not (#355). */
            sel_ax = sel_ex = cell_clamp((int)e.button.x / cell_w, cols);
            sel_ay = sel_ey = hist_count - view_off +
                cell_clamp(((int)e.button.y - GRID_Y) / cell_h, rows);
            sel_drag = 1;
            if (sel_on) { sel_on = 0; dirty = 1; }
        } else if (e.type == SDL_EVENT_MOUSE_MOTION && sb_drag) {
            /* Thumb drag (0273b). Gated on visibility so an alt-screen
             * entry mid-drag (vi launched by the session) can't write
             * view_off under a screen that must stay live. */
            if (sb_visible()) sb_drag_to((int)e.motion.y - GRID_Y,
                                         surf->h - GRID_Y);
        } else if (e.type == SDL_EVENT_MOUSE_MOTION && sel_drag) {
            int c = cell_clamp((int)e.motion.x / cell_w, cols);
            int r = hist_count - view_off +
                cell_clamp(((int)e.motion.y - GRID_Y) / cell_h, rows);
            if (c != sel_ex || r != sel_ey || !sel_on) {
                sel_ex = c;
                sel_ey = r;
                sel_on = c != sel_ax || r != sel_ay ? 1 : sel_on;
                dirty = 1;
            }
        } else if (e.type == SDL_EVENT_MOUSE_BUTTON_UP && e.button.button == 1) {
            sel_drag = 0;
            sb_drag = 0;
        } else if (e.type == SDL_EVENT_MOUSE_WHEEL) {
            /* Wheel scrolls scrollback on the main screen; alt-screen apps
             * own the viewport (no history). wheel.y > 0 = away = up into
             * history, one notch ~ 3 lines (0273a). */
            if (!on_alt) scroll_view((int)e.wheel.y * 3);
        } else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            surf = SDL_GetWindowSurface(win);   /* re-derive (SDL3 contract) */
            if (__mc.open) mc_close();          /* geometry moved under the chain */
            apply_resize(surf->w / cell_w, (surf->h - GRID_Y) / cell_h);
            /* Repaint even when cols x rows are unchanged (a font-size
             * renegotiation, 0273d): the 0019 configure ack rides the
             * first present AT the new size — without it the kernel
             * keeps the old geometry forever. */
            dirty = 1;
            /* A5: the strip width-follows the parent; its repaint rides
             * its own RESIZED ack (menu_event). Same width = same paint. */
            if (bar_win) {
                SDL_Surface *bs = SDL_GetWindowSurface(bar_win);
                if (bs && bs->w != surf->w)
                    SDL_SetWindowSize(bar_win, surf->w, MENU_BAR_H);
            }
        } else if (e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED &&
                   e.window.windowID == SDL_GetWindowID(win)) {
            /* With the bar strip child alive term is a MULTI-window app,
             * so the close box arrives as a per-window close request
             * (todos/0089), never the single-window QUIT. Menu levels'
             * close requests were consumed in menu_event; the main
             * window's ends the session (0273c). */
            exit(0);
        } else if (e.type == SDL_EVENT_QUIT) {
            exit(0);   /* master close HUPs the pty's foreground pgroup */
        }
    }
    /* Reap: the session child's exit ends the session; New Window
     * siblings (0273c) are just collected. */
    pid_t rp;
    int st;
    while ((rp = waitpid(-1, &st, WNOHANG)) > 0)
        if (rp == child) exit(0);                             /* session over */
    /* Live config reload (0273d): a ~/.config event naming `term`. */
    cfgwatch_drain();
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
        /* New output snaps the view back to live (0273a) — unless the
         * thumb is HELD (0273b) or a selection drag is in flight (#355):
         * snapping mid-drag would rip the thumb — or the text being
         * selected — out of the user's hand; the next output after
         * release snaps. `autoscroll off` (#354) suppresses the snap
         * entirely: the view stays where the user scrolled it. */
        if (!sb_drag && !sel_drag && autoscroll_on) view_off = 0;
    }
    /* BELs coalesced per drain pass (0273d): a \a flood rings once per
     * frame, never once per byte. */
    if (bell_pending) {
        bell_pending = 0;
        if (bell_mode == BELL_SOUND) snd_play_event("Bell");
        else if (bell_mode == BELL_VISUAL) { flash_on = 1; dirty = 1; }
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
    int n = fc_load(fc_paths, FC_MAX_FALLBACKS);   /* fallback chain paths;
                                                      faces open lazily */
    fc_chain_init(&g_chain, ft_lib, fc_paths, n, term_fc_fail);
    set_metrics();                     /* at the configured font_size (0273d) */
    for (uint32_t ch = 32; ch < 127; ch++)
        term_render(NULL, &g_cache.ascii[ch - 32], ch);
    return 0;
}

int main(int argc, char **argv) {
    /* Config BEFORE metrics/ring: fontsize feeds load_glyphs, scrollback
     * sizes the ring, the rest assign directly (todos/0273d). */
    TermCfg cfg;
    tc_load(&cfg);
    font_size = cfg.fontsize;
    theme_apply(cfg.theme);
    cursor_style = cfg.cursor;
    bell_mode = cfg.bell;
    autoscroll_on = cfg.autoscroll;
    sb_set_max(cfg.scrollback);

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
    win = SDL_CreateWindow("term", cols * cell_w, GRID_Y + rows * cell_h,
                           SDL_WINDOW_RESIZABLE);
    if (!win) return 3;
    surf = SDL_GetWindowSurface(win);
    /* The menu bar strip child (0273c). Hard require, loud failure — no
     * bar-less tier: term already requires the kernel (openpty above),
     * and under a kernel the anchored-child primitive always exists. */
    menu_build();
    bar_win = SDL_CreatePopupWindow(win, 0, 0, cols * cell_w, MENU_BAR_H,
                                    SDL_WINDOW_TOOLTIP);
    if (!bar_win) {
        fprintf(stderr, "term: menu bar window failed: %s\n", SDL_GetError());
        return 3;
    }
    SDL_SetWindowTitle(bar_win, "menubar");
    bar_paint();
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
    cfgwatch_arm();                    /* live settings reload (0273d) */
    for (;;) {
        frame_cb();
        if (chld_seen) { chld_seen = 0; continue; }   /* claimed mid-frame:
                                                         re-run the waitpid */
        /* Park on {master ⊕ config watch ⊕ ring}; a live visual-bell
         * flash turns the park into its one-shot 120ms clear timer —
         * the only timed wake term ever takes (0273d). */
        int fds[2] = { mfd, cfgwatch_fd };
        __wait(fds, cfgwatch_fd >= 0 ? 2 : 1, 1, flash_on ? 120 : -1);
        if (flash_on) { flash_on = 0; dirty = 1; }
    }
}
