/* fileman.c — the file manager (todos/0048, desktop apps wave 1).
 *
 * A Win32 veneer app over plain POSIX dir calls: a path EDIT + Go/Up/Open
 * buttons on top, a LISTBOX of the directory below. Double-click (or the
 * Open button) activates the selection with wm.c's activate() semantics
 * (todos/0066, keep in step): directories navigate, a symlink or runnable
 * regular file (`\0asm` wasm / `#!` script — the kernel spawn dispatch)
 * spawns with its own pgroup + the desktop env, anything else opens in
 * `term vi`. Children are reaped WNOHANG off the idle tick (WM_TIMER).
 *
 * Agent-drivable by construction (OS.md pillar): `wmctl settext EDIT:0
 * /some/dir` + `wmctl click Go` navigates; the LISTBOX text is its items
 * (the user32 WM_GETTEXT convention), so a driver reads the listing
 * without pixels. Built ANSI — POSIX paths are bytes here; no UTF-16
 * boundary to cross. */

#include <windows.h>
#include <dirent.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define ID_PATH 100
#define ID_GO   101
#define ID_UP   102
#define ID_OPEN 103
#define ID_LIST 104

#define TOP_H  26                    /* the path/button strip */
#define BTN_W  46

static HWND g_win, g_path, g_go, g_up, g_open, g_list;
static char g_cwd[512] = "/root";
static int g_nkids;

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

static int is_runnable(const char *path) {       /* kernel _spawnBytes dispatch */
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char b[4];
    size_t n = fread(b, 1, 4, f);
    fclose(f);
    if (n >= 4 && b[0] == 0 && b[1] == 'a' && b[2] == 's' && b[3] == 'm') return 1;
    if (n >= 2 && b[0] == '#' && b[1] == '!') return 1;
    return 0;
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
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
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

static void open_selected(void) {
    int sel = (int)SendMessage(g_list, LB_GETCURSEL, 0, 0);
    if (sel < 0) return;
    char row[256];
    if (SendMessage(g_list, LB_GETTEXT, (WPARAM)sel, (LPARAM)row) == LB_ERR) return;
    size_t len = strlen(row);
    int isdir = len && row[len - 1] == '/';
    if (isdir) row[len - 1] = 0;
    char full[800];
    if (!strcmp(g_cwd, "/")) snprintf(full, sizeof full, "/%s", row);
    else snprintf(full, sizeof full, "%s/%s", g_cwd, row);
    if (isdir) { navigate(full); return; }
    /* activate() (0066): symlink/runnable spawns, anything else -> vi */
    struct stat st;
    if (lstat(full, &st) == 0 &&
        (S_ISLNK(st.st_mode) || (S_ISREG(st.st_mode) && is_runnable(full)))) {
        char *argv[2] = { row, 0 };
        spawn_path(full, argv);
        return;
    }
    char *argv[4] = { "term", "vi", full, 0 };
    spawn_path("/bin/term", argv);
}

static void relayout(HWND h) {
    RECT r;
    GetClientRect(h, &r);
    int w = r.right, hgt = r.bottom;
    MoveWindow(g_path, 4, 3, w - 3 * BTN_W - 20, TOP_H - 6, TRUE);
    MoveWindow(g_go, w - 3 * BTN_W - 12, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_up, w - 2 * BTN_W - 8, 3, BTN_W, TOP_H - 6, TRUE);
    MoveWindow(g_open, w - BTN_W - 4, 3, BTN_W, TOP_H - 6, TRUE);
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
        case ID_LIST:
            if (HIWORD(wp) == LBN_DBLCLK) open_selected();
            return 0;
        }
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
    g_win = CreateWindowEx(0, "FileMan", "File Manager",
                           WS_OVERLAPPEDWINDOW | WS_THICKFRAME | WS_VISIBLE,
                           CW_USEDEFAULT, CW_USEDEFAULT, 480, 360,
                           NULL, NULL, NULL, NULL);
    if (!g_win) return 1;
    refill();
    relayout(g_win);
    SetTimer(g_win, 1, 500, NULL);               /* the reap tick */
    MSG m;
    while (GetMessage(&m, NULL, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    return 0;
}
