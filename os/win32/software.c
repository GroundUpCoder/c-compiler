/* software.c — the gucOS Software storefront (ticket #81): a graphical
 * front-end over gucman, the package manager. Browse the repository
 * catalog, install/remove with one click, see honest install state.
 *
 * Division of labor (locked): gucman IS the engine — this app never
 * fetches payloads, never touches /opt, never duplicates install logic.
 *   - Catalog: spawn `gucman index` (prints the repo index.json raw) and
 *     parse its output — the one network stack stays in gucman, and a
 *     repo failure surfaces gucman's own stderr verbatim.
 *   - Install state: the install DB /var/lib/gucman/<name>.json —
 *     record-exists == installed (gucman's crash-safe contract); a
 *     package folded into the sealed /usr (os-release PACKAGES=) with
 *     no record renders "Built-in", action button disabled. An
 *     FS_WATCH on the DB dir (RegisterFdWake seam, the fileman 0123
 *     pattern) keeps the view live when a CLI `gucman install` runs
 *     beside the storefront.
 *   - Actions: posix_spawn `/bin/gucman install|remove <name>` with
 *     stdout+stderr captured to a file (user32's fd-wake drain DISCARDS
 *     bytes, and regular-file reads never block — so a WM_TIMER tick
 *     reads the tail for the live status line and waitpid(WNOHANG)s the
 *     child). Exit code + output tail are the outcome — no synthesized
 *     "installed" claims; the post-job state re-reads the real DB.
 *
 * UI: one fixed 640x460 window. White header (title, count subtitle,
 * Refresh), a card list (one "PkgCard" child per package: name+version,
 * summary, colored state, one Install/Remove button), a vertical
 * scrollbar (card-granular — child DCs clamp to the surface, not the
 * list area, so partial cards are never shown), a status-line STATIC
 * fed from gucman's live output. Card window TEXT mirrors
 * "<name> <version> [<state>]", so `wmctl tree` sees the whole catalog
 * and tests wait on real state flips (OS.md agent pillar).
 *
 * One job at a time by design: gucman's DB isn't concurrent-write-safe,
 * so every action button + Refresh disables while a job runs. Closing
 * the window mid-job leaves the gucman child to finish on its own —
 * its install remains crash-safe regardless (the DB-record-last rule).
 * Packages installed but absent from the fetched catalog stay listed
 * (removable); with the repo unreachable the installed set still shows,
 * so uninstall works offline.
 */

#include <windows.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "cJSON.h"
#include "../fswatch.h"

#define GM_DB_DIR  "/var/lib/gucman"
#define GM_DESKTOP_FLAG GM_DB_DIR "/desktop_shortcuts"  /* Q5/#90 toggle, shared with gucman */
#define OS_RELEASE "/usr/share/os-release"

#define WIN_W     640
#define WIN_H     460
#define HEADER_H  76
#define STATUS_H  30
#define CARD_H    88
#define SB_W      16
#define LIST_Y    HEADER_H
#define LIST_H    (WIN_H - HEADER_H - STATUS_H)  /* 354 */
#define VIS_CARDS (LIST_H / CARD_H)              /* 4 full cards */
#define CARD_W    (WIN_W - SB_W)
#define BTN_W     110
#define BTN_H     32
#define BTN_X     (CARD_W - BTN_W - 12)

#define ID_REFRESH 100
#define ID_STATUS  101
#define ID_NOTICE  102
#define ID_SCROLL  103
#define ID_DESKTOP 104                           /* "install to Desktop" toggle (Q5) */
#define ID_ACTION  1                             /* the button inside a card */

#define MSG_FSCHANGE (WM_APP + 1)
#define MSG_ACTION   (WM_APP + 2)                /* wp = package index */
#define TIMER_JOB    1
#define JOB_TICK_MS  150

/* ------------------------------------------------------------- model -- */

/* The parsed catalog (from `gucman index`) — kept across DB refreshes so
 * installed-state changes never need a re-fetch. */
struct cat_ent {
    char name[64];
    char version[32];
    char summary[256];
    char deps[128];                              /* ", "-joined, may be "" */
    long size;                                   /* payload bytes */
    int minBase;                                 /* 0 = ungated */
};
static struct cat_ent *g_cat;
static int g_ncat;
static int g_catValid;                           /* index fetched + parsed */

enum { PS_AVAILABLE, PS_INSTALLED, PS_ORPHAN, PS_NEEDSBASE, PS_BUILTIN };

/* The rendered list: catalog entries + installed-but-not-in-catalog. */
struct pkg {
    const struct cat_ent *cat;                   /* NULL for orphans */
    char name[64];
    char version[32];                            /* catalog or installed */
    char summary[256];
    int state;                                   /* PS_* */
    HWND card, btn;
};
static struct pkg *g_pkgs;
static int g_npkgs, g_pkgcap;

static int g_base = -1;                          /* os-release VERSION_ID */

/* -------------------------------------------------------------- jobs -- */

enum { JOB_NONE, JOB_INDEX, JOB_INSTALL, JOB_REMOVE };
static int g_job = JOB_NONE;
static pid_t g_jobPid = -1;
static char g_jobName[64];                       /* target package */
static int g_jobPkg = -1;                        /* index into g_pkgs, -1 */
static char g_outPath[300], g_errPath[300];
static char g_lastLine[200];                     /* last status line shown */

/* ---------------------------------------------------------------- ui -- */

static HWND g_win, g_status, g_notice, g_scrollbar, g_refresh, g_deskChk;
static char g_subtitle[96];                      /* header count line */
static HFONT g_fTitle, g_fName, g_fSmall;
static HBRUSH g_brWhite, g_brSep;
static int g_scroll;                             /* first visible card */
static int g_wheelAcc;
static int g_watch = -1;

static void model_refresh(void);
static void job_begin(int kind, int pkgIndex);

/* ------------------------------------------------------ small helpers -- */

static char *read_whole(const char *path, size_t *len_out) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;
    size_t cap = 8192, len = 0;
    char *buf = malloc(cap);
    if (!buf) { close(fd); return NULL; }
    for (;;) {
        if (len + 4096 + 1 > cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); close(fd); return NULL; }
            buf = nb;
        }
        ssize_t r = read(fd, buf + len, 4096);
        if (r < 0) { free(buf); close(fd); return NULL; }
        if (r == 0) break;
        len += (size_t)r;
    }
    close(fd);
    buf[len] = 0;
    if (len_out) *len_out = len;
    return buf;
}

/* Last complete non-empty line of a buffer, single-line, truncated. */
static void last_line(const char *buf, char *out, size_t cap) {
    out[0] = 0;
    size_t n = strlen(buf);
    while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) n--;
    if (!n) return;
    size_t s = n;
    while (s && buf[s - 1] != '\n') s--;
    size_t l = n - s;
    if (l > cap - 1) l = cap - 1;
    memcpy(out, buf + s, l);
    out[l] = 0;
}

static void fmt_size(long bytes, char *out, size_t cap) {
    if (bytes >= 1024 * 1024)
        snprintf(out, cap, "%.1f MB", (double)bytes / (1024.0 * 1024.0));
    else
        snprintf(out, cap, "%ld KB", (bytes + 1023) / 1024);
}

static void set_status(const char *s) {
    if (strcmp(s, g_lastLine) == 0) return;
    snprintf(g_lastLine, sizeof g_lastLine, "%s", s);
    SetWindowText(g_status, s);
}

/* Trim `s` (capacity `cap`) in place, with a trailing ellipsis, to fit
 * maxw px. */
static void ellipsize(HDC dc, char *s, size_t cap, int maxw) {
    SIZE sz;
    int n = (int)strlen(s);
    if (!GetTextExtentPoint32(dc, s, n, &sz) || sz.cx <= maxw) return;
    if (n > (int)cap - 4) n = (int)cap - 4;      /* room for "..." + NUL */
    while (n > 1) {
        n--;
        strcpy(s + n, "...");
        if (GetTextExtentPoint32(dc, s, n + 3, &sz) && sz.cx <= maxw) return;
    }
}

/* Fold non-ASCII to ASCII for the one-face renderer (mono.ttf has no
 * typographic-dash glyphs — they'd draw as tofu): UTF-8 en/em dashes
 * become '-', any other multi-byte sequence is dropped. */
static void ascii_fold(char *s) {
    const unsigned char *r = (const unsigned char *)s;
    char *w = s;
    while (*r) {
        if (*r < 0x80) { *w++ = (char)*r++; continue; }
        if (r[0] == 0xe2 && r[1] == 0x80 && (r[2] == 0x93 || r[2] == 0x94)) {
            *w++ = '-';
            r += 3;
            continue;
        }
        r++;
        while ((*r & 0xc0) == 0x80) r++;
    }
    *w = 0;
}

static int os_base_version(void) {
    size_t len;
    char *text = read_whole(OS_RELEASE, &len);
    if (!text) return -1;
    int v = -1;
    char *m = strstr(text, "VERSION_ID=");
    if (m && (m == text || m[-1] == '\n')) v = atoi(m + 11);
    free(text);
    return v;
}

/* PACKAGES= in os-release names the packages folded into the sealed
 * /usr blob (os-common.js foldPackages — the fat-image identity axis).
 * One of these with NO install-DB record is BUILT-IN: present under
 * /usr/opt by construction, not installable or removable; a DB record
 * on top (installed over the base twin) keeps plain installed
 * semantics. Comma-separated, one line; absent on a minimal image.
 * Loaded once at startup — /usr is sealed, the line cannot change. */
static char *g_baked;

static void baked_load(void) {
    size_t len;
    char *text = read_whole(OS_RELEASE, &len);
    if (!text) return;
    char *m = strstr(text, "PACKAGES=");
    if (m && (m == text || m[-1] == '\n')) {
        char *e = strchr(m + 9, '\n');
        size_t n = e ? (size_t)(e - (m + 9)) : strlen(m + 9);
        g_baked = malloc(n + 1);
        if (g_baked) { memcpy(g_baked, m + 9, n); g_baked[n] = 0; }
    }
    free(text);
}

static int is_baked(const char *name) {
    const char *p = g_baked;
    size_t nl = strlen(name);
    while (p && *p) {
        const char *c = strchr(p, ',');
        size_t l = c ? (size_t)(c - p) : strlen(p);
        if (l == nl && strncmp(p, name, nl) == 0) return 1;
        p = c ? c + 1 : p + l;
    }
    return 0;
}

/* ------------------------------------------ install-to-Desktop toggle -- */

/* The persistent Q5/#90 flag, shared with gucman (the engine reads it on
 * every install). ON iff the first line is exactly "on"; absent = OFF. */
static int desk_flag_read(void) {
    size_t len;
    char *t = read_whole(GM_DESKTOP_FLAG, &len);
    if (!t) return 0;
    char *nl = strchr(t, '\n');
    if (nl) *nl = 0;
    int on = strcmp(t, "on") == 0;
    free(t);
    return on;
}

/* Atomic one-line write (tmp + rename) so a concurrent gucman read never
 * sees a torn value. Best-effort: a failure just leaves the setting as-is. */
static void desk_flag_write(int on) {
    char tmp[320];
    snprintf(tmp, sizeof tmp, "%s.tmp", GM_DESKTOP_FLAG);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    const char *s = on ? "on\n" : "off\n";
    if (write(fd, s, strlen(s)) < 0) { close(fd); unlink(tmp); return; }
    if (close(fd) != 0) { unlink(tmp); return; }
    rename(tmp, GM_DESKTOP_FLAG);
}

/* ------------------------------------------------------- install DB --- */

/* Is `name` installed? Fills version/summary from its DB record. */
static int db_lookup(const char *name, char *ver, size_t vcap,
                     char *sum, size_t scap) {
    char p[300];
    snprintf(p, sizeof p, GM_DB_DIR "/%s.json", name);
    size_t len;
    char *text = read_whole(p, &len);
    if (!text) return 0;
    cJSON *db = cJSON_Parse(text);
    free(text);
    if (ver && vcap) ver[0] = 0;
    if (sum && scap) sum[0] = 0;
    if (db) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(db, "version");
        cJSON *s = cJSON_GetObjectItemCaseSensitive(db, "summary");
        if (ver && cJSON_IsString(v)) snprintf(ver, vcap, "%s", v->valuestring);
        if (sum && cJSON_IsString(s)) snprintf(sum, scap, "%s", s->valuestring);
        cJSON_Delete(db);
    }
    return 1;                                    /* record exists == installed */
}

/* --------------------------------------------------------- the model --- */

static int cat_cmp(const void *a, const void *b) {
    return strcmp(((const struct cat_ent *)a)->name,
                  ((const struct cat_ent *)b)->name);
}

/* Parse `gucman index` output into g_cat. Returns 0 ok. */
static int catalog_parse(const char *text) {
    cJSON *idx = cJSON_Parse(text);
    if (!idx) return -1;
    cJSON *pkgs = cJSON_GetObjectItemCaseSensitive(idx, "packages");
    if (!pkgs || !cJSON_IsObject(pkgs)) { cJSON_Delete(idx); return -1; }
    int n = 0;
    cJSON *e;
    cJSON_ArrayForEach(e, pkgs) n++;
    struct cat_ent *cat = calloc(n ? n : 1, sizeof *cat);
    if (!cat) { cJSON_Delete(idx); return -1; }
    int i = 0;
    cJSON_ArrayForEach(e, pkgs) {
        struct cat_ent *c = &cat[i];
        snprintf(c->name, sizeof c->name, "%s", e->string);
        cJSON *v = cJSON_GetObjectItemCaseSensitive(e, "version");
        cJSON *s = cJSON_GetObjectItemCaseSensitive(e, "summary");
        cJSON *mb = cJSON_GetObjectItemCaseSensitive(e, "minBase");
        cJSON *pay = cJSON_GetObjectItemCaseSensitive(e, "payload");
        cJSON *sz = pay ? cJSON_GetObjectItemCaseSensitive(pay, "size") : NULL;
        if (cJSON_IsString(v)) snprintf(c->version, sizeof c->version, "%s", v->valuestring);
        if (cJSON_IsString(s)) snprintf(c->summary, sizeof c->summary, "%s", s->valuestring);
        if (cJSON_IsNumber(mb)) c->minBase = (int)mb->valuedouble;
        if (cJSON_IsNumber(sz)) c->size = (long)sz->valuedouble;
        cJSON *deps = cJSON_GetObjectItemCaseSensitive(e, "deps");
        cJSON *d;
        size_t o = 0;
        cJSON_ArrayForEach(d, deps) {
            if (!cJSON_IsString(d)) continue;
            o += (size_t)snprintf(c->deps + o, sizeof c->deps - o, "%s%s",
                                  o ? ", " : "", d->valuestring);
            if (o >= sizeof c->deps - 1) break;
        }
        i++;
    }
    cJSON_Delete(idx);
    qsort(cat, (size_t)i, sizeof *cat, cat_cmp);
    free(g_cat);
    g_cat = cat;
    g_ncat = i;
    g_catValid = 1;
    return 0;
}

static struct pkg *pkg_add(void) {
    if (g_npkgs == g_pkgcap) {
        g_pkgcap = g_pkgcap ? g_pkgcap * 2 : 16;
        g_pkgs = realloc(g_pkgs, (size_t)g_pkgcap * sizeof *g_pkgs);
    }
    struct pkg *p = &g_pkgs[g_npkgs++];
    memset(p, 0, sizeof *p);
    return p;
}

static const char *state_token(const struct pkg *p, int i) {
    if (i == g_jobPkg)
        return g_job == JOB_REMOVE ? "removing" : "installing";
    switch (p->state) {
    case PS_INSTALLED: return "installed";
    case PS_ORPHAN:    return "installed, not in catalog";
    case PS_NEEDSBASE: return "needs newer OS";
    case PS_BUILTIN:   return "built-in";
    default:           return "available";
    }
}

static void card_sync(int i);
static void layout_cards(void);

/* Rebuild g_pkgs from the parsed catalog + a fresh DB scan, then rebuild
 * the card windows. Called at startup, after every job, and on FS_WATCH
 * pings from external gucman runs. */
static void model_refresh(void) {
    for (int i = 0; i < g_npkgs; i++)
        if (g_pkgs[i].card) DestroyWindow(g_pkgs[i].card);
    g_npkgs = 0;

    int installed = 0;
    for (int i = 0; i < g_ncat; i++) {
        struct pkg *p = pkg_add();
        p->cat = &g_cat[i];
        snprintf(p->name, sizeof p->name, "%s", g_cat[i].name);
        char iver[32];
        if (db_lookup(p->name, iver, sizeof iver, NULL, 0)) {
            p->state = PS_INSTALLED;
            installed++;
            snprintf(p->version, sizeof p->version, "%s",
                     iver[0] ? iver : g_cat[i].version);
        } else if (is_baked(p->name)) {
            /* folded into the sealed /usr, no DB record: built-in wins
             * over the minBase gate (it's already part of this OS) */
            p->state = PS_BUILTIN;
            installed++;
            snprintf(p->version, sizeof p->version, "%s", g_cat[i].version);
        } else {
            p->state = (g_cat[i].minBase > 0 && g_base >= 0 &&
                        g_base < g_cat[i].minBase) ? PS_NEEDSBASE : PS_AVAILABLE;
            snprintf(p->version, sizeof p->version, "%s", g_cat[i].version);
        }
        snprintf(p->summary, sizeof p->summary, "%s", g_cat[i].summary);
        ascii_fold(p->summary);
    }

    /* installed packages the catalog doesn't know (repo changed, or the
     * catalog is unreachable) stay listed and removable */
    DIR *d = opendir(GM_DB_DIR);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d))) {
            size_t l = strlen(de->d_name);
            if (l <= 5 || strcmp(de->d_name + l - 5, ".json") != 0) continue;
            char name[64];
            if (l - 5 >= sizeof name) continue;
            memcpy(name, de->d_name, l - 5);
            name[l - 5] = 0;
            int known = 0;
            for (int i = 0; i < g_ncat && !known; i++)
                known = strcmp(g_cat[i].name, name) == 0;
            if (known) continue;
            struct pkg *p = pkg_add();
            snprintf(p->name, sizeof p->name, "%s", name);
            db_lookup(name, p->version, sizeof p->version,
                      p->summary, sizeof p->summary);
            ascii_fold(p->summary);
            /* with no catalog at all, "not in catalog" would be noise */
            p->state = g_catValid ? PS_ORPHAN : PS_INSTALLED;
            installed++;
        }
        closedir(d);
    }

    /* baked packages the catalog doesn't carry (repo changed, or the
     * catalog is unreachable): present under the sealed /usr regardless,
     * so they stay listed — the orphan rule, built-in flavored */
    for (const char *bp = g_baked; bp && *bp; ) {
        const char *c = strchr(bp, ',');
        size_t l = c ? (size_t)(c - bp) : strlen(bp);
        char name[64];
        if (l && l < sizeof name) {
            memcpy(name, bp, l);
            name[l] = 0;
            int known = 0;
            for (int i = 0; i < g_ncat && !known; i++)
                known = strcmp(g_cat[i].name, name) == 0;
            if (!known && !db_lookup(name, NULL, 0, NULL, 0)) {
                struct pkg *p = pkg_add();
                snprintf(p->name, sizeof p->name, "%s", name);
                p->state = PS_BUILTIN;           /* version unknown offline */
                installed++;
            }
        }
        bp = c ? c + 1 : bp + l;
    }

    /* header subtitle + empty-list notice */
    if (g_catValid)
        snprintf(g_subtitle, sizeof g_subtitle, "%d application%s - %d installed",
                 g_npkgs, g_npkgs == 1 ? "" : "s", installed);
    else if (g_npkgs)
        snprintf(g_subtitle, sizeof g_subtitle,
                 "catalog unavailable - %d installed", installed);
    else
        g_subtitle[0] = 0;                       /* the notice carries it */

    if (g_npkgs == 0) {
        SetWindowText(g_notice, g_catValid ? "No packages available"
                                           : "Cannot reach the package repository");
        ShowWindow(g_notice, SW_SHOW);
    } else {
        ShowWindow(g_notice, SW_HIDE);
    }

    /* card windows (hidden; layout() places + shows the viewport) */
    for (int i = 0; i < g_npkgs; i++) {
        struct pkg *p = &g_pkgs[i];
        p->card = CreateWindowEx(0, "PkgCard", "", WS_CHILD,
                                 0, LIST_Y, CARD_W, CARD_H,
                                 g_win, (HMENU)(INT_PTR)(1000 + i), NULL, NULL);
        p->btn = CreateWindowEx(0, "BUTTON", "", WS_CHILD | WS_VISIBLE,
                                BTN_X, (CARD_H - BTN_H) / 2, BTN_W, BTN_H,
                                p->card, (HMENU)ID_ACTION, NULL, NULL);
        card_sync(i);
    }

    int maxs = g_npkgs - VIS_CARDS;
    if (maxs < 0) maxs = 0;
    if (g_scroll > maxs) g_scroll = maxs;
    if (g_npkgs > VIS_CARDS) {
        SetScrollRange(g_scrollbar, SB_CTL, 0, maxs, FALSE);
        SetScrollPos(g_scrollbar, SB_CTL, g_scroll, TRUE);
        ShowWindow(g_scrollbar, SW_SHOW);
    } else {
        ShowWindow(g_scrollbar, SW_HIDE);
    }
    layout_cards();                              /* place + show the viewport */
    InvalidateRect(g_win, NULL, TRUE);
}

/* Sync one card's agent text, button label/enable, and repaint. */
static void card_sync(int i) {
    struct pkg *p = &g_pkgs[i];
    char text[128];
    snprintf(text, sizeof text, "%s %s [%s]", p->name, p->version,
             state_token(p, i));
    SetWindowText(p->card, text);
    int inst = p->state == PS_INSTALLED || p->state == PS_ORPHAN;
    SetWindowText(p->btn, inst ? "Remove" : "Install");
    /* built-in: sealed /usr/opt — neither installable nor removable */
    EnableWindow(p->btn, g_job == JOB_NONE && p->state != PS_NEEDSBASE &&
                         p->state != PS_BUILTIN);
    InvalidateRect(p->card, NULL, TRUE);
}

static void layout_cards(void) {
    for (int i = 0; i < g_npkgs; i++) {
        struct pkg *p = &g_pkgs[i];
        int vis = i >= g_scroll && i < g_scroll + VIS_CARDS;
        MoveWindow(p->card, 0, LIST_Y + (i - g_scroll) * CARD_H,
                   CARD_W, CARD_H, TRUE);
        ShowWindow(p->card, vis ? SW_SHOW : SW_HIDE);
    }
}

static void set_scroll(int v) {
    int maxs = g_npkgs - VIS_CARDS;
    if (maxs < 0) maxs = 0;
    if (v < 0) v = 0;
    if (v > maxs) v = maxs;
    if (v == g_scroll) return;
    g_scroll = v;
    SetScrollPos(g_scrollbar, SB_CTL, v, TRUE);
    layout_cards();
}

/* -------------------------------------------------------- job engine --- */

static void buttons_enable(void) {
    EnableWindow(g_refresh, g_job == JOB_NONE);
    for (int i = 0; i < g_npkgs; i++) card_sync(i);
}

static int job_spawn(const char *verb, const char *name) {
    int out = open(g_outPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) return -1;
    /* `index` splits stderr so JSON stdout stays parseable; actions
     * interleave both into one stream for the live ticker */
    int err = out;
    if (!name) {
        err = open(g_errPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (err < 0) { close(out); return -1; }
    }
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, out, 1);
    posix_spawn_file_actions_adddup2(&fa, err, 2);
    char *argv[4];
    argv[0] = "gucman";
    argv[1] = (char *)verb;
    argv[2] = (char *)name;                      /* NULL-terminates for index */
    argv[3] = NULL;
    int e = posix_spawn(&g_jobPid, "/bin/gucman", &fa, NULL, argv, NULL);
    posix_spawn_file_actions_destroy(&fa);
    close(out);
    if (err != out) close(err);
    if (e != 0) { g_jobPid = -1; errno = e; return -1; }
    return 0;
}

static void job_begin(int kind, int pkgIndex) {
    if (g_job != JOB_NONE) return;
    const char *verb = kind == JOB_INDEX ? "index"
                     : kind == JOB_INSTALL ? "install" : "remove";
    const char *name = pkgIndex >= 0 ? g_pkgs[pkgIndex].name : NULL;
    g_job = kind;
    g_jobPkg = pkgIndex;
    snprintf(g_jobName, sizeof g_jobName, "%s", name ? name : "");
    if (job_spawn(verb, name) != 0) {
        char msg[160];
        snprintf(msg, sizeof msg, "Cannot run gucman:\n%s", strerror(errno));
        g_job = JOB_NONE;
        g_jobPkg = -1;
        MessageBox(g_win, msg, "Software", MB_OK | MB_ICONEXCLAMATION);
        return;
    }
    if (kind == JOB_INDEX)
        set_status("Loading the package catalog...");
    else {
        char s[96];
        snprintf(s, sizeof s, "%s %s...",
                 kind == JOB_INSTALL ? "Installing" : "Removing", name);
        set_status(s);
    }
    buttons_enable();                            /* all off while running */
    SetTimer(g_win, TIMER_JOB, JOB_TICK_MS, NULL);
}

static void job_end(int st) {
    KillTimer(g_win, TIMER_JOB);
    int kind = g_job, pkg = g_jobPkg;
    char name[64];
    snprintf(name, sizeof name, "%s", g_jobName);
    g_job = JOB_NONE;
    g_jobPkg = -1;
    int ok = WIFEXITED(st) && WEXITSTATUS(st) == 0;

    if (kind == JOB_INDEX) {
        size_t len;
        char *out = ok ? read_whole(g_outPath, &len) : NULL;
        if (out && catalog_parse(out) == 0) {
            set_status("Ready");
        } else {
            /* honest failure: gucman's own last stderr line */
            g_catValid = 0;
            free(g_cat);
            g_cat = NULL;
            g_ncat = 0;
            size_t elen;
            char *etext = read_whole(g_errPath, &elen);
            char line[200] = "";
            if (etext) last_line(etext, line, sizeof line);
            if (!line[0]) snprintf(line, sizeof line,
                                   out ? "gucman: index.json is not valid JSON"
                                       : "gucman index failed");
            set_status(line);
            free(etext);
        }
        free(out);
        model_refresh();
        buttons_enable();
        return;
    }

    /* install/remove: reality is the DB — re-read it either way */
    size_t len;
    char *out = read_whole(g_outPath, &len);
    char line[200] = "";
    if (out) last_line(out, line, sizeof line);
    model_refresh();
    buttons_enable();
    if (ok) {
        set_status(line[0] ? line : "Done");
    } else {
        set_status(line[0] ? line : "gucman failed");
        /* the real output tail, not a synthesized message */
        char msg[720];
        const char *tail = out ? out : "";
        size_t tl = strlen(tail);
        if (tl > 560) tail += tl - 560;
        snprintf(msg, sizeof msg, "%s '%s' failed:\n\n%s",
                 kind == JOB_INSTALL ? "Installing" : "Removing", name, tail);
        MessageBox(g_win, msg, "Software", MB_OK | MB_ICONEXCLAMATION);
    }
    free(out);
}

static void job_tick(void) {
    if (g_job == JOB_NONE) return;
    /* live ticker: the capture file's last complete line (index keeps its
     * stdout JSON out of the ticker — read its stderr file instead) */
    size_t len;
    char *out = read_whole(g_job == JOB_INDEX ? g_errPath : g_outPath, &len);
    if (out) {
        char line[200];
        last_line(out, line, sizeof line);
        if (line[0]) set_status(line);
        free(out);
    }
    int st = 0;
    pid_t r = waitpid(g_jobPid, &st, WNOHANG);
    if (r == g_jobPid || (r < 0 && errno == ECHILD)) {
        g_jobPid = -1;
        job_end(r < 0 ? 0x7f00 : st);            /* lost child = failure */
    }
}

/* ------------------------------------------------------------- cards --- */

static int card_index(HWND h) {
    for (int i = 0; i < g_npkgs; i++)
        if (g_pkgs[i].card == h) return i;
    return -1;
}

static LRESULT CALLBACK card_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        int i = card_index(h);
        if (i >= 0) {
            struct pkg *p = &g_pkgs[i];
            SetBkMode(dc, TRANSPARENT);
            /* line 1: name, then version in gray */
            SelectObject(dc, g_fName);
            SetTextColor(dc, RGB(24, 24, 28));
            TextOut(dc, 14, 10, p->name, (int)strlen(p->name));
            SIZE sz;
            GetTextExtentPoint32(dc, p->name, (int)strlen(p->name), &sz);
            SelectObject(dc, g_fSmall);
            SetTextColor(dc, RGB(118, 118, 124));
            if (p->version[0])
                TextOut(dc, 14 + sz.cx + 8, 14, p->version,
                        (int)strlen(p->version));
            /* state, right-aligned left of the button */
            char st[64];
            COLORREF stc = RGB(118, 118, 124);
            if (i == g_jobPkg) {
                snprintf(st, sizeof st, "%s...",
                         g_job == JOB_REMOVE ? "Removing" : "Installing");
                stc = RGB(0, 64, 160);
            } else if (p->state == PS_INSTALLED) {
                snprintf(st, sizeof st, "Installed");
                stc = RGB(0, 128, 48);
            } else if (p->state == PS_ORPHAN) {
                snprintf(st, sizeof st, "Installed (not in catalog)");
                stc = RGB(0, 128, 48);
            } else if (p->state == PS_BUILTIN) {
                snprintf(st, sizeof st, "Built-in");
                stc = RGB(0, 128, 48);
            } else if (p->state == PS_NEEDSBASE) {
                snprintf(st, sizeof st, "Needs OS v%d",
                         p->cat ? p->cat->minBase : 0);
                stc = RGB(192, 96, 0);
            } else if (p->cat && p->cat->size > 0) {
                fmt_size(p->cat->size, st, sizeof st);
            } else {
                st[0] = 0;
            }
            if (st[0]) {
                GetTextExtentPoint32(dc, st, (int)strlen(st), &sz);
                SetTextColor(dc, stc);
                TextOut(dc, BTN_X - 10 - sz.cx, 14, st, (int)strlen(st));
            }
            /* line 2: summary (+ deps), ellipsized, gray */
            char sum[320];
            if (p->cat && p->cat->deps[0])
                snprintf(sum, sizeof sum, "%s - requires %s",
                         p->summary, p->cat->deps);
            else
                snprintf(sum, sizeof sum, "%s", p->summary);
            ellipsize(dc, sum, sizeof sum, BTN_X - 14 - 10);
            SetTextColor(dc, RGB(96, 96, 104));
            TextOut(dc, 14, 50, sum, (int)strlen(sum));
        }
        /* hairline separator at the card's foot */
        RECT r;
        SetRect(&r, 0, CARD_H - 1, CARD_W, CARD_H);
        FillRect(dc, &r, g_brSep);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_SETTEXT: {
        LRESULT r = DefWindowProc(h, msg, wp, lp);
        InvalidateRect(h, NULL, TRUE);
        return r;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_ACTION) {
            int i = card_index(h);
            if (i >= 0) PostMessage(g_win, MSG_ACTION, (WPARAM)i, 0);
        }
        return 0;
    case WM_MOUSEWHEEL:                          /* scroll rides through */
        return SendMessage(g_win, msg, wp, lp);
    }
    return DefWindowProc(h, msg, wp, lp);
}

/* -------------------------------------------------------- main window --- */

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        g_refresh = CreateWindowEx(0, "BUTTON", "Refresh",
                                   WS_CHILD | WS_VISIBLE,
                                   WIN_W - 126, 20, 110, BTN_H, h,
                                   (HMENU)ID_REFRESH, NULL, NULL);
        /* Q5/#90: header toggle, left of Refresh, above the subtitle line.
         * BS_AUTOCHECKBOX flips itself; we mirror it to the shared flag. */
        g_deskChk = CreateWindowEx(0, "BUTTON", "Install to Desktop",
                                   WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                                   WIN_W - 126 - 8 - 240, 16, 240, 28, h,
                                   (HMENU)ID_DESKTOP, NULL, NULL);
        SendMessage(g_deskChk, BM_SETCHECK, desk_flag_read(), 0);
        g_status = CreateWindowEx(0, "STATIC", "Loading the package catalog...",
                                  WS_CHILD | WS_VISIBLE,
                                  8, WIN_H - STATUS_H + 4, WIN_W - 16, 22, h,
                                  (HMENU)ID_STATUS, NULL, NULL);
        g_notice = CreateWindowEx(0, "STATIC", "Loading catalog...",
                                  WS_CHILD | WS_VISIBLE | SS_CENTER,
                                  40, LIST_Y + 56, WIN_W - 80, 26, h,
                                  (HMENU)ID_NOTICE, NULL, NULL);
        g_scrollbar = CreateWindowEx(0, "SCROLLBAR", "",
                                     WS_CHILD | SBS_VERT,
                                     WIN_W - SB_W, LIST_Y, SB_W, VIS_CARDS * CARD_H,
                                     h, (HMENU)ID_SCROLL, NULL, NULL);
        return 0;
    case WM_CTLCOLORSTATIC:                      /* statics blend into white */
        return (LRESULT)g_brWhite;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        if (!dc) return 0;
        SetBkMode(dc, TRANSPARENT);
        SelectObject(dc, g_fTitle);
        SetTextColor(dc, RGB(24, 24, 28));
        TextOut(dc, 14, 10, "Software", 8);
        if (g_subtitle[0]) {
            SelectObject(dc, g_fSmall);
            SetTextColor(dc, RGB(118, 118, 124));
            TextOut(dc, 15, 46, g_subtitle, (int)strlen(g_subtitle));
        }
        RECT r;
        SetRect(&r, 0, HEADER_H - 1, WIN_W, HEADER_H);        /* header rule */
        FillRect(dc, &r, g_brSep);
        SetRect(&r, 0, WIN_H - STATUS_H, WIN_W, WIN_H - STATUS_H + 1);
        FillRect(dc, &r, g_brSep);                            /* status rule */
        EndPaint(h, &ps);
        return 0;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_REFRESH && g_job == JOB_NONE)
            job_begin(JOB_INDEX, -1);
        else if (LOWORD(wp) == ID_DESKTOP)       /* auto-toggled; persist it (Q5) */
            desk_flag_write((int)SendMessage(g_deskChk, BM_GETCHECK, 0, 0) == BST_CHECKED);
        return 0;
    case MSG_ACTION: {
        int i = (int)wp;
        if (g_job != JOB_NONE || i < 0 || i >= g_npkgs) return 0;
        struct pkg *p = &g_pkgs[i];
        if (p->state == PS_INSTALLED || p->state == PS_ORPHAN)
            job_begin(JOB_REMOVE, i);
        else if (p->state == PS_AVAILABLE)
            job_begin(JOB_INSTALL, i);
        return 0;
    }
    case MSG_FSCHANGE:                           /* external gucman run */
        if (g_job == JOB_NONE) {
            model_refresh();
            buttons_enable();
        }
        return 0;
    case WM_TIMER:
        if (wp == TIMER_JOB) job_tick();
        return 0;
    case WM_VSCROLL: {
        int code = LOWORD(wp), pos = HIWORD(wp);
        if (code == SB_THUMBTRACK || code == SB_THUMBPOSITION) set_scroll(pos);
        else if (code == SB_LINEUP) set_scroll(g_scroll - 1);
        else if (code == SB_LINEDOWN) set_scroll(g_scroll + 1);
        else if (code == SB_PAGEUP) set_scroll(g_scroll - VIS_CARDS);
        else if (code == SB_PAGEDOWN) set_scroll(g_scroll + VIS_CARDS);
        return 0;
    }
    case WM_MOUSEWHEEL: {
        g_wheelAcc += GET_WHEEL_DELTA_WPARAM(wp);
        int cards = g_wheelAcc / WHEEL_DELTA;
        if (cards) {
            g_wheelAcc -= cards * WHEEL_DELTA;
            set_scroll(g_scroll - cards);
        }
        return 0;
    }
    case WM_KEYDOWN:
        switch (wp) {
        case VK_UP:    set_scroll(g_scroll - 1); return 0;
        case VK_DOWN:  set_scroll(g_scroll + 1); return 0;
        case VK_PRIOR: set_scroll(g_scroll - VIS_CARDS); return 0;
        case VK_NEXT:  set_scroll(g_scroll + VIS_CARDS); return 0;
        case VK_HOME:  set_scroll(0); return 0;
        case VK_END:   set_scroll(g_npkgs); return 0;
        case VK_F5:
            if (g_job == JOB_NONE) job_begin(JOB_INDEX, -1);
            return 0;
        }
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(void) {
    g_base = os_base_version();
    baked_load();
    const char *home = getenv("HOME");
    if (!home || !*home) home = "/root";
    char cache[280];
    snprintf(cache, sizeof cache, "%s/.cache", home);
    mkdir(cache, 0755);                          /* EEXIST is fine */
    snprintf(g_outPath, sizeof g_outPath, "%s/software.out", cache);
    snprintf(g_errPath, sizeof g_errPath, "%s/software.err", cache);

    g_brWhite = CreateSolidBrush(RGB(255, 255, 255));
    g_brSep = CreateSolidBrush(RGB(225, 225, 228));
    /* The 20px family (font-20 retune): body text IS the unified 20px
     * em; title one step up, annotations one step down — nothing at the
     * fuzzy ppem-9..12 sizes that motivated the retune. "sans" since the
     * C2 flag day (#282): these are UI headings and must match the sans
     * stock controls around them (a NULL face means the platform default
     * face, which stays mono). */
    g_fTitle = CreateFont(-26, 0, 0, 0, FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, "sans");
    g_fName = CreateFont(-20, 0, 0, 0, FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, "sans");
    g_fSmall = CreateFont(-16, 0, 0, 0, FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, "sans");

    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "Software";
    wc.hbrBackground = g_brWhite;
    RegisterClass(&wc);
    wc.lpfnWndProc = card_proc;
    wc.lpszClassName = "PkgCard";
    wc.hbrBackground = g_brWhite;
    RegisterClass(&wc);

    /* fixed-size (no WS_THICKFRAME): the layout is exact; the kernel
     * scales fixed windows via SET_DST instead of shearing them */
    g_win = CreateWindowEx(0, "Software", "Software",
                           WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT, WIN_W, WIN_H,
                           NULL, NULL, NULL, NULL);
    if (!g_win) return 1;

    /* live view of external installs (the DB dir is the state) */
    mkdir("/var", 0755);
    mkdir("/var/lib", 0755);
    mkdir(GM_DB_DIR, 0755);
    g_watch = fsw_open(GM_DB_DIR, 0);
    if (g_watch >= 0) RegisterFdWake(g_win, g_watch, MSG_FSCHANGE);

    job_begin(JOB_INDEX, -1);                    /* async catalog load */

    MSG m;
    while (GetMessage(&m, NULL, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (g_watch >= 0) close(g_watch);
    return 0;
}
