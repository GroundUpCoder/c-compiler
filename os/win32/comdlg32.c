/* comdlg32.c — the common dialogs (todos/0048, design todos/WIN32.md).
 *
 * GetOpenFileNameW/GetSaveFileNameW are REAL: a modal file-browser window
 * (own class, the MessageBox owner-disable + pump shape via public user32
 * only) with a directory LISTBOX over opendir/readdir, a filename EDIT,
 * and OK/Cancel. Semantics kept from Windows where they matter to the
 * corpus: OK on a directory navigates, OFN_FILEMUSTEXIST refuses missing
 * files, OFN_OVERWRITEPROMPT asks, lpstrDefExt appends when the basename
 * has no dot. Hooks and custom templates are DELIBERATELY not run (the
 * notepad encoding combo degrades to its previous value) — a hook needs
 * the full explorer-dialog notify protocol; grow it on demand.
 *
 * FindTextW/ReplaceTextW are REAL and modeless: the FINDREPLACEW struct
 * stays the app's, buttons fill lpstrFindWhat/lpstrReplaceWith and send
 * the RegisterWindowMessageW("commdlg_FindReplace") message to the owner
 * with FR_FINDNEXT/FR_REPLACE/FR_REPLACEALL/FR_DIALOGTERM flags — the
 * notepad protocol end to end. Direction is always DOWN (the up/down
 * radios are not worth their pixels here); Match case is honored.
 *
 * ChooseFontW / PrintDlgW / PageSetupDlgW return FALSE (the user
 * "cancelled"): fonts are the one image font and there is no printer —
 * a cancel is the honest answer, and the apps' cancel paths are exactly
 * the well-tested ones. Agent-drivable throughout (OS.md pillar):
 * `wmctl settext EDIT:n` + `wmctl click OK|Open|Save|"Find Next"`. */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <commdlg.h>
#include "win32_internal.h"
#include "../listdir.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* ---- local W<->A helpers (kernel32's boundary, public entry points) ---- */

static char *cd_w2a(LPCWSTR w) {
    if (!w) w = (LPCWSTR)u"";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *out = (char *)malloc(n > 0 ? (size_t)n : 1);
    if (!out) return NULL;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
    else out[0] = 0;
    return out;
}

static int cd_a2w(const char *s, LPWSTR out, int cap) {
    if (!out || cap < 1) return 0;
    int need = MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, NULL, 0);
    if (need <= 0) { out[0] = 0; return 0; }
    WCHAR *tmp = (WCHAR *)malloc((size_t)need * sizeof(WCHAR));
    if (!tmp) { out[0] = 0; return 0; }
    MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, tmp, need);
    int n = need - 1 < cap - 1 ? need - 1 : cap - 1;
    memcpy(out, tmp, (size_t)n * sizeof(WCHAR));
    out[n] = 0;
    free(tmp);
    return n;
}

/* ---- the file dialog ---- */

#define IDC_DIR   100
#define IDC_LIST  101
#define IDC_NAME  102

#define FD_W 380
#define FD_H 300

static struct {
    HWND win, dir, list, name;
    OPENFILENAMEW *ofn;
    int saving;
    int done;                   /* 1 = accepted, -1 = cancelled */
    char cwd[512];
} g_fd;

/* dirs first, then files, both sorted by name */
static int fd_entcmp(const void *a, const void *b) {
    const ld_ent *ea = (const ld_ent *)a, *eb = (const ld_ent *)b;
    if (ea->is_dir != eb->is_dir) return eb->is_dir - ea->is_dir;
    return strcmp(ea->name, eb->name);
}

static void fd_refill(void) {
    SendMessage(g_fd.list, LB_RESETCONTENT, 0, 0);
    SendMessage(g_fd.list, LB_ADDSTRING, 0, (LPARAM)"../");
    /* The walk is os/listdir.h's shared list_dir (CD34); the snapshot is
     * heap-scoped to the refill — the old static names[512][240] put
     * 120 KB of BSS in every app linking the veneer, dialog opened or
     * not (and it's too big for the wasm stack). */
    ld_ent *ents = (ld_ent *)malloc(512 * sizeof *ents);
    if (ents) {
        int n = list_dir(g_fd.cwd, ents, 512, LIST_FOLLOW_LINKS);
        if (n > 0) qsort(ents, (size_t)n, sizeof *ents, fd_entcmp);
        for (int i = 0; i < n; i++) {
            char row[LD_NAME + 4];
            snprintf(row, sizeof row, "%s%s", ents[i].name,
                     ents[i].is_dir ? "/" : "");
            SendMessage(g_fd.list, LB_ADDSTRING, 0, (LPARAM)row);
        }
        free(ents);
    }
    SetWindowText(g_fd.dir, g_fd.cwd);
}

static void fd_navigate(const char *dir) {
    char norm[512];
    snprintf(norm, sizeof norm, "%s", dir[0] ? dir : "/");
    size_t len = strlen(norm);
    while (len > 1 && norm[len - 1] == '/') norm[--len] = 0;
    struct stat st;
    if (stat(norm, &st) != 0 || !S_ISDIR(st.st_mode)) return;
    snprintf(g_fd.cwd, sizeof g_fd.cwd, "%s", norm);
    fd_refill();
}

static void fd_up(void) {
    char *slash = strrchr(g_fd.cwd, '/');
    if (!slash) return;
    if (slash == g_fd.cwd) g_fd.cwd[1] = 0;
    else *slash = 0;
    fd_refill();
}

static void fd_accept(void) {
    char name[512];
    GetWindowText(g_fd.name, name, sizeof name);
    if (!name[0]) return;
    char full[1024];
    if (name[0] == '/') snprintf(full, sizeof full, "%s", name);
    else if (!strcmp(g_fd.cwd, "/")) snprintf(full, sizeof full, "/%s", name);
    else snprintf(full, sizeof full, "%s/%s", g_fd.cwd, name);
    struct stat st;
    if (stat(full, &st) == 0 && S_ISDIR(st.st_mode)) {   /* OK on a dir: enter */
        fd_navigate(full);
        SetWindowText(g_fd.name, "");
        return;
    }
    /* Default extension (0211, the Windows rule): a dotless basename
     * gets lpstrDefExt only when the name AS TYPED doesn't already name
     * an existing file — appending unconditionally made extensionless
     * files (Makefile, README) unopenable by typed name OR dbl-click. */
    int exists = stat(full, &st) == 0;
    const char *base = strrchr(full, '/');
    base = base ? base + 1 : full;
    if (!exists && !strchr(base, '.') && g_fd.ofn->lpstrDefExt) {
        char *ext = cd_w2a(g_fd.ofn->lpstrDefExt);
        if (ext && ext[0]) {
            strncat(full, ".", sizeof full - strlen(full) - 1);
            strncat(full, ext, sizeof full - strlen(full) - 1);
        }
        free(ext);
        if (stat(full, &st) == 0 && S_ISDIR(st.st_mode)) return;
        exists = stat(full, &st) == 0;
    }
    if (!g_fd.saving && (g_fd.ofn->Flags & OFN_FILEMUSTEXIST) && !exists) {
        MessageBox(g_fd.win, "File not found.", "Open", MB_OK);
        return;
    }
    if (g_fd.saving && (g_fd.ofn->Flags & OFN_PATHMUSTEXIST)) {
        /* the parent directory must exist (0211) */
        char dir[1024];
        snprintf(dir, sizeof dir, "%s", full);
        char *slash = strrchr(dir, '/');
        if (slash) {
            if (slash == dir) dir[1] = 0; else *slash = 0;
            struct stat ds;
            if (stat(dir, &ds) != 0 || !S_ISDIR(ds.st_mode)) {
                MessageBox(g_fd.win, "Path does not exist.", "Save As", MB_OK);
                return;
            }
        }
    }
    if (g_fd.saving && (g_fd.ofn->Flags & OFN_OVERWRITEPROMPT) && exists) {
        char q[600];
        snprintf(q, sizeof q, "%s already exists.\nOverwrite?", full);
        if (MessageBox(g_fd.win, q, "Save As", MB_YESNO) != IDYES) return;
    }
    if (strlen(full) + 1 > g_fd.ofn->nMaxFile) {
        /* real: FALSE + FNERR_BUFFERTOOSMALL, never silent truncation */
        WIN32_UNSUPPORTED("GetOpen/SaveFileName: lpstrFile too small "
                          "(need %d)", (int)strlen(full) + 1);
        g_fd.done = -1;
        return;
    }
    cd_a2w(full, g_fd.ofn->lpstrFile, (int)g_fd.ofn->nMaxFile);
    /* nFileOffset: the basename's WCHAR offset (ASCII paths: == bytes) */
    const char *b2 = strrchr(full, '/');
    g_fd.ofn->nFileOffset = (WORD)(b2 ? b2 + 1 - full : 0);
    g_fd.done = 1;
}

static LRESULT CALLBACK fd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDOK:
            fd_accept();
            return 0;
        case IDCANCEL:
            g_fd.done = -1;
            return 0;
        case IDC_LIST: {
            char row[256];
            int sel = (int)SendMessage(g_fd.list, LB_GETCURSEL, 0, 0);
            if (sel < 0 ||
                SendMessage(g_fd.list, LB_GETTEXT, (WPARAM)sel, (LPARAM)row) == LB_ERR)
                return 0;
            size_t len = strlen(row);
            int isdir = len && row[len - 1] == '/';
            if (isdir) row[len - 1] = 0;
            if (HIWORD(wp) == LBN_SELCHANGE) {
                if (!isdir) SetWindowText(g_fd.name, row);
            } else if (HIWORD(wp) == LBN_DBLCLK) {
                if (!strcmp(row, "..")) fd_up();
                else if (isdir) {
                    char full[800];
                    if (!strcmp(g_fd.cwd, "/")) snprintf(full, sizeof full, "/%s", row);
                    else snprintf(full, sizeof full, "%s/%s", g_fd.cwd, row);
                    fd_navigate(full);
                } else {
                    SetWindowText(g_fd.name, row);
                    fd_accept();
                }
            }
            return 0;
        }
        }
        return 0;
    case WM_CLOSE:
        g_fd.done = -1;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static void fd_classes(void) {
    static int done;
    if (done) return;
    done = 1;
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = fd_proc;
    wc.lpszClassName = "WCFileDlg";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    RegisterClass(&wc);
}

static BOOL file_dialog(OPENFILENAMEW *ofn, int saving) {
    if (!ofn || !ofn->lpstrFile || ofn->nMaxFile < 2) return FALSE;
    fd_classes();
    memset(&g_fd, 0, sizeof g_fd);
    g_fd.ofn = ofn;
    g_fd.saving = saving;

    /* initial dir: lpstrInitialDir > lpstrFile's dirname > cwd */
    char *init = ofn->lpstrInitialDir ? cd_w2a(ofn->lpstrInitialDir) : NULL;
    char *seed = ofn->lpstrFile[0] ? cd_w2a(ofn->lpstrFile) : NULL;
    if (init && init[0]) snprintf(g_fd.cwd, sizeof g_fd.cwd, "%s", init);
    else if (seed && seed[0] == '/') {
        snprintf(g_fd.cwd, sizeof g_fd.cwd, "%s", seed);
        char *slash = strrchr(g_fd.cwd, '/');
        if (slash == g_fd.cwd) g_fd.cwd[1] = 0;
        else if (slash) *slash = 0;
    } else if (!getcwd(g_fd.cwd, sizeof g_fd.cwd)) {
        strcpy(g_fd.cwd, "/");
    }
    /* seed the name box with the basename, unless it is a pattern */
    char seedname[256] = "";
    if (seed) {
        const char *b = strrchr(seed, '/');
        b = b ? b + 1 : seed;
        if (!strchr(b, '*') && !strchr(b, '?'))
            snprintf(seedname, sizeof seedname, "%s", b);
    }
    free(init);
    free(seed);

    char *title = ofn->lpstrTitle ? cd_w2a(ofn->lpstrTitle) : NULL;
    g_fd.win = CreateWindowEx(0, "WCFileDlg",
                              title && title[0] ? title : (saving ? "Save As" : "Open"),
                              WS_POPUP | WS_VISIBLE, 0, 0, FD_W, FD_H,
                              NULL, NULL, NULL, NULL);
    free(title);
    if (!g_fd.win) return FALSE;
    CreateWindowEx(0, "STATIC", "Directory:", WS_CHILD | WS_VISIBLE,
                   8, 8, 70, 18, g_fd.win, NULL, NULL, NULL);
    g_fd.dir = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE | ES_READONLY,
                              80, 6, FD_W - 88, 20, g_fd.win, (HMENU)IDC_DIR, NULL, NULL);
    /* keyboard-navigable (0104): the list, name box and buttons are
     * tabstops; the OK/Save button is the default (Enter accepts). */
    g_fd.list = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_TABSTOP,
                               8, 32, FD_W - 16, FD_H - 100, g_fd.win,
                               (HMENU)IDC_LIST, NULL, NULL);
    CreateWindowEx(0, "STATIC", "File name:", WS_CHILD | WS_VISIBLE,
                   8, FD_H - 60, 70, 18, g_fd.win, NULL, NULL, NULL);
    g_fd.name = CreateWindowEx(0, "EDIT", seedname, WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                               80, FD_H - 62, FD_W - 200, 20, g_fd.win,
                               (HMENU)IDC_NAME, NULL, NULL);
    CreateWindowEx(0, "BUTTON", saving ? "Save" : "Open",
                   WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                   FD_W - 112, FD_H - 64, 100, 24, g_fd.win, (HMENU)IDOK, NULL, NULL);
    CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                   FD_W - 112, FD_H - 34, 100, 24, g_fd.win, (HMENU)IDCANCEL, NULL, NULL);
    fd_refill();
    SetFocus(g_fd.name);                          /* type-and-Enter to accept */

    /* the MessageBox modal shape: disable the owner, pump, re-enable */
    HWND owner = ofn->hwndOwner;
    int reenable = 0;
    if (owner && IsWindowEnabled(owner)) {
        EnableWindow(owner, FALSE);
        reenable = 1;
    }
    MSG m;
    memset(&m, 0, sizeof m);
    while (!g_fd.done && IsWindow(g_fd.win) && GetMessage(&m, NULL, 0, 0)) {
        if (IsDialogMessageW(g_fd.win, &m)) continue;   /* Tab/Enter/Esc (0104) */
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (!g_fd.done && m.message == WM_QUIT) PostQuitMessage((int)m.wParam);
    if (reenable && IsWindow(owner)) EnableWindow(owner, TRUE);
    if (IsWindow(g_fd.win)) DestroyWindow(g_fd.win);
    return g_fd.done == 1;
}

BOOL GetOpenFileNameW(OPENFILENAMEW *ofn) { return file_dialog(ofn, 0); }
BOOL GetSaveFileNameW(OPENFILENAMEW *ofn) { return file_dialog(ofn, 1); }

short GetFileTitleW(LPCWSTR file, LPWSTR title, WORD n) {
    if (!file || !title || n < 1) return -1;
    char *a = cd_w2a(file);
    if (!a) return -1;
    const char *base = strrchr(a, '/');
    base = base ? base + 1 : a;
    int need = cd_a2w(base, title, (int)n);
    int full = MultiByteToWideChar(CP_UTF8, 0, base, -1, NULL, 0) - 1;
    free(a);
    return need < full ? (short)(full + 1) : 0;  /* Windows: 0 = ok */
}

/* ---- Find / Replace (modeless) ---- */

#define IDC_WHAT    100
#define IDC_WITH    101
#define IDC_CASE    102
#define IDC_FIND    1
#define IDC_REPL    3
#define IDC_REPLALL 4

static UINT g_frMsg;

static void fr_send(HWND h, DWORD action) {
    FINDREPLACEW *fr = (FINDREPLACEW *)GetWindowLongPtr(h, GWLP_USERDATA);
    if (!fr) return;
    char what[512] = "", with[512] = "";
    HWND we = GetDlgItem(h, IDC_WHAT), re = GetDlgItem(h, IDC_WITH);
    if (we) GetWindowText(we, what, sizeof what);
    if (re) GetWindowText(re, with, sizeof with);
    if (action != FR_DIALOGTERM && !what[0]) return;   /* nothing to find */
    if (fr->lpstrFindWhat && fr->wFindWhatLen)
        cd_a2w(what, fr->lpstrFindWhat, fr->wFindWhatLen);
    if (fr->lpstrReplaceWith && fr->wReplaceWithLen)
        cd_a2w(with, fr->lpstrReplaceWith, fr->wReplaceWithLen);
    int matchcase = IsDlgButtonChecked(h, IDC_CASE) == BST_CHECKED;
    fr->Flags = (fr->Flags & ~(DWORD)(FR_FINDNEXT | FR_REPLACE | FR_REPLACEALL |
                                      FR_DIALOGTERM | FR_MATCHCASE)) |
                FR_DOWN | action | (matchcase ? FR_MATCHCASE : 0);
    SendMessageW(fr->hwndOwner, g_frMsg, 0, (LPARAM)fr);
}

static LRESULT CALLBACK fr_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDC_FIND:    fr_send(h, FR_FINDNEXT); return 0;
        case IDC_REPL:    fr_send(h, FR_REPLACE); return 0;
        case IDC_REPLALL: fr_send(h, FR_REPLACEALL); return 0;
        case IDCANCEL:    SendMessage(h, WM_CLOSE, 0, 0); return 0;
        }
        return 0;
    case WM_CLOSE:
        fr_send(h, FR_DIALOGTERM);               /* the app NULLs its handle */
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static HWND fr_dialog(FINDREPLACEW *fr, int replace) {
    if (!fr || !fr->hwndOwner) return NULL;
    static int registered;
    if (!registered) {
        WNDCLASS wc;
        memset(&wc, 0, sizeof wc);
        wc.lpfnWndProc = fr_proc;
        wc.lpszClassName = "WCFindDlg";
        wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
        RegisterClass(&wc);
        registered = 1;
    }
    g_frMsg = RegisterWindowMessageW(FINDMSGSTRINGW);
    int w = 340, hgt = replace ? 150 : 118;
    HWND dlg = CreateWindowEx(0, "WCFindDlg", replace ? "Replace" : "Find",
                              WS_POPUP | WS_VISIBLE, 0, 0, w, hgt,
                              NULL, NULL, NULL, NULL);
    if (!dlg) return NULL;
    SetWindowLongPtr(dlg, GWLP_USERDATA, (LONG_PTR)fr);
    char what[512] = "";
    if (fr->lpstrFindWhat) {
        char *a = cd_w2a(fr->lpstrFindWhat);
        if (a) { snprintf(what, sizeof what, "%s", a); free(a); }
    }
    CreateWindowEx(0, "STATIC", "Find what:", WS_CHILD | WS_VISIBLE,
                   8, 10, 80, 18, dlg, NULL, NULL, NULL);
    /* keyboard-navigable (0104): the edits + buttons tabstop, Find Next is
     * the default (Enter searches); notepad's main loop pumps it through
     * IsDialogMessage already. */
    CreateWindowEx(0, "EDIT", what, WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                   92, 8, w - 210, 20, dlg, (HMENU)IDC_WHAT, NULL, NULL);
    CreateWindowEx(0, "BUTTON", "Find Next", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                   w - 110, 8, 100, 22, dlg, (HMENU)IDC_FIND, NULL, NULL);
    int y = 34;
    if (replace) {
        char with[512] = "";
        if (fr->lpstrReplaceWith) {
            char *a = cd_w2a(fr->lpstrReplaceWith);
            if (a) { snprintf(with, sizeof with, "%s", a); free(a); }
        }
        CreateWindowEx(0, "STATIC", "Replace with:", WS_CHILD | WS_VISIBLE,
                       8, y + 2, 80, 18, dlg, NULL, NULL, NULL);
        CreateWindowEx(0, "EDIT", with, WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                       92, y, w - 210, 20, dlg, (HMENU)IDC_WITH, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Replace", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                       w - 110, y, 100, 22, dlg, (HMENU)IDC_REPL, NULL, NULL);
        y += 26;
        CreateWindowEx(0, "BUTTON", "Replace All", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                       w - 110, y, 100, 22, dlg, (HMENU)IDC_REPLALL, NULL, NULL);
        y += 26;
    }
    CreateWindowEx(0, "BUTTON", "Match case", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                   8, y + 4, 110, 18, dlg, (HMENU)IDC_CASE, NULL, NULL);
    if (fr->Flags & FR_MATCHCASE) CheckDlgButton(dlg, IDC_CASE, BST_CHECKED);
    CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                   w - 110, hgt - 32, 100, 22, dlg, (HMENU)IDCANCEL, NULL, NULL);
    SetFocus(GetDlgItem(dlg, IDC_WHAT));          /* the find box (0104) */
    return dlg;
}

HWND FindTextW(FINDREPLACEW *fr) { return fr_dialog(fr, 0); }
HWND ReplaceTextW(FINDREPLACEW *fr) { return fr_dialog(fr, 1); }

/* ---- the honest cancels ----
 * Each reports loudly (0211 fail-loud policy) so a menu item landing here
 * reads as a missing feature, not a dead click: there is no printing
 * subsystem (Print/Page Setup), and a real ChooseFont needs per-HWND font
 * plumbing through the control paint paths (todos/0223). */

BOOL ChooseFontW(CHOOSEFONTW *cf) {
    (void)cf;
    WIN32_UNSUPPORTED("ChooseFontW: no font dialog yet (returns cancel)");
    return FALSE;
}
BOOL PrintDlgW(PRINTDLGW *pd) {
    (void)pd;
    WIN32_UNSUPPORTED("PrintDlgW: no printing subsystem (returns cancel)");
    return FALSE;
}
BOOL PageSetupDlgW(PAGESETUPDLGW *psd) {
    (void)psd;
    WIN32_UNSUPPORTED("PageSetupDlgW: no printing subsystem (returns cancel)");
    return FALSE;
}
DWORD CommDlgExtendedError(void) { return 0; }
