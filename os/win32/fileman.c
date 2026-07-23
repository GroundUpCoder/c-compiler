/* fileman.c — the file manager (todos/0048, desktop apps wave 1).
 *
 * A Win32 veneer app over plain POSIX dir calls: a path EDIT + Go/Up/
 * Open/With buttons on top, a LISTBOX of the directory below.
 * Double-click (or the Open button) activates the selection with wm.c's
 * activate() semantics (todos/0066, keep in step): directories navigate,
 * a runnable file (`\0asm` wasm / `#!` script — the kernel spawn
 * dispatch, through symlinks) spawns with its own pgroup + the desktop
 * env, anything else opens through the openwith associations
 * (os/openwith.h, todos/0072 — extension map, then default.gui). The
 * "With" button is the picker: a small window with the command EDIT
 * (prefilled with the effective association) + an "Always" checkbox
 * that persists it via ow_set. Children are reaped WNOHANG off the idle
 * tick (WM_TIMER).
 *
 * Agent-drivable by construction (OS.md pillar): `wmctl settext EDIT:0
 * /some/dir` + `wmctl click Go` navigates; the LISTBOX text is its items
 * (the user32 WM_GETTEXT convention), so a driver reads the listing
 * without pixels. Built ANSI — POSIX paths are bytes here; no UTF-16
 * boundary to cross.
 *
 * File operations (todos/0092): right-click is the primary trigger — a
 * row gets Open / Open With / Cut / Copy / Rename / Delete / Properties
 * (Explorer-style, the row under the pointer is selected first), the
 * empty pane gets Paste / New Folder / Refresh — over the 0091
 * TrackPopupMenu primitive, so every item is an agent target (`wmctl
 * click Rename`). F2 / Del / ^C / ^X / ^V mirror the menu through a
 * runtime accelerator table, gated on listbox focus so the path EDIT
 * keeps its own chords. The ops themselves are shell32's SHFile* helpers
 * (os/fileops.h shared with wm.c's desktop menus): cut/copy put a
 * format-2 file list on the ONE kernel clipboard slot (0090) — so
 * cut/copy/paste crosses fileman instances AND the desktop — paste
 * moves (cut, slot cleared after) or duplicates (copy, "Copy of"
 * uniquifier on clash). Delete confirms via MessageBox and sends to the
 * Recycle Bin (todos/0093 — shell32's SHFileTrash over the fileops.h
 * /root/.recycle store); Shift+Del bypasses to a confirmed PERMANENT
 * delete, and inside the store itself (browsing /root/.recycle/files)
 * every delete is permanent. In the store the row menu swaps to
 * Restore / Delete / Properties — Restore returns the entry to its
 * sidecar-recorded original path, prompting to replace an occupied one —
 * and the pane menu gains Empty Recycle Bin (confirmed; grayed when
 * empty). Every op surfaces failure as strerror(errno) in a MessageBox
 * (EROFS under /usr fails clean, todos/0040). Rename is a small dialog
 * window (the "Open with" picker pattern; Enter commits, Esc cancels),
 * refusing overwrite (EEXIST). Properties is a stat() MessageBox. */

#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "../fswatch.h"
#include "../launch.h"
#include "../listdir.h"
#include "../openwith.h"

#define ID_PATH 100
#define ID_GO   101
#define ID_UP   102
#define ID_OPEN 103
#define ID_LIST 104
#define ID_WITH 105
#define ID_STATUS 106               /* the bottom status strip (0106) */

#define ID_OW_CMD    200             /* the picker window's children */
#define ID_OW_ALWAYS 201
#define ID_OW_OK     202
#define ID_OW_CANCEL 203

#define ID_RN_NAME   210             /* the rename dialog's children (0092) */
#define ID_RN_OK     211
#define ID_RN_CANCEL 212

#define IDM_OPEN      300            /* context menu / accelerator commands */
#define IDM_OPENWITH  301
#define IDM_CUT       302
#define IDM_COPY      303
#define IDM_PASTE     304
#define IDM_RENAME    305
#define IDM_DELETE    306
#define IDM_PROPS     307
#define IDM_NEWFOLDER 308
#define IDM_REFRESH   309
#define IDM_DELPERM   310            /* Shift+Del: permanent delete (0093) */
#define IDM_RESTORE   311            /* trash-only rows (0093) */
#define IDM_EMPTY     312            /* trash-only pane (0093) */
#define IDM_EDIT      313            /* open in the GUI text editor (0202) */
#define IDM_SORT_NAME 320            /* View: sort key + toggles (0106) */
#define IDM_SORT_SIZE 321
#define IDM_SORT_DATE 322
#define IDM_REVERSE   323
#define IDM_HIDDEN    324
#define IDM_BACK      325            /* Alt+Left history back (0106) */

#define WM_FSCHANGE (WM_APP + 1)     /* cwd changed on disk (FS_WATCH wake) */

#define TOP_H  36                    /* the path/button strip (20px-font retune:
                                        strip height = one 30px control line box
                                        + 6px vertical margin; EDIT/buttons get
                                        TOP_H-6 = 30 >= tmHeight 28) */
#define BTN_W  60                     /* fits a 4-char label ("Open"/"With" =
                                        48px advance at 12px/char) + padding */

static HWND g_win, g_path, g_go, g_up, g_open, g_with, g_list, g_status;
static char g_cwd[512] = "/root";
static int g_nkids;
static int g_watch = -1;             /* FS_WATCH fd on the cwd (ticket #75) */

/* View state (0106): the sort key, its direction, and whether dotfiles
 * show. The details columns come off the same stat() refill already did. */
static int g_sort;                   /* 0 name, 1 size, 2 date */
static int g_reverse;                /* flip the sort key */
static int g_hidden;                 /* show dotfiles (off = Explorer default) */

/* Back history (0106): a small pushdown of visited dirs. Backspace stays
 * Up (Win95); Alt+Left pops this. */
static char g_back[32][512];
static int g_nback;

static HWND g_ow_win;                /* the "Open with" picker (one at a time) */
static char g_ow_file[800];          /* the file it targets */

static HWND g_rn_win;                /* the rename dialog (one at a time, 0092) */
static char g_rn_file[800];          /* the file it targets */
static HACCEL g_accel;               /* F2/Del/^C/^X/^V (listbox focus only) */

/* Launching rides ../launch.h's shared ladder (spawn_path/launch_assoc/
 * launch_activate, todos/0239+0240) — fileman passes its own kid counter
 * and "fileman" as the diagnostic prefix. */

/* ---- listing ---- */

typedef ld_ent Ent;             /* the shared listing shape (os/listdir.h) */

/* The live listing, index-aligned with the LISTBOX rows: a row op resolves
 * its target through here (g_ents[row]) rather than re-parsing the display
 * string, so the details columns never confuse path building. */
static Ent g_ents[512];
static int g_nent;    /* entries actually snapshotted (<= 512) */
static int g_ntotal;  /* the directory's true entry count (0255) */

static int entcmp(const void *a, const void *b) {
    const Ent *ea = (const Ent *)a, *eb = (const Ent *)b;
    if (ea->is_dir != eb->is_dir) return eb->is_dir - ea->is_dir;   /* dirs first */
    int c;
    if (g_sort == 1) c = (ea->size > eb->size) - (ea->size < eb->size);
    else if (g_sort == 2) c = (ea->mtime > eb->mtime) - (ea->mtime < eb->mtime);
    else c = strcmp(ea->name, eb->name);
    if (c == 0) c = strcmp(ea->name, eb->name);                 /* stable tie-break */
    return g_reverse ? -c : c;
}

/* The status strip: item count + selected summary (0106). The strip is
 * comctl32's STATUSBAR (0230 — the shared control notepad uses: font-
 * derived height, vcentered descender-safe text, self-parking on WM_SIZE),
 * so fileman owns none of its geometry or paint. */
static void status_update(void) {
    if (!g_status) return;
    /* g_ntotal, not LB_GETCOUNT: the count must be the directory's truth,
     * never inflated by a diagnostic/"(N more...)" row (0255). */
    int total = g_ntotal;
    int selc = (int)SendMessage(g_list, LB_GETSELCOUNT, 0, 0);
    char s[256];
    if (selc > 0) {
        /* Sum the bytes of the selected files (dirs contribute nothing). */
        static int idx[512];
        int got = (int)SendMessage(g_list, LB_GETSELITEMS, 512, (LPARAM)idx);
        long bytes = 0;
        for (int i = 0; i < got; i++)
            if (idx[i] >= 0 && idx[i] < g_nent && !g_ents[idx[i]].is_dir)
                bytes += g_ents[idx[i]].size;
        snprintf(s, sizeof s, "%d object(s)   %d selected (%ld bytes)",
                 total, selc, bytes);
    } else {
        snprintf(s, sizeof s, "%d object(s)", total);
    }
    SendMessage(g_status, SB_SETTEXT, 0, (LPARAM)s);
}

static void refill(void) {
    SendMessage(g_list, LB_RESETCONTENT, 0, 0);
    /* The walk is os/listdir.h's shared list_dir (CD34). Dotfiles hidden
     * unless the View toggle is on (0093/0106 — the .recycle store must
     * not clutter /root; Explorer-style). list_dir returns the TOTAL
     * count (may exceed the 512-entry snapshot); a clipped listing gets
     * an explicit trailing "(N more...)" row instead of silently reading
     * as complete (0255). That row sits at index g_nent, past every
     * `idx < g_nent` guard, so it is inert to selection/open/ops. */
    int total = list_dir(g_cwd, g_ents, 512,
                         LIST_FOLLOW_LINKS | (g_hidden ? 0u : LIST_HIDE_DOTFILES));
    if (total < 0) {
        SendMessage(g_list, LB_ADDSTRING, 0, (LPARAM)"(cannot open directory)");
        g_nent = 0;
        g_ntotal = 0;
        status_update();
        return;
    }
    g_ntotal = total;
    g_nent = total < 512 ? total : 512;
    qsort(g_ents, (size_t)g_nent, sizeof g_ents[0], entcmp);
    for (int i = 0; i < g_nent; i++) {
        /* Details columns off the same stat: a left name field, a
         * right-aligned size (or <DIR>), then a fixed-width date. The
         * mono font makes space-padding an honest column (LB_SETTABSTOPS-
         * free, 0106). Agent readers key on the name prefix. */
        char namef[264], sizef[16], datef[20];
        snprintf(namef, sizeof namef, "%s%s", g_ents[i].name,
                 g_ents[i].is_dir ? "/" : "");
        if (g_ents[i].is_dir) snprintf(sizef, sizeof sizef, "<DIR>");
        else snprintf(sizef, sizeof sizef, "%ld", g_ents[i].size);
        time_t mt = (time_t)g_ents[i].mtime;
        struct tm *tm = localtime(&mt);
        if (tm)
            snprintf(datef, sizeof datef, "%04d-%02d-%02d %02d:%02d",
                     tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
                     tm->tm_hour, tm->tm_min);
        else snprintf(datef, sizeof datef, "-");
        char row[320];
        snprintf(row, sizeof row, "%-28s %10s  %s", namef, sizef, datef);
        SendMessage(g_list, LB_ADDSTRING, 0, (LPARAM)row);
    }
    if (g_ntotal > g_nent) {
        char row[64];
        snprintf(row, sizeof row, "(%d more entries not shown)",
                 g_ntotal - g_nent);
        SendMessage(g_list, LB_ADDSTRING, 0, (LPARAM)row);
    }
    SetWindowText(g_path, g_cwd);
    char title[600];
    snprintf(title, sizeof title, "File Manager - %s", g_cwd);
    SetWindowText(g_win, title);
    status_update();
}

/* Record the current dir on the back stack before leaving it (0106). */
static void push_back(void) {
    if (g_nback >= 32) {                          /* drop the oldest */
        memmove(g_back[0], g_back[1], 31 * sizeof g_back[0]);
        g_nback = 31;
    }
    snprintf(g_back[g_nback++], sizeof g_back[0], "%s", g_cwd);
}

/* FS_WATCH auto-refresh (ticket #75 / todos/0123): ONE watch fd on the
 * cwd, re-armed per navigation, riding user32's RegisterFdWake seam — the
 * fd joins GetMessage's unified WAIT and a readable episode posts
 * WM_FSCHANGE. External create/delete/rename in the cwd — including an
 * editor's tmp+rename-over save, which a per-inode watch would miss —
 * refresh the listing with no keystroke. No kernel watch (ENOSYS) leaves
 * the fd at -1: manual F5 semantics, as before 0123. */
static void watch_cwd(void) {
    if (g_watch >= 0) {
        UnregisterFdWake(g_watch);
        close(g_watch);
        g_watch = -1;
    }
    g_watch = fsw_open(g_cwd, 0);
    if (g_watch >= 0) RegisterFdWake(g_win, g_watch, WM_FSCHANGE);
}

/* An UNPROMPTED refill must not eat the user's selection (0123): indexes
 * shift when entries come and go, so carry the marked NAMES across the
 * rebuild and re-mark the survivors. */
static void refill_keep_selection(void) {
    char keep[64][264];
    int nkeep = 0;
    int idx[512];
    int n = (int)SendMessage(g_list, LB_GETSELITEMS, 512, (LPARAM)idx);
    for (int i = 0; i < n && nkeep < 64; i++)
        if (idx[i] >= 0 && idx[i] < g_nent)
            snprintf(keep[nkeep++], sizeof keep[0], "%s", g_ents[idx[i]].name);
    refill();
    for (int i = 0; i < nkeep; i++)
        for (int j = 0; j < g_nent; j++)
            if (!strcmp(keep[i], g_ents[j].name)) {
                SendMessage(g_list, LB_SETSEL, 1, (LPARAM)j);
                break;
            }
}

/* `record` distinguishes a user navigation (pushes history) from a Back
 * pop (does not). */
static void navigate_ex(const char *path, int record) {
    char norm[512];
    snprintf(norm, sizeof norm, "%s", path[0] ? path : "/");
    size_t len = strlen(norm);
    while (len > 1 && norm[len - 1] == '/') norm[--len] = 0;   /* trim tail / */
    struct stat st;
    if (stat(norm, &st) != 0 || !S_ISDIR(st.st_mode)) {
        SetWindowText(g_path, g_cwd);                          /* revert */
        return;
    }
    if (strcmp(norm, g_cwd) == 0) { refill(); return; }        /* no move */
    if (record) push_back();
    snprintf(g_cwd, sizeof g_cwd, "%s", norm);
    refill();
    watch_cwd();                                 /* re-arm on the new cwd */
}

static void navigate(const char *path) { navigate_ex(path, 1); }

static void go_up(void) {
    char parent[512];
    snprintf(parent, sizeof parent, "%s", g_cwd);
    char *slash = strrchr(parent, '/');
    if (!slash) return;
    if (slash == parent) parent[1] = 0;          /* parent of /x is / */
    else *slash = 0;
    navigate_ex(parent, 1);
}

static void go_back(void) {
    if (g_nback <= 0) return;
    char dest[512];
    snprintf(dest, sizeof dest, "%s", g_back[--g_nback]);
    navigate_ex(dest, 0);
}

/* Build row `i`'s full path from the live listing (not the display
 * string — the details columns would confuse a re-parse). */
static int row_path(int i, char *full, size_t sz, int *isdir) {
    if (i < 0 || i >= g_nent) return 0;
    if (isdir) *isdir = g_ents[i].is_dir;
    if (!strcmp(g_cwd, "/")) snprintf(full, sz, "/%s", g_ents[i].name);
    else snprintf(full, sz, "%s/%s", g_cwd, g_ents[i].name);
    return 1;
}

/* The caret row's full path (LB_GETCURSEL — the single-target ops). */
static int sel_path(char *full, size_t sz, int *isdir) {
    return row_path((int)SendMessage(g_list, LB_GETCURSEL, 0, 0), full, sz, isdir);
}

/* Gather the selected rows' indices (0106). With no extended selection
 * (or none marked) fall back to the caret so single-select flows work. */
static int sel_indices(int *out, int max) {
    int n = (int)SendMessage(g_list, LB_GETSELITEMS, (WPARAM)max, (LPARAM)out);
    if (n <= 0) {
        int sel = (int)SendMessage(g_list, LB_GETCURSEL, 0, 0);
        if (sel < 0) return 0;
        out[0] = sel;
        return 1;
    }
    return n;
}

static void open_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    /* Dirs navigate IN-PLACE — fileman's flavor of the shared ladder's
     * directory policy, peeled here off the listing's isdir (no extra
     * stat). The rest is launch.h's activate() ladder (todos/0240): no
     * MRU push (wm-only), and a dangling row's failed stat still falls
     * through to its association. */
    if (isdir) { navigate(full); return; }
    struct stat st;
    launch_activate(full, stat(full, &st) == 0 ? &st : 0, 0, 0,
                    &g_nkids, "fileman");
}

/* Edit (0202): Open follows the association — for a document that's its
 * VIEWER (a .mgp deck raises the presentation) — so this row opens the
 * file's text in the GUI editor instead (the openwith default.gui entry). */
static void edit_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir) || isdir) return;
    char cmd[OW_CMD_MAX];
    ow_editor(cmd, sizeof cmd);
    launch_assoc(cmd, full, &g_nkids, "fileman");
}

/* ---- the "Open with" picker (todos/0072) ----
 * A small second top-level window: the command EDIT prefilled with the
 * file's effective association, an "Always" checkbox (BS_AUTOCHECKBOX)
 * that persists the pick via ow_set — under the file's extension key, or
 * default.gui for extension-less files — and OK/Cancel. One picker at a
 * time; OK spawns `command file` the same way Open does. */

static void op_error(const char *verb, const char *path);   /* fwd (file ops) */

static LRESULT CALLBACK ow_wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        char key[32], cmd[OW_CMD_MAX], label[64];
        int has_ext = ow_key_for(g_ow_file, key, sizeof key);
        ow_resolve(g_ow_file, 1, cmd, sizeof cmd);
        if (has_ext) snprintf(label, sizeof label, "Always for .%s", key);
        else snprintf(label, sizeof label, "Always (GUI default)");
        const char *base = strrchr(g_ow_file, '/');
        /* 20px-font retune: rows on a 32px pitch, controls a 28-30px line
         * box; the checkbox spans the full width so "Always (GUI default)"
         * (~240px) fits; buttons a 30px line box on the bottom row. */
        CreateWindowEx(0, "STATIC", base ? base + 1 : g_ow_file,
                       WS_CHILD | WS_VISIBLE, 8, 8, 344, 28, h, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", cmd, WS_CHILD | WS_VISIBLE,
                       8, 40, 344, 30, h, (HMENU)ID_OW_CMD, NULL, NULL);
        CreateWindowEx(0, "BUTTON", label, WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       8, 78, 344, 28, h, (HMENU)ID_OW_ALWAYS, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE,
                       188, 116, 80, 30, h, (HMENU)ID_OW_OK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE,
                       272, 116, 80, 30, h, (HMENU)ID_OW_CANCEL, NULL, NULL);
        return 0;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_OW_OK) {
            char cmd[OW_CMD_MAX];
            GetWindowText(GetDlgItem(h, ID_OW_CMD), cmd, sizeof cmd);
            if (cmd[0]) {
                if (IsDlgButtonChecked(h, ID_OW_ALWAYS)) {
                    char key[32];
                    /* "Always" must not silently not-persist (todos/0234):
                     * report a store-write failure, then still do the
                     * one-shot open — that part works regardless. */
                    if (ow_set(ow_key_for(g_ow_file, key, sizeof key)
                               ? key : "default.gui", cmd) != 0)
                        op_error("save the association for", g_ow_file);
                }
                launch_assoc(cmd, g_ow_file, &g_nkids, "fileman");
            }
            DestroyWindow(h);
            return 0;
        }
        if (LOWORD(wp) == ID_OW_CANCEL) { DestroyWindow(h); return 0; }
        return 0;
    case WM_CLOSE:
        DestroyWindow(h);
        return 0;
    case WM_DESTROY:
        if (h == g_ow_win) g_ow_win = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static void with_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir) || isdir) return;
    if (g_ow_win) DestroyWindow(g_ow_win);
    snprintf(g_ow_file, sizeof g_ow_file, "%s", full);
    g_ow_win = CreateWindowEx(0, "OpenWith", "Open with",
                              WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, 360, 160,
                              NULL, NULL, NULL, NULL);
}

/* ---- file operations (todos/0092) ----
 * All over shell32's SHFile* helpers (the shared os/fileops.h core);
 * failure surfaces as strerror(errno) in a MessageBox and the listing
 * refreshes after every mutation. */

static void op_error(const char *verb, const char *path) {
    char msg[960];
    snprintf(msg, sizeof msg, "Cannot %s '%s':\n%s", verb, path, strerror(errno));
    MessageBox(g_win, msg, "File Manager", MB_OK);
}

static void join_path(char *out, size_t sz, const char *dir, const char *name) {
    if (!strcmp(dir, "/")) snprintf(out, sz, "/%s", name);
    else snprintf(out, sz, "%s/%s", dir, name);
}

/* Cut/Copy: every selected row's full path onto the kernel clipboard slot
 * as a format-2 file list (0106 — the whole multi-selection, not just the
 * caret). */
static void clip_selected(int cut) {
    int idx[512];
    int n = sel_indices(idx, 512);
    if (n <= 0) return;
    static char paths[512][800];
    const char *pv[512];
    int cnt = 0, isdir;
    for (int i = 0; i < n && cnt < 512; i++)
        if (row_path(idx[i], paths[cnt], sizeof paths[0], &isdir))
            pv[cnt] = paths[cnt], cnt++;
    if (cnt && SHClipSetFiles(cut, pv, cnt) != 0) op_error("clip", pv[0]);
}

/* Paste into the cwd: cut = move (slot cleared after a clean run — a cut
 * pastes once), copy = duplicate with the "Copy of" clash uniquifier. */
static void paste_here(void) {
    static char cl[SHCLIP_MAX];
    int cut = 0;
    int n = SHClipLoadFiles(cl, sizeof cl, &cut);
    int ok = 1;
    for (int i = 0; i < n; i++) {
        const char *src = SHClipPath(cl, i);
        const char *base = strrchr(src, '/');
        base = base ? base + 1 : src;
        char dst[800];
        if (cut) {
            join_path(dst, sizeof dst, g_cwd, base);
            if (SHFileMove(src, dst) != 0) { op_error("move", src); ok = 0; break; }
        } else {
            if (SHPasteDest(g_cwd, base, dst, sizeof dst) != 0 ||
                SHFileCopy(src, dst) != 0) { op_error("copy", src); ok = 0; break; }
        }
    }
    if (n > 0 && cut && ok) SHClipClear();
    refill();
}

/* Browsing the trash store itself? (Exactly files/ — a directory INSIDE a
 * trashed dir is ordinary territory; per-entry restore only makes sense at
 * the top, todos/0093.) */
static int in_trash(void) { return strcmp(g_cwd, SHTrashFilesDir()) == 0; }

/* Delete (0093): the plain path sends to the Recycle Bin; `perm` (the
 * Shift+Del accelerator) — or any delete inside the store — really
 * deletes. Both confirm first, with wording that says which one this is. */
static void delete_selected(int perm) {
    int idx[512];
    int n = sel_indices(idx, 512);
    if (n <= 0) return;
    perm = perm || in_trash();
    char full[800];
    int isdir;
    char msg[900];
    if (n == 1) {                        /* singular — the 0092/0093 wording */
        row_path(idx[0], full, sizeof full, &isdir);
        const char *base = strrchr(full, '/');
        base = base ? base + 1 : full;
        if (perm)
            snprintf(msg, sizeof msg,
                     "Are you sure you want to delete '%s'?", base);
        else
            snprintf(msg, sizeof msg,
                     "Are you sure you want to send '%s' to the Recycle Bin?", base);
    } else {
        if (perm)
            snprintf(msg, sizeof msg,
                     "Are you sure you want to delete these %d items?", n);
        else
            snprintf(msg, sizeof msg,
                     "Are you sure you want to send these %d items "
                     "to the Recycle Bin?", n);
    }
    if (MessageBox(g_win, msg,
                   n == 1 && isdir ? "Confirm Folder Delete"
                                   : n == 1 ? "Confirm File Delete"
                                            : "Confirm Multiple Item Delete",
                   MB_YESNO) != IDYES)
        return;
    for (int i = 0; i < n; i++) {
        if (!row_path(idx[i], full, sizeof full, &isdir)) continue;
        if ((perm ? SHFileDelete(full) : SHFileTrash(full)) != 0) {
            op_error("delete", full);
            break;                       /* stop on the first failure */
        }
        if (in_trash()) SHTrashForget(full);   /* don't orphan the sidecar (0093) */
    }
    refill();
}

/* Restore a stored entry to its sidecar-recorded original path (0093).
 * An occupied target prompts to replace (delete it, retry); a missing
 * sidecar or parent surfaces as the usual error box. */
static void restore_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    char target[800];
    if (SHRestoreTarget(full, target, sizeof target) != 0) {
        op_error("restore", full);
        return;
    }
    if (SHFileRestore(full) != 0) {
        if (errno == EEXIST) {
            char msg[960];
            snprintf(msg, sizeof msg,
                     "A file already exists at '%s'.\nReplace it?", target);
            if (MessageBox(g_win, msg, "Confirm Restore", MB_YESNO) != IDYES)
                return;
            if (SHFileDelete(target) != 0 || SHFileRestore(full) != 0)
                op_error("restore", full);
        } else op_error("restore", full);
    }
    refill();
}

/* Empty Recycle Bin (0093): confirmed, then the whole store goes. */
static void empty_trash(void) {
    if (MessageBox(g_win,
                   "Are you sure you want to permanently delete all items "
                   "in the Recycle Bin?",
                   "Empty Recycle Bin", MB_YESNO) != IDYES)
        return;
    if (SHTrashEmpty() != 0) op_error("empty", "Recycle Bin");
    refill();
}

static void new_folder(void) {
    char dst[800];
    if (SHNewDest(g_cwd, "New Folder", "", dst, sizeof dst) != 0 ||
        mkdir(dst, 0755) != 0) {
        op_error("create folder in", g_cwd);
        return;
    }
    refill();
}

/* Properties: what stat() knows — name, location, type, size, mtime. */
static void props_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    struct stat st;
    if (lstat(full, &st) != 0) { op_error("stat", full); return; }
    const char *base = strrchr(full, '/');
    base = base ? base + 1 : full;
    const char *type = S_ISLNK(st.st_mode) ? "Shortcut (symlink)"
                     : S_ISDIR(st.st_mode) ? "Directory"
                     : ow_is_runnable(full) ? "Application"
                     : "File";
    struct tm *tm = localtime(&st.st_mtime);
    char title[300], text[900];
    snprintf(title, sizeof title, "%s Properties", base);
    snprintf(text, sizeof text,
             "Name: %s\nLocation: %s\nType: %s\nSize: %ld bytes\n"
             "Modified: %04d-%02d-%02d %02d:%02d",
             base, g_cwd, type, (long)st.st_size,
             tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
             tm->tm_hour, tm->tm_min);
    MessageBox(g_win, text, title, MB_OK);
}

/* ---- the rename dialog (0092) ----
 * The "Open with" picker pattern: a small top-level with the name EDIT
 * prefilled + OK/Cancel; Enter/Esc route from the message loop (the
 * single-line EDIT swallows both). OK renames — refusing '/', empty and
 * an existing destination (SHFileMove's EEXIST) — and errors keep the
 * dialog open for another try. */

static LRESULT CALLBACK rn_wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        const char *base = strrchr(g_rn_file, '/');
        base = base ? base + 1 : g_rn_file;
        char label[300];
        snprintf(label, sizeof label, "Rename '%s' to:", base);
        /* 20px-font retune: same rhythm as the Open-with picker (32px row
         * pitch, 28-30px control line boxes, 30px buttons on the foot). */
        CreateWindowEx(0, "STATIC", label, WS_CHILD | WS_VISIBLE,
                       8, 8, 344, 28, h, NULL, NULL, NULL);
        HWND ed = CreateWindowEx(0, "EDIT", base, WS_CHILD | WS_VISIBLE,
                                 8, 40, 344, 30, h, (HMENU)ID_RN_NAME, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE,
                       188, 78, 80, 30, h, (HMENU)ID_RN_OK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE,
                       272, 78, 80, 30, h, (HMENU)ID_RN_CANCEL, NULL, NULL);
        SetFocus(ed);
        SendMessage(ed, EM_SETSEL, 0, (LPARAM)-1);
        return 0;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_RN_OK) {
            char name[256];
            GetWindowText(GetDlgItem(h, ID_RN_NAME), name, sizeof name);
            if (!name[0] || strchr(name, '/')) {
                MessageBox(h, "Invalid name.", "Rename", MB_OK);
                return 0;
            }
            char *slash = strrchr(g_rn_file, '/');
            char dir[800];
            snprintf(dir, sizeof dir, "%.*s",
                     (int)(slash == g_rn_file ? 1 : slash - g_rn_file), g_rn_file);
            char dst[1100];
            join_path(dst, sizeof dst, dir, name);
            if (strcmp(dst, g_rn_file) != 0 && SHFileMove(g_rn_file, dst) != 0) {
                char msg[960];
                snprintf(msg, sizeof msg, "Cannot rename to '%s':\n%s",
                         name, strerror(errno));
                MessageBox(h, msg, "Rename", MB_OK);
                return 0;                        /* keep the dialog open */
            }
            DestroyWindow(h);
            refill();
            return 0;
        }
        if (LOWORD(wp) == ID_RN_CANCEL) { DestroyWindow(h); return 0; }
        return 0;
    case WM_CLOSE:
        DestroyWindow(h);
        return 0;
    case WM_DESTROY:
        if (h == g_rn_win) g_rn_win = NULL;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static void rename_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    if (g_rn_win) DestroyWindow(g_rn_win);
    snprintf(g_rn_file, sizeof g_rn_file, "%s", full);
    g_rn_win = CreateWindowEx(0, "Rename", "Rename",
                              WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                              CW_USEDEFAULT, CW_USEDEFAULT, 360, 130,
                              NULL, NULL, NULL, NULL);
}

/* ---- the context menu (0092, over the 0091 TrackPopupMenu) ----
 * (sx, sy) is the WM_CONTEXTMENU point in top-level SURFACE coords. A row
 * gets selected first (the Explorer rule), then the file menu; a point
 * outside the items gets the pane menu. Items are agent targets. */
static void ctx_menu(int sx, int sy) {
    if (sy < TOP_H) return;                      /* the button strip's */
    LRESULT hit = SendMessage(g_list, LB_ITEMFROMPOINT, 0,
                              MAKELPARAM(sx - 4, sy - TOP_H));
    int outside = HIWORD(hit);
    HMENU m = CreatePopupMenu();
    if (!m) return;
    if (!outside) {
        /* Explorer rule (0106): right-clicking a row that isn't part of the
         * current multi-selection replaces the set with just it; clicking
         * inside the set keeps it (so "Delete" acts on the whole set). The
         * caret always follows so single-target ops (Rename/Properties) hit
         * the clicked row. */
        int hitrow = (int)(short)LOWORD(hit);
        SetFocus(g_list);
        if (!SendMessage(g_list, LB_GETSEL, (WPARAM)hitrow, 0)) {
            SendMessage(g_list, LB_SETSEL, 0, (LPARAM)-1);
            SendMessage(g_list, LB_SETSEL, 1, (LPARAM)hitrow);
        }
        SendMessage(g_list, LB_SETCURSEL, (WPARAM)hitrow, 0);
        status_update();
        char full[800];
        int isdir = 0;
        sel_path(full, sizeof full, &isdir);
        if (in_trash()) {              /* the Recycle Bin view (0093) */
            AppendMenuA(m, 0, IDM_RESTORE, "Restore");
            AppendMenuA(m, 0, IDM_DELETE, "Delete");
            AppendMenuA(m, MF_SEPARATOR, 0, NULL);
            AppendMenuA(m, 0, IDM_PROPS, "Properties");
        } else {
            AppendMenuA(m, 0, IDM_OPEN, "Open");
            AppendMenuA(m, isdir ? MF_GRAYED : 0, IDM_OPENWITH, "Open With");
            AppendMenuA(m, isdir ? MF_GRAYED : 0, IDM_EDIT, "Edit");
            AppendMenuA(m, MF_SEPARATOR, 0, NULL);
            AppendMenuA(m, 0, IDM_CUT, "Cut");
            AppendMenuA(m, 0, IDM_COPY, "Copy");
            AppendMenuA(m, MF_SEPARATOR, 0, NULL);
            AppendMenuA(m, 0, IDM_RENAME, "Rename");
            AppendMenuA(m, 0, IDM_DELETE, "Delete");
            AppendMenuA(m, MF_SEPARATOR, 0, NULL);
            AppendMenuA(m, 0, IDM_PROPS, "Properties");
        }
    } else if (in_trash()) {           /* trash pane: Empty + Refresh (0093) */
        AppendMenuA(m, SHTrashCount() > 0 ? 0 : MF_GRAYED, IDM_EMPTY,
                    "Empty Recycle Bin");
        AppendMenuA(m, MF_SEPARATOR, 0, NULL);
        AppendMenuA(m, 0, IDM_REFRESH, "Refresh");
    } else {
        AppendMenuA(m, SHClipHasFiles() ? 0 : MF_GRAYED, IDM_PASTE, "Paste");
        AppendMenuA(m, MF_SEPARATOR, 0, NULL);
        AppendMenuA(m, 0, IDM_NEWFOLDER, "New Folder");
        AppendMenuA(m, 0, IDM_REFRESH, "Refresh");
        AppendMenuA(m, MF_SEPARATOR, 0, NULL);
        AppendMenuA(m, g_sort == 0 ? MF_CHECKED : 0, IDM_SORT_NAME, "Sort by Name");
        AppendMenuA(m, g_sort == 1 ? MF_CHECKED : 0, IDM_SORT_SIZE, "Sort by Size");
        AppendMenuA(m, g_sort == 2 ? MF_CHECKED : 0, IDM_SORT_DATE, "Sort by Date");
        AppendMenuA(m, g_reverse ? MF_CHECKED : 0, IDM_REVERSE, "Reverse Order");
        AppendMenuA(m, g_hidden ? MF_CHECKED : 0, IDM_HIDDEN, "Show Hidden Files");
    }
    int cmd = (int)TrackPopupMenu(m, TPM_RETURNCMD, sx, sy, 0, g_win, NULL);
    DestroyMenu(m);
    if (cmd) SendMessage(g_win, WM_COMMAND, MAKEWPARAM(cmd, 0), 0);
}

static void relayout(HWND h) {
    RECT r;
    GetClientRect(h, &r);
    int w = r.right, hgt = r.bottom;
    /* The STATUSBAR parks itself against the client bottom at its own
     * font-derived height (the notepad idiom): forward WM_SIZE, read the
     * height it chose, and give the list everything above it. */
    int sh = 0;
    if (g_status) {
        SendMessage(g_status, WM_SIZE, 0, 0);
        RECT sr;
        GetWindowRect(g_status, &sr);
        sh = sr.bottom - sr.top;
    }
    MoveWindow(g_path, 4, 3, w - 4 * BTN_W - 24, TOP_H - 6, TRUE);
    MoveWindow(g_go, w - 4 * BTN_W - 16, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_up, w - 3 * BTN_W - 12, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_open, w - 2 * BTN_W - 8, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_with, w - BTN_W - 4, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_list, 4, TOP_H, w - 8, hgt - TOP_H - 4 - sh, TRUE);
}

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        g_path = CreateWindowEx(0, "EDIT", g_cwd, WS_CHILD | WS_VISIBLE,
                                0, 0, 10, 10, h, (HMENU)ID_PATH, NULL, NULL);
        g_go = CreateWindowEx(0, "BUTTON", "Go", WS_CHILD | WS_VISIBLE,
                              0, 0, 10, 10, h, (HMENU)ID_GO, NULL, NULL);
        g_up = CreateWindowEx(0, "BUTTON", "Up", WS_CHILD | WS_VISIBLE,
                              0, 0, 10, 10, h, (HMENU)ID_UP, NULL, NULL);
        g_open = CreateWindowEx(0, "BUTTON", "Open", WS_CHILD | WS_VISIBLE,
                                0, 0, 10, 10, h, (HMENU)ID_OPEN, NULL, NULL);
        g_with = CreateWindowEx(0, "BUTTON", "With", WS_CHILD | WS_VISIBLE,
                                0, 0, 10, 10, h, (HMENU)ID_WITH, NULL, NULL);
        g_list = CreateWindowEx(0, "LISTBOX", "",
                                WS_CHILD | WS_VISIBLE | LBS_NOTIFY | LBS_EXTENDEDSEL,
                                0, 0, 10, 10, h, (HMENU)ID_LIST, NULL, NULL);
        g_status = CreateStatusWindow(WS_CHILD | WS_VISIBLE | CCS_BOTTOM,
                                      NULL, h, ID_STATUS);
        return 0;
    case WM_SIZE:
        relayout(h);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_GO: {
            char buf[512];
            GetWindowText(g_path, buf, sizeof buf);
            navigate(buf);
            return 0;
        }
        case ID_UP:
            go_up();
            return 0;
        case ID_OPEN:
            open_selected();
            return 0;
        case ID_WITH:
            with_selected();
            return 0;
        case ID_LIST:
            if (HIWORD(wp) == LBN_DBLCLK) open_selected();
            else if (HIWORD(wp) == LBN_SELCHANGE) status_update();
            return 0;
        case IDM_OPEN:      open_selected();     return 0;
        case IDM_OPENWITH:  with_selected();     return 0;
        case IDM_EDIT:      edit_selected();     return 0;
        case IDM_CUT:       clip_selected(1);    return 0;
        case IDM_COPY:      clip_selected(0);    return 0;
        case IDM_PASTE:     paste_here();        return 0;
        case IDM_RENAME:    rename_selected();   return 0;
        case IDM_DELETE:    delete_selected(0);  return 0;
        case IDM_DELPERM:   delete_selected(1);  return 0;
        case IDM_RESTORE:   restore_selected();  return 0;
        case IDM_EMPTY:     empty_trash();       return 0;
        case IDM_PROPS:     props_selected();    return 0;
        case IDM_NEWFOLDER: new_folder();        return 0;
        case IDM_REFRESH:   refill();            return 0;
        case IDM_BACK:      go_back();           return 0;
        case IDM_SORT_NAME: g_sort = 0; refill(); return 0;
        case IDM_SORT_SIZE: g_sort = 1; refill(); return 0;
        case IDM_SORT_DATE: g_sort = 2; refill(); return 0;
        case IDM_REVERSE:   g_reverse = !g_reverse; refill(); return 0;
        case IDM_HIDDEN:    g_hidden = !g_hidden; refill(); return 0;
        }
        return 0;
    case WM_CONTEXTMENU:
        ctx_menu(GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
        return 0;
    case WM_FSCHANGE:
        /* FS_WATCH wake (ticket #75): user32 already drained the watch fd
         * and coalesced the episode into one message — just re-list, with
         * the selection carried by name (todos/0123). */
        refill_keep_selection();
        return 0;
    case WM_TIMER:
        reap_kids(&g_nkids);
        return 0;
    case WM_CLOSE:
        DestroyWindow(h);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(int argc, char **argv) {
    if (argc > 1) snprintf(g_cwd, sizeof g_cwd, "%s", argv[1]);
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "FileMan";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    RegisterClass(&wc);
    wc.lpfnWndProc = ow_wndproc;
    wc.lpszClassName = "OpenWith";
    RegisterClass(&wc);
    wc.lpfnWndProc = rn_wndproc;
    wc.lpszClassName = "Rename";
    RegisterClass(&wc);
    g_win = CreateWindowEx(0, "FileMan", "File Manager",
                           WS_OVERLAPPEDWINDOW | WS_THICKFRAME | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT, 480, 360,
                           NULL, NULL, NULL, NULL);
    if (!g_win) return 1;
    refill();
    watch_cwd();                                 /* FS_WATCH auto-refresh (0123) */
    relayout(g_win);
    SetTimer(g_win, 1, 500, NULL);               /* the reap tick */
    /* The op keys (0092), listbox focus only — the path EDIT keeps its
     * own ^C/^X/^V text chords. */
    ACCEL acc[] = {
        { FVIRTKEY, VK_F2, IDM_RENAME },
        { FVIRTKEY, VK_DELETE, IDM_DELETE },
        { FVIRTKEY | FSHIFT, VK_DELETE, IDM_DELPERM },   /* permanent (0093) */
        { FVIRTKEY | FCONTROL, 'C', IDM_COPY },
        { FVIRTKEY | FCONTROL, 'X', IDM_CUT },
        { FVIRTKEY | FCONTROL, 'V', IDM_PASTE },
    };
    g_accel = CreateAcceleratorTableA(acc, 6);
    MSG m;
    while (GetMessage(&m, NULL, 0, 0)) {
        /* Enter/Esc drive the pickers (the single-line EDIT swallows
         * both; no IsDialogMessage in this veneer). */
        HWND top = m.hwnd;
        while (top && GetParent(top)) top = GetParent(top);
        if (m.message == WM_KEYDOWN && top && (top == g_rn_win || top == g_ow_win)) {
            if (m.wParam == VK_RETURN) {
                SendMessage(top, WM_COMMAND,
                            top == g_rn_win ? ID_RN_OK : ID_OW_OK, 0);
                continue;
            }
            if (m.wParam == VK_ESCAPE) { DestroyWindow(top); continue; }
        }
        /* Navigator chords (0106): F5 refresh anywhere; Alt+Left back;
         * on the listbox Enter opens and Backspace goes Up (Win95); Enter
         * in the path bar is Go. */
        if (m.message == WM_KEYDOWN && top == g_win) {
            HWND focus = GetFocus();
            if (m.wParam == VK_F5) { refill(); continue; }
            if (m.wParam == VK_LEFT && (GetKeyState(VK_MENU) & 0x8000)) {
                go_back();
                continue;
            }
            if (focus == g_list) {
                if (m.wParam == VK_RETURN) { open_selected(); continue; }
                if (m.wParam == VK_BACK) { go_up(); continue; }
            } else if (focus == g_path && m.wParam == VK_RETURN) {
                char buf[512];
                GetWindowText(g_path, buf, sizeof buf);
                navigate(buf);
                continue;
            }
        }
        if (g_accel && GetFocus() == g_list &&
            TranslateAcceleratorW(g_win, g_accel, &m))
            continue;
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    return 0;
}
