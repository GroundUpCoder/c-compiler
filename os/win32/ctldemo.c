/* ctldemo.c — the 0058 user32 acceptance app (todos/WIN32.md): a
 * Petzold-style controls + dialog sample, built the CLASSIC way —
 * RegisterClass, CreateWindowEx, and a blocking GetMessage loop in main.
 *
 * The window holds every standard control: STATIC label, single-line
 * EDIT, multiline EDIT, LISTBOX, a vertical SCROLLBAR, a checkbox, and
 * push buttons — "Add" appends the edit text to the listbox, "Greet"
 * prints, "About" opens the MessageBox modal, "Quit" posts WM_QUIT.
 *
 * Every interesting event prints a `ctldemo:` marker to stdout — the
 * headless observable tests/kernel/test_user32_e2e.js asserts (message
 * ORDER at startup is part of the contract: CREATE < SIZE < PAINT).
 * Layout coordinates are load-bearing the same way gdidemo's are: the
 * browser test probes control pixels. Change them together.
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define WIN_W 480
#define WIN_H 360

#define IDC_NAME_LABEL 100
#define IDC_NAME_EDIT  101
#define IDC_NOTES_EDIT 102
#define IDC_LIST       103
#define IDC_SCROLL     104
#define IDC_CHECK      105
#define IDC_DESC_PLAIN 106
#define IDC_DESC_MN    107
#define IDC_DESC_REF   108
#define IDB_ADD        200
#define IDB_GREET      201
#define IDB_ABOUT      202
#define IDB_QUIT       203
#define IDB_OPTIONS    204

/* the Options dialog (0104, template in ctldemo.rc -> ctldemo.res) */
#define IDD_OPTIONS    50
#define IDC_OPT_EDIT   120
#define IDC_OPT_CHECK  121

static int g_painted;

static void mark(const char *what) {
    printf("ctldemo: %s\n", what);
    fflush(stdout);
}

/* The Options dialog (0104): keyboard-driven end to end via
 * IsDialogMessageW in DialogBoxParamW's modal loop. On IDOK it reports the
 * edit text + checkbox so the headless test can observe what the keyboard
 * path produced. */
static LRESULT CALLBACK OptProc(HWND hDlg, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_INITDIALOG:
        mark("opt-init");
        return TRUE;                             /* let the manager set focus */
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDOK: {
            char buf[256];
            GetWindowText(GetDlgItem(hDlg, IDC_OPT_EDIT), buf, sizeof buf);
            printf("ctldemo: opt-ok name='%s' verbose=%d\n",
                   buf, IsDlgButtonChecked(hDlg, IDC_OPT_CHECK) ? 1 : 0);
            fflush(stdout);
            EndDialog(hDlg, IDOK);
            return TRUE;
        }
        case IDCANCEL:
            mark("opt-cancel");
            EndDialog(hDlg, IDCANCEL);
            return TRUE;
        }
        return FALSE;
    }
    return FALSE;
}

static LRESULT CALLBACK MainProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        mark("WM_CREATE");
        CreateWindowEx(0, "STATIC", "Name:", WS_CHILD | WS_VISIBLE,
                       12, 14, 60, 18, hwnd, (HMENU)IDC_NAME_LABEL, NULL, NULL);
        CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE,
                       76, 10, 180, 24, hwnd, (HMENU)IDC_NAME_EDIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Add", WS_CHILD | WS_VISIBLE,
                       268, 10, 60, 24, hwnd, (HMENU)IDB_ADD, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Greet", WS_CHILD | WS_VISIBLE,
                       336, 10, 60, 24, hwnd, (HMENU)IDB_GREET, NULL, NULL);
        CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE,
                       12, 44, 244, 120, hwnd, (HMENU)IDC_LIST, NULL, NULL);
        CreateWindowEx(0, "SCROLLBAR", "", WS_CHILD | WS_VISIBLE | SBS_VERT,
                       264, 44, 16, 120, hwnd, (HMENU)IDC_SCROLL, NULL, NULL);
        /* STATIC vcenter acceptance (0236): two Win95-sized (18px, shorter
         * than the stock glyph cell) single-line labels with descenders —
         * one per static_proc draw branch (plain DrawText vs the '&'
         * mnemonic draw_label_mn path) — plus a tall unclipped reference
         * the pixel test measures the true descender extent against. */
        CreateWindowEx(0, "STATIC", "No gyp", WS_CHILD | WS_VISIBLE,
                       288, 44, 130, 28, hwnd, (HMENU)IDC_DESC_PLAIN, NULL, NULL);
        CreateWindowEx(0, "STATIC", "&No gyp", WS_CHILD | WS_VISIBLE,
                       288, 78, 130, 28, hwnd, (HMENU)IDC_DESC_MN, NULL, NULL);
        CreateWindowEx(0, "STATIC", "No gyp", WS_CHILD | WS_VISIBLE,
                       288, 112, 130, 40, hwnd, (HMENU)IDC_DESC_REF, NULL, NULL);
        CreateWindowEx(0, "EDIT", "line one\nline two",
                       WS_CHILD | WS_VISIBLE | ES_MULTILINE,
                       12, 176, 268, 96, hwnd, (HMENU)IDC_NOTES_EDIT, NULL, NULL);
        /* 20px-font retune: the bottom row was left at Win95 heights (the
         * DESC_* labels above got bumped, this row was missed) — the
         * checkbox clipped its baseline at h=20 and "Options" (7ch = 84px)
         * overflowed a 76px button. Line box = 28px text, 30px buttons;
         * "Options" grows to 96px. */
        CreateWindowEx(0, "BUTTON", "Verbose", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       12, 284, 120, 28, hwnd, (HMENU)IDC_CHECK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Options", WS_CHILD | WS_VISIBLE,
                       140, 284, 96, 30, hwnd, (HMENU)IDB_OPTIONS, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "About", WS_CHILD | WS_VISIBLE,
                       300, 284, 76, 30, hwnd, (HMENU)IDB_ABOUT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Quit", WS_CHILD | WS_VISIBLE,
                       388, 284, 76, 30, hwnd, (HMENU)IDB_QUIT, NULL, NULL);
        SetScrollRange(GetDlgItem(hwnd, IDC_SCROLL), SB_CTL, 0, 20, FALSE);
        return 0;

    case WM_SIZE:
        mark("WM_SIZE");
        return 0;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        if (dc) EndPaint(hwnd, &ps);
        if (!g_painted) {
            g_painted = 1;
            mark("WM_PAINT");
            mark("ready");
        }
        return 0;
    }

    case WM_COMMAND: {
        int id = (int)LOWORD(wp), code = (int)HIWORD(wp);
        if (code == BN_CLICKED) {
            char buf[256];
            switch (id) {
            case IDB_ADD: {
                GetWindowText(GetDlgItem(hwnd, IDC_NAME_EDIT), buf, sizeof buf);
                if (buf[0]) {
                    SendMessage(GetDlgItem(hwnd, IDC_LIST), LB_ADDSTRING, 0, (LPARAM)buf);
                    printf("ctldemo: added '%s'\n", buf);
                    fflush(stdout);
                    SetWindowText(GetDlgItem(hwnd, IDC_NAME_EDIT), "");
                }
                return 0;
            }
            case IDB_GREET: {
                GetWindowText(GetDlgItem(hwnd, IDC_NAME_EDIT), buf, sizeof buf);
                int checked = (int)SendMessage(GetDlgItem(hwnd, IDC_CHECK),
                                               BM_GETCHECK, 0, 0);
                printf("ctldemo: WM_COMMAND Greet name='%s' verbose=%d\n",
                       buf, checked);
                fflush(stdout);
                return 0;
            }
            case IDB_ABOUT: {
                mark("about-opening");
                int r = MessageBox(hwnd, "ctldemo — the 0058 user32 sample.",
                                   "About ctldemo", MB_OKCANCEL);
                printf("ctldemo: msgbox=%d\n", r);
                fflush(stdout);
                return 0;
            }
            case IDB_OPTIONS: {
                mark("options-opening");
                INT_PTR r = DialogBoxParamW(NULL, MAKEINTRESOURCEW(IDD_OPTIONS),
                                            hwnd, OptProc, 0);
                printf("ctldemo: options=%ld\n", (long)r);
                fflush(stdout);
                return 0;
            }
            case IDB_QUIT:
                mark("quit");
                DestroyWindow(hwnd);
                return 0;
            case IDC_CHECK:
                printf("ctldemo: check=%d\n",
                       (int)SendMessage(GetDlgItem(hwnd, IDC_CHECK), BM_GETCHECK, 0, 0));
                fflush(stdout);
                return 0;
            }
        } else if (code == LBN_SELCHANGE && id == IDC_LIST) {
            int sel = (int)SendMessage(GetDlgItem(hwnd, IDC_LIST), LB_GETCURSEL, 0, 0);
            printf("ctldemo: sel=%d\n", sel);
            fflush(stdout);
            return 0;
        } else if (code == LBN_DBLCLK && id == IDC_LIST) {
            mark("list-dblclk");
            return 0;
        } else if (code == EN_CHANGE && id == IDC_NAME_EDIT) {
            /* noisy: only announce when verbose is checked */
            if (SendMessage(GetDlgItem(hwnd, IDC_CHECK), BM_GETCHECK, 0, 0)) {
                char buf[256];
                GetWindowText(GetDlgItem(hwnd, IDC_NAME_EDIT), buf, sizeof buf);
                printf("ctldemo: edit='%s'\n", buf);
                fflush(stdout);
            }
            return 0;
        }
        return 0;
    }

    case WM_VSCROLL: {
        /* The Petzold shape: the control notifies, the app moves it. */
        HWND sb = (HWND)lp;
        int pos = GetScrollPos(sb, SB_CTL);
        switch (LOWORD(wp)) {
        case SB_LINEUP:   pos -= 1; break;
        case SB_LINEDOWN: pos += 1; break;
        case SB_PAGEUP:   pos -= 5; break;
        case SB_PAGEDOWN: pos += 5; break;
        case SB_THUMBTRACK:
        case SB_THUMBPOSITION: pos = (int)HIWORD(wp); break;
        default: return 0;
        }
        SetScrollPos(sb, SB_CTL, pos, TRUE);
        printf("ctldemo: vscroll pos=%d\n", GetScrollPos(sb, SB_CTL));
        fflush(stdout);
        return 0;
    }

    case WM_DESTROY:
        mark("WM_DESTROY");
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

/* ---- `ctldemo selftest` (0211): headless message-level asserts for the
 * EDIT scroll/UTF-8 contracts — WS_HSCROLL bar state, EN_VSCROLL/
 * EN_HSCROLL notifications, Get/SetScrollInfo routing, code-point caret.
 * Everything is SendMessage-synchronous: no pump needed. The kernel e2e
 * (test_user32_e2e.js) runs it and also asserts the fail-loud stderr. */

static int st_fails, st_checks;
static int st_envscroll, st_enhscroll;

static void st_check(const char *name, int cond) {
    st_checks++;
    if (cond) printf("ok %s\n", name);
    else { printf("FAIL %s\n", name); st_fails++; }
}

static LRESULT CALLBACK StProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_COMMAND) {
        if (HIWORD(wp) == EN_VSCROLL) st_envscroll++;
        if (HIWORD(wp) == EN_HSCROLL) st_enhscroll++;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

static int selftest(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = StProc;
    wc.lpszClassName = "ctlselftest";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;
    HWND top = CreateWindowEx(0, "ctlselftest", "selftest",
                              WS_OVERLAPPED | WS_VISIBLE,
                              0, 0, 320, 200, NULL, NULL, NULL, NULL);
    if (!top) return 3;
    HWND ed = CreateWindowEx(0, "EDIT", "",
                             WS_CHILD | WS_VISIBLE | ES_MULTILINE |
                             WS_VSCROLL | WS_HSCROLL | ES_AUTOHSCROLL,
                             10, 10, 200, 100, top, (HMENU)900, NULL, NULL);
    st_check("edit created", ed != NULL);

    /* 30 lines, first one wide (hscroll extent) */
    char text[4096];
    int n = 0;
    for (int i = 0; i < 60; i++) text[n++] = (char)('0' + i % 10);
    for (int i = 1; i < 30; i++)
        n += sprintf(text + n, "\nline %d", i);
    text[n] = 0;
    SetWindowText(ed, text);
    st_check("line count", SendMessage(ed, EM_GETLINECOUNT, 0, 0) == 30);

    /* vertical bar state: WM_SETTEXT resets caret AND view to the start
     * (real-EDIT contract, fixed in the 0222 notepad menu audit) */
    SCROLLINFO si;
    memset(&si, 0, sizeof si);
    si.cbSize = sizeof si;
    si.fMask = SIF_ALL;
    st_check("GetScrollInfo(SB_VERT)", GetScrollInfo(ed, SB_VERT, &si));
    st_check("vbar range", si.nMin == 0 && si.nMax == 29);
    st_check("vbar page", si.nPage > 0 && si.nPage < 30);
    st_check("vbar pos at top", si.nPos == 0);

    /* WM_VSCROLL scrolls and notifies EN_VSCROLL */
    st_envscroll = 0;
    SendMessage(ed, WM_VSCROLL, SB_BOTTOM, 0);
    st_check("SB_BOTTOM scrolled", GetScrollPos(ed, SB_VERT) == 30 - (int)si.nPage);
    st_check("EN_VSCROLL fired", st_envscroll == 1);
    SendMessage(ed, WM_VSCROLL, SB_TOP, 0);
    st_check("SB_TOP scrolled", GetScrollPos(ed, SB_VERT) == 0);
    SendMessage(ed, WM_VSCROLL, SB_LINEDOWN, 0);
    st_check("SB_LINEDOWN", GetScrollPos(ed, SB_VERT) == 1);

    /* WM_HSCROLL scrolls and notifies EN_HSCROLL */
    st_enhscroll = 0;
    SendMessage(ed, WM_HSCROLL, SB_RIGHT, 0);
    int sx = GetScrollPos(ed, SB_HORZ);
    st_check("SB_RIGHT scrolled", sx > 0);
    st_check("EN_HSCROLL fired", st_enhscroll == 1);
    SendMessage(ed, WM_HSCROLL, SB_LEFT, 0);
    st_check("SB_LEFT rewinds", GetScrollPos(ed, SB_HORZ) == 0);

    /* SetScrollInfo is programmatic: positions, no notification */
    st_envscroll = 0;
    memset(&si, 0, sizeof si);
    si.cbSize = sizeof si;
    si.fMask = SIF_POS;
    si.nPos = 5;
    st_check("SetScrollInfo pos", SetScrollInfo(ed, SB_VERT, &si, TRUE) == 5);
    st_check("SetScrollInfo took", GetScrollPos(ed, SB_VERT) == 5);
    st_check("SetScrollInfo silent", st_envscroll == 0);
    st_check("SetScrollRange on EDIT refused",
             SetScrollRange(ed, SB_VERT, 0, 10, FALSE) == FALSE);

    /* UTF-8 caret discipline: chars insert as code points, arrows and
     * backspace step whole code points */
    SetWindowText(ed, "AB");
    SendMessage(ed, EM_SETSEL, 2, 2);
    SendMessage(ed, WM_CHAR, 0xE9, 0);           /* é -> "ABé" */
    char buf[64];
    GetWindowText(ed, buf, sizeof buf);
    st_check("WM_CHAR utf8 insert",
             strcmp(buf, "AB\xC3\xA9") == 0 && strlen(buf) == 4);
    SendMessage(ed, WM_KEYDOWN, VK_LEFT, 0);     /* caret before é */
    SendMessage(ed, WM_CHAR, 'x', 0);            /* "ABxé" */
    GetWindowText(ed, buf, sizeof buf);
    st_check("VK_LEFT steps a whole cp", strcmp(buf, "ABx\xC3\xA9") == 0);
    SendMessage(ed, WM_KEYDOWN, VK_RIGHT, 0);    /* caret past é */
    SendMessage(ed, WM_CHAR, 8, 0);              /* backspace -> "ABx" */
    GetWindowText(ed, buf, sizeof buf);
    st_check("backspace deletes a whole cp", strcmp(buf, "ABx") == 0);

    /* fail-loud probe: a LISTBOX has no SB_VERT plumbing — the call must
     * fail AND say so on stderr (the e2e asserts the stderr line) */
    HWND lb = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE,
                             10, 120, 100, 60, top, (HMENU)901, NULL, NULL);
    st_check("GetScrollPos on LISTBOX fails", GetScrollPos(lb, SB_VERT) == 0);

    printf("ctldemo selftest: %d checks, %d failed\n", st_checks, st_fails);
    fflush(stdout);
    DestroyWindow(top);
    return st_fails ? 1 : 0;
}

/* ---- `ctldemo menudemo` (0211, deepened by 0257): a bar menu with a
 * cascade INSIDE a cascade — three popup levels, the A12 chain acceptance
 * surface (the old engine's one-nested-level cap made level 3
 * unreachable). The e2e opens the popup with a bar click and walks it by
 * keyboard (Down/Right/Enter/Esc); every WM_COMMAND prints its id. */

static LRESULT CALLBACK MenuDemoProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        if (dc) EndPaint(hwnd, &ps);
        if (!g_painted) { g_painted = 1; mark("ready"); }
        return 0;
    }
    case WM_COMMAND:
        printf("ctldemo: cmd=%d\n", (int)LOWORD(wp));
        fflush(stdout);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

static int menudemo(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = MenuDemoProc;
    wc.lpszClassName = "menudemo";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;
    HMENU sub2 = CreatePopupMenu();              /* level 3 (A12) */
    AppendMenuA(sub2, MF_STRING, 304, "Epsilon");
    HMENU sub = CreatePopupMenu();
    AppendMenuA(sub, MF_STRING, 301, "Beta");
    AppendMenuA(sub, MF_STRING, 302, "Gamma");
    AppendMenuA(sub, MF_POPUP, (UINT_PTR)sub2, "Deeper");
    HMENU pop = CreatePopupMenu();
    AppendMenuA(pop, MF_STRING, 300, "Alpha");
    AppendMenuA(pop, MF_POPUP, (UINT_PTR)sub, "More");
    AppendMenuA(pop, MF_SEPARATOR, 0, NULL);
    AppendMenuA(pop, MF_STRING, 303, "Delta");
    HMENU bar = CreateMenu();
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)pop, "Menu");
    /* Small on purpose (0257): the 3-deep cascade must OVERFLOW the
     * window's right edge — the anchored-child fidelity upgrade the e2e
     * pins (the old in-surface engine folded popups back inside). */
    HWND hwnd = CreateWindowEx(0, "menudemo", "Menu Demo",
                               WS_OVERLAPPED | WS_VISIBLE,
                               CW_USEDEFAULT, CW_USEDEFAULT, 180, 120,
                               NULL, NULL, NULL, NULL);
    if (!hwnd) return 3;
    SetMenu(hwnd, bar);
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) return selftest();
    if (argc > 1 && strcmp(argv[1], "menudemo") == 0) return menudemo();
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = MainProc;
    wc.lpszClassName = "ctldemo";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;

    HWND hwnd = CreateWindowEx(0, "ctldemo", "Control Demo",
                               WS_OVERLAPPED | WS_VISIBLE,
                               CW_USEDEFAULT, CW_USEDEFAULT, WIN_W, WIN_H,
                               NULL, NULL, NULL, NULL);
    if (!hwnd) return 3;

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    mark("bye");
    return (int)msg.wParam;
}
