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
#include <shellapi.h>
#include <dirent.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "../openwith.h"

#define ID_PATH 100
#define ID_GO   101
#define ID_UP   102
#define ID_OPEN 103
#define ID_LIST 104
#define ID_WITH 105

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

#define TOP_H  26                    /* the path/button strip */
#define BTN_W  46

static HWND g_win, g_path, g_go, g_up, g_open, g_with, g_list;
static char g_cwd[512] = "/root";
static int g_nkids;

static HWND g_ow_win;                /* the "Open with" picker (one at a time) */
static char g_ow_file[800];          /* the file it targets */

static HWND g_rn_win;                /* the rename dialog (one at a time, 0092) */
static char g_rn_file[800];          /* the file it targets */
static HACCEL g_accel;               /* F2/Del/^C/^X/^V (listbox focus only) */

/* ---- the 0066 activate() shape (wm.c is the reference copy) ---- */

static void spawn_path(const char *path, char *const argv[]) {
    static char *const envp[] = { "PATH=/usr/local/bin:/bin", "HOME=/root", 0 };
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&at, 0);
    pid_t pid;
    if (posix_spawn(&pid, path, 0, &at, (char *const *)argv, envp) == 0) g_nkids++;
    posix_spawnattr_destroy(&at);
}

static void reap_kids(void) {
    int st;
    while (g_nkids > 0 && waitpid(-1, &st, WNOHANG) > 0) g_nkids--;
}

/* Open `path` with a resolved association command (`cmd path`). */
static void spawn_assoc(const char *cmd, const char *path) {
    char buf[512], prog[300];
    char *argv[10];
    if (ow_build(cmd, path, argv, 10, buf, sizeof buf, prog, sizeof prog) > 0)
        spawn_path(prog, argv);
}

/* ---- listing ---- */

typedef struct { char name[240]; int isdir; } Ent;

static int entcmp(const void *a, const void *b) {
    const Ent *ea = (const Ent *)a, *eb = (const Ent *)b;
    if (ea->isdir != eb->isdir) return eb->isdir - ea->isdir;   /* dirs first */
    return strcmp(ea->name, eb->name);
}

static void refill(void) {
    SendMessage(g_list, LB_RESETCONTENT, 0, 0);
    DIR *d = opendir(g_cwd);
    if (!d) {
        SendMessage(g_list, LB_ADDSTRING, 0, (LPARAM)"(cannot open directory)");
        return;
    }
    static Ent ents[512];
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)) && n < 512) {
        /* Dotfiles hidden (0093 — the .recycle store must not clutter
         * /root; Explorer-style, the wm.c desktop rule). Navigation by
         * PATH still reaches them; the 0106 View menu grows the toggle. */
        if (de->d_name[0] == '.') continue;
        char full[768];
        snprintf(full, sizeof full, "%s/%s", g_cwd, de->d_name);
        struct stat st;
        Ent *e = &ents[n++];
        snprintf(e->name, sizeof e->name, "%s", de->d_name);
        e->isdir = stat(full, &st) == 0 && S_ISDIR(st.st_mode);
    }
    closedir(d);
    qsort(ents, (size_t)n, sizeof ents[0], entcmp);
    for (int i = 0; i < n; i++) {
        char row[256];
        snprintf(row, sizeof row, "%s%s", ents[i].name, ents[i].isdir ? "/" : "");
        SendMessage(g_list, LB_ADDSTRING, 0, (LPARAM)row);
    }
    SetWindowText(g_path, g_cwd);
    char title[600];
    snprintf(title, sizeof title, "File Manager - %s", g_cwd);
    SetWindowText(g_win, title);
}

static void navigate(const char *path) {
    char norm[512];
    snprintf(norm, sizeof norm, "%s", path[0] ? path : "/");
    size_t len = strlen(norm);
    while (len > 1 && norm[len - 1] == '/') norm[--len] = 0;   /* trim tail / */
    struct stat st;
    if (stat(norm, &st) != 0 || !S_ISDIR(st.st_mode)) {
        SetWindowText(g_path, g_cwd);                          /* revert */
        return;
    }
    snprintf(g_cwd, sizeof g_cwd, "%s", norm);
    refill();
}

static void go_up(void) {
    char *slash = strrchr(g_cwd, '/');
    if (!slash) return;
    if (slash == g_cwd) g_cwd[1] = 0;            /* parent of /x is / */
    else *slash = 0;
    refill();
}

/* The selected row's full path. Returns 0 with no selection; *isdir tells
 * a directory (the trailing-'/' marker) from a file. */
static int sel_path(char *full, size_t sz, int *isdir) {
    int sel = (int)SendMessage(g_list, LB_GETCURSEL, 0, 0);
    if (sel < 0) return 0;
    char row[256];
    if (SendMessage(g_list, LB_GETTEXT, (WPARAM)sel, (LPARAM)row) == LB_ERR) return 0;
    size_t len = strlen(row);
    *isdir = len && row[len - 1] == '/';
    if (*isdir) row[len - 1] = 0;
    if (!strcmp(g_cwd, "/")) snprintf(full, sz, "/%s", row);
    else snprintf(full, sz, "%s/%s", g_cwd, row);
    return 1;
}

static void open_selected(void) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    if (isdir) { navigate(full); return; }
    /* activate() (0066/0072): runnable spawns, anything else associates */
    struct stat st;
    if (stat(full, &st) == 0 && S_ISREG(st.st_mode) && ow_is_runnable(full)) {
        const char *name = strrchr(full, '/');
        char *argv[2] = { (char *)(name ? name + 1 : full), 0 };
        spawn_path(full, argv);
        return;
    }
    char cmd[OW_CMD_MAX];
    ow_resolve(full, 1 /* GUI context */, cmd, sizeof cmd);
    spawn_assoc(cmd, full);
}

/* ---- the "Open with" picker (todos/0072) ----
 * A small second top-level window: the command EDIT prefilled with the
 * file's effective association, an "Always" checkbox (BS_AUTOCHECKBOX)
 * that persists the pick via ow_set — under the file's extension key, or
 * default.gui for extension-less files — and OK/Cancel. One picker at a
 * time; OK spawns `command file` the same way Open does. */

static LRESULT CALLBACK ow_wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        char key[32], cmd[OW_CMD_MAX], label[64];
        int has_ext = ow_key_for(g_ow_file, key, sizeof key);
        ow_resolve(g_ow_file, 1, cmd, sizeof cmd);
        if (has_ext) snprintf(label, sizeof label, "Always for .%s", key);
        else snprintf(label, sizeof label, "Always (GUI default)");
        const char *base = strrchr(g_ow_file, '/');
        CreateWindowEx(0, "STATIC", base ? base + 1 : g_ow_file,
                       WS_CHILD | WS_VISIBLE, 8, 6, 304, 16, h, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", cmd, WS_CHILD | WS_VISIBLE,
                       8, 26, 304, 20, h, (HMENU)ID_OW_CMD, NULL, NULL);
        CreateWindowEx(0, "BUTTON", label, WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       8, 52, 200, 18, h, (HMENU)ID_OW_ALWAYS, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE,
                       160, 76, 72, 22, h, (HMENU)ID_OW_OK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE,
                       240, 76, 72, 22, h, (HMENU)ID_OW_CANCEL, NULL, NULL);
        return 0;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_OW_OK) {
            char cmd[OW_CMD_MAX];
            GetWindowText(GetDlgItem(h, ID_OW_CMD), cmd, sizeof cmd);
            if (cmd[0]) {
                if (IsDlgButtonChecked(h, ID_OW_ALWAYS)) {
                    char key[32];
                    ow_set(ow_key_for(g_ow_file, key, sizeof key) ? key : "default.gui", cmd);
                }
                spawn_assoc(cmd, g_ow_file);
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
                              CW_USEDEFAULT, CW_USEDEFAULT, 320, 106,
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

/* Cut/Copy: the selected row's full path onto the kernel clipboard slot
 * as a format-2 file list. */
static void clip_selected(int cut) {
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    const char *p = full;
    if (SHClipSetFiles(cut, &p, 1) != 0) op_error("clip", full);
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
    char full[800];
    int isdir;
    if (!sel_path(full, sizeof full, &isdir)) return;
    perm = perm || in_trash();
    const char *base = strrchr(full, '/');
    base = base ? base + 1 : full;
    char msg[900];
    if (perm)
        snprintf(msg, sizeof msg,
                 "Are you sure you want to delete '%s'?", base);
    else
        snprintf(msg, sizeof msg,
                 "Are you sure you want to send '%s' to the Recycle Bin?", base);
    if (MessageBox(g_win, msg,
                   isdir ? "Confirm Folder Delete" : "Confirm File Delete",
                   MB_YESNO) != IDYES)
        return;
    if ((perm ? SHFileDelete(full) : SHFileTrash(full)) != 0)
        op_error("delete", full);
    else if (in_trash())               /* a deleted store entry must not
                                          orphan its sidecar (0093) */
        SHTrashForget(full);
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
        CreateWindowEx(0, "STATIC", label, WS_CHILD | WS_VISIBLE,
                       8, 6, 304, 16, h, NULL, NULL, NULL);
        HWND ed = CreateWindowEx(0, "EDIT", base, WS_CHILD | WS_VISIBLE,
                                 8, 26, 304, 20, h, (HMENU)ID_RN_NAME, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "OK", WS_CHILD | WS_VISIBLE,
                       160, 52, 72, 22, h, (HMENU)ID_RN_OK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE,
                       240, 52, 72, 22, h, (HMENU)ID_RN_CANCEL, NULL, NULL);
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
                              CW_USEDEFAULT, CW_USEDEFAULT, 320, 82,
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
        SendMessage(g_list, LB_SETCURSEL, (WPARAM)(int)(short)LOWORD(hit), 0);
        SetFocus(g_list);
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
    }
    int cmd = (int)TrackPopupMenu(m, TPM_RETURNCMD, sx, sy, 0, g_win, NULL);
    DestroyMenu(m);
    if (cmd) SendMessage(g_win, WM_COMMAND, MAKEWPARAM(cmd, 0), 0);
}

static void relayout(HWND h) {
    RECT r;
    GetClientRect(h, &r);
    int w = r.right, hgt = r.bottom;
    MoveWindow(g_path, 4, 3, w - 4 * BTN_W - 24, TOP_H - 6, TRUE);
    MoveWindow(g_go, w - 4 * BTN_W - 16, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_up, w - 3 * BTN_W - 12, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_open, w - 2 * BTN_W - 8, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_with, w - BTN_W - 4, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_list, 4, TOP_H, w - 8, hgt - TOP_H - 4, TRUE);
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
        g_list = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY,
                                0, 0, 10, 10, h, (HMENU)ID_LIST, NULL, NULL);
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
            return 0;
        case IDM_OPEN:      open_selected();     return 0;
        case IDM_OPENWITH:  with_selected();     return 0;
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
        }
        return 0;
    case WM_CONTEXTMENU:
        ctx_menu(GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
        return 0;
    case WM_TIMER:
        reap_kids();
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
        if (g_accel && GetFocus() == g_list &&
            TranslateAcceleratorW(g_win, g_accel, &m))
            continue;
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    return 0;
}
