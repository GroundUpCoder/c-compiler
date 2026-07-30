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
 * ChooseFontW is REAL (todos/0223): the file-dialog modal shape with a
 * face LISTBOX — one "mono" row: CreateFont resolves faceName against
 * mono/sans/serif since C1/#281, but expanding this list is a
 * dialog-visible change in the ports, so it rides the C2 flag day
 * (#282) — a size EDIT + point-size LISTBOX, and a
 * live sample STATIC driven through WM_SETFONT (dogfooding the 0223
 * user32 plumbing). OK fills the caller's LOGFONTW (negative lfHeight =
 * em px, the CreateFont convention) and returns TRUE.
 *
 * PrintDlgW / PageSetupDlgW return FALSE (the user "cancelled"): there is
 * no printer — a cancel is the honest answer, and the apps' cancel paths
 * are exactly the well-tested ones. Agent-drivable throughout (OS.md
 * pillar): `wmctl settext EDIT:n` + `wmctl click OK|Open|Save|"Find Next"`. */

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

#define FD_W 460
#define FD_H 340
#define FD_MAX_ENT 512   /* listing snapshot capacity; past it fd_refill
                            renders an explicit "(N more...)" row (0255) */

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
     * not (and it's too big for the wasm stack). Every way the listing
     * can come up short is a VISIBLE row (todos/0255): an OOM or an
     * unopenable directory must not read as an empty one, and a
     * capacity-clipped listing must not read as complete. */
    ld_ent *ents = (ld_ent *)malloc(FD_MAX_ENT * sizeof *ents);
    if (!ents) {
        SendMessage(g_fd.list, LB_ADDSTRING, 0,
                    (LPARAM)"(cannot allocate directory listing)");
    } else {
        int n = list_dir(g_fd.cwd, ents, FD_MAX_ENT, LIST_FOLLOW_LINKS);
        if (n < 0) {
            SendMessage(g_fd.list, LB_ADDSTRING, 0,
                        (LPARAM)"(cannot open directory)");
        } else {
            int shown = n < FD_MAX_ENT ? n : FD_MAX_ENT;
            if (shown > 0) qsort(ents, (size_t)shown, sizeof *ents, fd_entcmp);
            for (int i = 0; i < shown; i++) {
                char row[LD_NAME + 4];
                snprintf(row, sizeof row, "%s%s", ents[i].name,
                         ents[i].is_dir ? "/" : "");
                SendMessage(g_fd.list, LB_ADDSTRING, 0, (LPARAM)row);
            }
            if (n > shown) {
                char row[48];
                snprintf(row, sizeof row, "(%d more entries not shown)",
                         n - shown);
                SendMessage(g_fd.list, LB_ADDSTRING, 0, (LPARAM)row);
            }
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
    /* 20px-font retune: the row labels ("Directory:"/"File name:" = ~120px
     * at 12px/char) overflowed a 70px STATIC under the x=80 EDIT, so widen
     * the label column to 130 and start the fields at x=142; controls are
     * a 30px line box, buttons 30px. The list height snaps to a whole
     * number of item rows (rh = tmHeight+2, the user32 lb_row_h formula) so
     * the last row is never a clipped sliver. */
    int rh = 30;                                 /* fallback = 20px-font row */
    { HDC mdc = GetDC(g_fd.win);
      if (mdc) { TEXTMETRIC tm;
                 if (GetTextMetrics(mdc, &tm)) rh = tm.tmHeight + 2;
                 ReleaseDC(g_fd.win, mdc); } }
    int listTop = 42, listBot = FD_H - 78;       /* name row starts at -72 */
    int listH = ((listBot - listTop) / rh) * rh; /* whole rows only */
    CreateWindowEx(0, "STATIC", "Directory:", WS_CHILD | WS_VISIBLE,
                   8, 8, 130, 28, g_fd.win, NULL, NULL, NULL);
    g_fd.dir = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE | ES_READONLY,
                              142, 6, FD_W - 150, 30, g_fd.win, (HMENU)IDC_DIR, NULL, NULL);
    /* keyboard-navigable (0104): the list, name box and buttons are
     * tabstops; the OK/Save button is the default (Enter accepts). */
    g_fd.list = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_TABSTOP,
                               8, listTop, FD_W - 16, listH, g_fd.win,
                               (HMENU)IDC_LIST, NULL, NULL);
    CreateWindowEx(0, "STATIC", "File name:", WS_CHILD | WS_VISIBLE,
                   8, FD_H - 70, 130, 28, g_fd.win, NULL, NULL, NULL);
    g_fd.name = CreateWindowEx(0, "EDIT", seedname, WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                               142, FD_H - 72, FD_W - 272, 30, g_fd.win,
                               (HMENU)IDC_NAME, NULL, NULL);
    CreateWindowEx(0, "BUTTON", saving ? "Save" : "Open",
                   WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                   FD_W - 120, FD_H - 72, 108, 30, g_fd.win, (HMENU)IDOK, NULL, NULL);
    CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                   FD_W - 120, FD_H - 38, 108, 30, g_fd.win, (HMENU)IDCANCEL, NULL, NULL);
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

/* ---- the font dialog (todos/0223) ----
 * The file_dialog shape verbatim: own class + WS_POPUP top-level, child
 * controls, the MessageBox owner-disable + local pump. ONE face row
 * ("mono" — CreateFont is multi-face since C1/#281; the list expansion
 * is deferred to the C2 flag day (#282), see the header note), a size
 * EDIT + the classic point-size list, a live sample STATIC re-fonted via
 * WM_SETFONT on every size change (the 0223 user32 plumbing, dogfooded
 * here), OK/Cancel. Sizes are POINTS at the synthetic 96dpi
 * (GetDeviceCaps LOGPIXELSY): px = pt * 96 / 72. */

#define IDC_FACE   110
#define IDC_SIZEED 111
#define IDC_SIZES  112
#define IDC_SAMPLE 113

#define CFD_W 380
#define CFD_H 380

/* the classic list, plus 15 — the stock 20px cell is 15pt at 96dpi, so
 * the platform default preselects a real row */
static const int cf_ptsizes[] =
    { 8, 9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72 };
#define CF_NSIZES ((int)(sizeof cf_ptsizes / sizeof cf_ptsizes[0]))

static struct {
    HWND win, face, sizeEd, sizes, sample;
    CHOOSEFONTW *cf;
    HFONT sampleFont;           /* transient preview HFONT (we own this one) */
    int done;                   /* 1 = accepted, -1 = cancelled */
} g_cf;

/* Selected point size, or 0 when the EDIT doesn't hold a usable number. */
static int cf_cur_pt(void) {
    char s[16];
    GetWindowText(g_cf.sizeEd, s, sizeof s);
    int pt = atoi(s);
    return pt >= 1 && pt <= 999 ? pt : 0;
}

/* Re-font the sample through WM_SETFONT — the exact consumer contract
 * (ChooseFont -> CreateFontIndirect -> WM_SETFONT) the caller will run. */
static void cf_preview(void) {
    int pt = cf_cur_pt();
    if (!pt) return;
    HFONT nf = CreateFont(-MulDiv(pt, 96, 72), 0, 0, 0, FW_NORMAL,
                          0, 0, 0, 0, 0, 0, 0, 0, "mono");
    if (!nf) return;
    SendMessage(g_cf.sample, WM_SETFONT, (WPARAM)nf, TRUE);
    if (g_cf.sampleFont) DeleteObject((HGDIOBJ)g_cf.sampleFont);
    g_cf.sampleFont = nf;
}

static void cf_accept(void) {
    int pt = cf_cur_pt();
    if (!pt) return;                             /* no size: stay open */
    LOGFONTW *lf = g_cf.cf->lpLogFont;
    lf->lfHeight = -MulDiv(pt, 96, 72);          /* negative = em px, the
                                                    CreateFont convention */
    lf->lfWidth = 0;
    char face[64] = "mono";
    int sel = (int)SendMessage(g_cf.face, LB_GETCURSEL, 0, 0);
    if (sel >= 0)
        SendMessage(g_cf.face, LB_GETTEXT, (WPARAM)sel, (LPARAM)face);
    cd_a2w(face, lf->lfFaceName, LF_FACESIZE);
    g_cf.cf->iPointSize = pt * 10;               /* tenths, per the contract */
    g_cf.done = 1;
}

static LRESULT CALLBACK cf_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDOK:
            cf_accept();
            return 0;
        case IDCANCEL:
            g_cf.done = -1;
            return 0;
        case IDC_SIZES: {
            char row[16];
            int sel = (int)SendMessage(g_cf.sizes, LB_GETCURSEL, 0, 0);
            if (sel < 0 ||
                SendMessage(g_cf.sizes, LB_GETTEXT, (WPARAM)sel, (LPARAM)row) == LB_ERR)
                return 0;
            if (HIWORD(wp) == LBN_SELCHANGE)
                SetWindowText(g_cf.sizeEd, row);  /* EN_CHANGE previews */
            else if (HIWORD(wp) == LBN_DBLCLK) {
                SetWindowText(g_cf.sizeEd, row);
                cf_accept();
            }
            return 0;
        }
        case IDC_SIZEED:
            if (HIWORD(wp) == EN_CHANGE) cf_preview();
            return 0;
        }
        return 0;
    case WM_CLOSE:
        g_cf.done = -1;
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

static void cf_class(void) {
    static int done;
    if (done) return;
    done = 1;
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = cf_proc;
    wc.lpszClassName = "WCFontDlg";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    RegisterClass(&wc);
}

BOOL ChooseFontW(CHOOSEFONTW *cf) {
    if (!cf || !cf->lpLogFont) return FALSE;
    cf_class();
    memset(&g_cf, 0, sizeof g_cf);
    g_cf.cf = cf;

    /* Initial size: CF_INITTOLOGFONTSTRUCT reads the incoming LOGFONT
     * (lfHeight < 0 = em px; > 0 = cell height, taken as px — close
     * enough for a preselect; 0 = default). Default = the 20px stock
     * (gdi32 STOCK_FONT_PX) = 15pt at 96dpi. */
    int px = 20;
    if ((cf->Flags & CF_INITTOLOGFONTSTRUCT) && cf->lpLogFont->lfHeight)
        px = cf->lpLogFont->lfHeight < 0 ? -cf->lpLogFont->lfHeight
                                         : cf->lpLogFont->lfHeight;
    int pt0 = MulDiv(px, 72, 96);
    if (pt0 < 1) pt0 = 15;

    g_cf.win = CreateWindowEx(0, "WCFontDlg", "Font",
                              WS_POPUP | WS_VISIBLE, 0, 0, CFD_W, CFD_H,
                              NULL, NULL, NULL, NULL);
    if (!g_cf.win) return FALSE;
    /* the fd row-height snap: lists show whole rows only */
    int rh = 30;
    { HDC mdc = GetDC(g_cf.win);
      if (mdc) { TEXTMETRIC tm;
                 if (GetTextMetrics(mdc, &tm)) rh = tm.tmHeight + 2;
                 ReleaseDC(g_cf.win, mdc); } }
    int listTop = 66, listBot = CFD_H - 140;     /* sample sits below */
    int listH = ((listBot - listTop) / rh) * rh;
    CreateWindowEx(0, "STATIC", "Font:", WS_CHILD | WS_VISIBLE,
                   8, 8, 150, 28, g_cf.win, NULL, NULL, NULL);
    g_cf.face = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_TABSTOP,
                               8, listTop, 190, listH, g_cf.win,
                               (HMENU)IDC_FACE, NULL, NULL);
    CreateWindowEx(0, "STATIC", "Size:", WS_CHILD | WS_VISIBLE,
                   210, 8, 80, 28, g_cf.win, NULL, NULL, NULL);
    g_cf.sizeEd = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                                 210, 34, 80, 30, g_cf.win,
                                 (HMENU)IDC_SIZEED, NULL, NULL);
    g_cf.sizes = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_TABSTOP,
                                210, listTop, 80, listH, g_cf.win,
                                (HMENU)IDC_SIZES, NULL, NULL);
    CreateWindowEx(0, "STATIC", "Sample:", WS_CHILD | WS_VISIBLE,
                   8, CFD_H - 136, 150, 28, g_cf.win, NULL, NULL, NULL);
    g_cf.sample = CreateWindowEx(0, "STATIC", "AaBbYyZz", WS_CHILD | WS_VISIBLE | SS_SUNKEN,
                                 8, CFD_H - 108, CFD_W - 16, 64, g_cf.win,
                                 (HMENU)IDC_SAMPLE, NULL, NULL);
    CreateWindowEx(0, "BUTTON", "OK",
                   WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                   CFD_W - 220, CFD_H - 38, 100, 30, g_cf.win, (HMENU)IDOK, NULL, NULL);
    CreateWindowEx(0, "BUTTON", "Cancel", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                   CFD_W - 112, CFD_H - 38, 104, 30, g_cf.win, (HMENU)IDCANCEL, NULL, NULL);

    /* ONE face today (single-family platform; see the header comment) */
    SendMessage(g_cf.face, LB_ADDSTRING, 0, (LPARAM)"mono");
    SendMessage(g_cf.face, LB_SETCURSEL, 0, 0);
    for (int i = 0; i < CF_NSIZES; i++) {
        char row[16];
        snprintf(row, sizeof row, "%d", cf_ptsizes[i]);
        SendMessage(g_cf.sizes, LB_ADDSTRING, 0, (LPARAM)row);
        if (cf_ptsizes[i] == pt0)
            SendMessage(g_cf.sizes, LB_SETCURSEL, (WPARAM)i, 0);
    }
    { char seed[16];
      snprintf(seed, sizeof seed, "%d", pt0);
      SetWindowText(g_cf.sizeEd, seed); }        /* EN_CHANGE seeds the sample */
    SetFocus(g_cf.sizeEd);                       /* type-and-Enter accepts */

    /* the MessageBox modal shape: disable the owner, pump, re-enable */
    HWND owner = cf->hwndOwner;
    int reenable = 0;
    if (owner && IsWindowEnabled(owner)) {
        EnableWindow(owner, FALSE);
        reenable = 1;
    }
    MSG m;
    memset(&m, 0, sizeof m);
    while (!g_cf.done && IsWindow(g_cf.win) && GetMessage(&m, NULL, 0, 0)) {
        if (IsDialogMessageW(g_cf.win, &m)) continue;
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    if (!g_cf.done && m.message == WM_QUIT) PostQuitMessage((int)m.wParam);
    if (reenable && IsWindow(owner)) EnableWindow(owner, TRUE);
    if (IsWindow(g_cf.win)) DestroyWindow(g_cf.win);
    if (g_cf.sampleFont) DeleteObject((HGDIOBJ)g_cf.sampleFont);
    return g_cf.done == 1;
}

/* ---- the honest cancels ----
 * Each reports loudly (0211 fail-loud policy) so a menu item landing here
 * reads as a missing feature, not a dead click: there is no printing
 * subsystem (Print/Page Setup). */

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
