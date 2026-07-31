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
#include <commctrl.h>
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
#define IDC_DESC_CHK   109
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
        /* BS_NOTIFY (#343): Greet is the real-input BN_DBLCLK probe — the
         * e2e injects a genuine double-click and asserts greet-dblclk. */
        CreateWindowEx(0, "BUTTON", "Greet", WS_CHILD | WS_VISIBLE | BS_NOTIFY,
                       336, 10, 60, 24, hwnd, (HMENU)IDB_GREET, NULL, NULL);
        CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE | WS_VSCROLL,
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
        /* check/radio label vcenter acceptance (0278, the 0236 pattern):
         * a 28px descender-labelled checkbox — the pixel test measures its
         * label's descender extent against IDC_DESC_REF. Created LAST so
         * existing BUTTON:n agent indices stay stable. */
        CreateWindowEx(0, "BUTTON", "No gyp", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       288, 160, 130, 28, hwnd, (HMENU)IDC_DESC_CHK, NULL, NULL);
        SetScrollRange(GetDlgItem(hwnd, IDC_SCROLL), SB_CTL, 0, 20, FALSE);
        /* Advance geometry of the "No gyp" descender labels, in the
         * STATIC's own font (C2, #282): the pixel test derives its
         * measuring columns from these instead of mono-cell constants —
         * the stock font is proportional now, so per-glyph column
         * positions are a property of the live face. */
        {
            HWND ds = GetDlgItem(hwnd, IDC_DESC_PLAIN);
            HDC gdc = GetDC(ds);
            SIZE sN, sNo, sNoSp, sFull;
            if (gdc &&
                GetTextExtentPoint32(gdc, "N", 1, &sN) &&
                GetTextExtentPoint32(gdc, "No", 2, &sNo) &&
                GetTextExtentPoint32(gdc, "No ", 3, &sNoSp) &&
                GetTextExtentPoint32(gdc, "No gyp", 6, &sFull))
                printf("ctldemo: descgeom N=%d No=%d NoSp=%d full=%d\n",
                       (int)sN.cx, (int)sNo.cx, (int)sNoSp.cx, (int)sFull.cx);
            if (gdc) ReleaseDC(ds, gdc);
        }
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
        } else if (code == BN_DBLCLK && id == IDB_GREET) {
            mark("greet-dblclk");                /* BS_NOTIFY (#343) */
            return 0;
        } else if (code == LBN_SELCHANGE && id == IDC_LIST) {
            HWND lb = GetDlgItem(hwnd, IDC_LIST);
            int sel = (int)SendMessage(lb, LB_GETCURSEL, 0, 0);
            /* top makes scroll position observable to the e2e (0275) */
            printf("ctldemo: sel=%d top=%d\n", sel,
                   (int)SendMessage(lb, LB_GETTOPINDEX, 0, 0));
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
/* BN_* notification counters (#343), per the two probe buttons: ids 910
 * (BS_NOTIFY) and 911 (plain). */
static int st_bnclick, st_bnset, st_bnkill, st_bndbl;

static void st_check(const char *name, int cond) {
    st_checks++;
    if (cond) printf("ok %s\n", name);
    else { printf("FAIL %s\n", name); st_fails++; }
}

static void st_bn_reset(void) {
    st_bnclick = st_bnset = st_bnkill = st_bndbl = 0;
}

static LRESULT CALLBACK StProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_COMMAND) {
        if (HIWORD(wp) == EN_VSCROLL) st_envscroll++;
        if (HIWORD(wp) == EN_HSCROLL) st_enhscroll++;
        if (LOWORD(wp) == 910 || LOWORD(wp) == 911) {
            switch (HIWORD(wp)) {
            case BN_CLICKED:   st_bnclick++; break;
            case BN_SETFOCUS:  st_bnset++;   break;
            case BN_KILLFOCUS: st_bnkill++;  break;
            case BN_DBLCLK:    st_bndbl++;   break;
            }
        }
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

    /* ---- tab expansion (0274): a literal '\t' advances to the next tab
     * stop, so mouse column mapping across a tab is a WIDE gap, not one
     * glyph. Default stop = 8 avg-char columns; EM_SETTABSTOPS overrides
     * it. All synchronous WM_LBUTTONDOWN + EM_GETSEL — the '?'-free paint
     * leg is the browser sweep (os-edittab.mjs). */
    HDC mdc = GetDC(ed);
    TEXTMETRIC tmv;
    GetTextMetrics(mdc, &tmv);
    ReleaseDC(ed, mdc);
    int avg = tmv.tmAveCharWidth > 0 ? (int)tmv.tmAveCharWidth : 8;
    int pad = 3;                                  /* mirrors EDIT_PAD in user32.c */
    SetWindowText(ed, "a\tb");                    /* col0 'a', col1 tab, col2 'b' */
    /* click at client (px, y=5 on line 0) then read the collapsed caret */
#define TAB_CARET(px) (SendMessage(ed, WM_LBUTTONDOWN, 0, MAKELPARAM((px), 5)), \
                       (int)LOWORD(SendMessage(ed, EM_GETSEL, 0, 0)))
    int c_a   = TAB_CARET(pad + 1);              /* on 'a' */
    int c_gap = TAB_CARET(pad + 3 * avg);        /* near half of the tab gap */
    int c_far = TAB_CARET(pad + 7 * avg);        /* far half of the tab gap */
    int c_b   = TAB_CARET(pad + 8 * avg + 2);    /* on 'b', past the stop */
    printf("ctldemo tabmap: a=%d gap=%d far=%d b=%d avg=%d\n",
           c_a, c_gap, c_far, c_b, avg);
    fflush(stdout);
    st_check("tab: click on 'a' -> caret 0", c_a == 0);
    st_check("tab: near-gap click lands before tab (col 1)", c_gap == 1);
    st_check("tab: far-gap click lands after tab (col 2)", c_far == 2);
    st_check("tab: click on 'b' -> caret 2", c_b == 2);
    /* EM_SETTABSTOPS: a 4-char stop (16 dialog units) narrows the grid, so
     * the same near-gap pixel now falls PAST the tab (col 2). */
    int stops[1] = { 16 };
    st_check("EM_SETTABSTOPS accepted",
             SendMessage(ed, EM_SETTABSTOPS, 1, (LPARAM)stops) == TRUE);
    SetWindowText(ed, "a\tb");
    st_check("EM_SETTABSTOPS narrows the stop", TAB_CARET(pad + 3 * avg) == 2);
    SendMessage(ed, EM_SETTABSTOPS, 0, 0);        /* back to the default grid */
#undef TAB_CARET

    /* ---- WM_SETFONT (0223): the per-HWND font drives BOTH raster and
     * measure — GetDC on the control hands back a DC with the set font
     * selected, so tmHeight, text extents, visible rows (the vbar page)
     * and caret x math all move together. Metrics-level proof independent
     * of notepad (the pixel leg lives in test_notepad_menu_e2e.js). */
    SetWindowText(ed, text);                      /* the 30-line corpus again */
    HDC fdc = GetDC(ed);
    TEXTMETRIC ftm0, ftm1;
    SIZE fex0, fex1;
    GetTextMetrics(fdc, &ftm0);
    GetTextExtentPoint32(fdc, "MMMM", 4, &fex0);
    ReleaseDC(ed, fdc);
    memset(&si, 0, sizeof si);
    si.cbSize = sizeof si;
    si.fMask = SIF_ALL;
    GetScrollInfo(ed, SB_VERT, &si);
    int fpage0 = (int)si.nPage;
    st_check("WM_GETFONT default is NULL",
             SendMessage(ed, WM_GETFONT, 0, 0) == 0);
    HFONT big = CreateFont(-2 * (int)ftm0.tmHeight, 0, 0, 0, FW_NORMAL,
                           0, 0, 0, 0, 0, 0, 0, 0, "mono");
    st_check("CreateFont(2x em)", big != NULL);
    SendMessage(ed, WM_SETFONT, (WPARAM)big, TRUE);
    st_check("WM_GETFONT returns the set font",
             (HFONT)SendMessage(ed, WM_GETFONT, 0, 0) == big);
    fdc = GetDC(ed);
    GetTextMetrics(fdc, &ftm1);
    GetTextExtentPoint32(fdc, "MMMM", 4, &fex1);
    ReleaseDC(ed, fdc);
    st_check("control DC tmHeight follows WM_SETFONT", ftm1.tmHeight > ftm0.tmHeight);
    st_check("control DC extents follow WM_SETFONT", fex1.cx > fex0.cx);
    memset(&si, 0, sizeof si);
    si.cbSize = sizeof si;
    si.fMask = SIF_ALL;
    GetScrollInfo(ed, SB_VERT, &si);
    st_check("visible rows (vbar page) shrink under the bigger font",
             (int)si.nPage < fpage0 && si.nPage > 0);
    SendMessage(ed, WM_SETFONT, 0, 0);            /* NULL = stock default */
    fdc = GetDC(ed);
    GetTextMetrics(fdc, &ftm1);
    ReleaseDC(ed, fdc);
    st_check("WM_SETFONT NULL restores stock metrics",
             ftm1.tmHeight == ftm0.tmHeight);
    st_check("DeleteObject on the deselected font", DeleteObject((HGDIOBJ)big));

    /* ---- single-level undo (0135): the Win95 one-record model. EM_CANUNDO
     * arms on every user edit path, EM_UNDO restores the pre-edit text AND
     * selection, a second EM_UNDO re-applies (the undo/undo toggle), and
     * programmatic writes (WM_SETTEXT, EM_SETHANDLE, non-undoable
     * EM_REPLACESEL, EM_EMPTYUNDOBUFFER) clear the record. */
    SetWindowText(ed, "abc");
    st_check("undo: WM_SETTEXT leaves nothing to undo",
             SendMessage(ed, EM_CANUNDO, 0, 0) == FALSE);
    st_check("undo: EM_UNDO with no record refuses",
             SendMessage(ed, EM_UNDO, 0, 0) == FALSE);
    SendMessage(ed, EM_SETSEL, 3, 3);
    SendMessage(ed, WM_CHAR, 'x', 0);            /* "abcx" */
    st_check("undo: typing arms EM_CANUNDO",
             SendMessage(ed, EM_CANUNDO, 0, 0) == TRUE);
    st_check("undo: EM_UNDO returns TRUE",
             SendMessage(ed, EM_UNDO, 0, 0) == TRUE);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: EM_UNDO removes the typed char", strcmp(buf, "abc") == 0);
    st_check("undo: EM_UNDO restores the pre-edit caret",
             SendMessage(ed, EM_GETSEL, 0, 0) == MAKELONG(3, 3));
    st_check("undo: still undoable after undo (the toggle is armed)",
             SendMessage(ed, EM_CANUNDO, 0, 0) == TRUE);
    SendMessage(ed, EM_UNDO, 0, 0);              /* undo the undo */
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: second EM_UNDO re-applies (undo/undo toggle)",
             strcmp(buf, "abcx") == 0);
    st_check("undo: the toggle restores the post-edit caret",
             SendMessage(ed, EM_GETSEL, 0, 0) == MAKELONG(4, 4));
    /* backspace + selection-replace record too */
    SetWindowText(ed, "hello");
    SendMessage(ed, EM_SETSEL, 5, 5);
    SendMessage(ed, WM_CHAR, 8, 0);              /* "hell" */
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: backspace undoes", strcmp(buf, "hello") == 0);
    SetWindowText(ed, "hello");
    SendMessage(ed, EM_SETSEL, 1, 4);            /* "ell" selected */
    SendMessage(ed, WM_CHAR, 'X', 0);            /* "hXo" */
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: replace-selection restores the text",
             strcmp(buf, "hello") == 0);
    st_check("undo: replace-selection restores the selection",
             SendMessage(ed, EM_GETSEL, 0, 0) == MAKELONG(1, 4));
    /* WM_CUT / WM_PASTE / WM_CLEAR ride the same record */
    SetWindowText(ed, "cutme");
    SendMessage(ed, EM_SETSEL, 0, 3);
    SendMessage(ed, WM_CUT, 0, 0);               /* "me", clip = "cut" */
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: WM_CUT undoes", strcmp(buf, "cutme") == 0);
    SendMessage(ed, EM_SETSEL, 5, 5);
    SendMessage(ed, WM_PASTE, 0, 0);             /* "cutmecut" */
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: WM_PASTE pasted the cut text",
             strcmp(buf, "cutmecut") == 0);
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: WM_PASTE undoes", strcmp(buf, "cutme") == 0);
    SendMessage(ed, EM_SETSEL, 0, 2);
    SendMessage(ed, WM_CLEAR, 0, 0);             /* "tme" */
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: WM_CLEAR undoes", strcmp(buf, "cutme") == 0);
    /* EM_REPLACESEL honours its can-undo wParam */
    SetWindowText(ed, "base");
    SendMessage(ed, EM_SETSEL, 4, 4);
    SendMessage(ed, EM_REPLACESEL, TRUE, (LPARAM)"+tail");
    st_check("undo: undoable EM_REPLACESEL arms",
             SendMessage(ed, EM_CANUNDO, 0, 0) == TRUE);
    SendMessage(ed, EM_UNDO, 0, 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("undo: EM_REPLACESEL(TRUE) undoes", strcmp(buf, "base") == 0);
    SendMessage(ed, EM_REPLACESEL, FALSE, (LPARAM)"+quiet");
    st_check("undo: EM_REPLACESEL(FALSE) leaves nothing to undo",
             SendMessage(ed, EM_CANUNDO, 0, 0) == FALSE);
    /* the explicit clears */
    SendMessage(ed, WM_CHAR, 'q', 0);
    st_check("undo: typing re-arms", SendMessage(ed, EM_CANUNDO, 0, 0) == TRUE);
    SendMessage(ed, EM_EMPTYUNDOBUFFER, 0, 0);
    st_check("undo: EM_EMPTYUNDOBUFFER clears",
             SendMessage(ed, EM_CANUNDO, 0, 0) == FALSE);
    SendMessage(ed, WM_CHAR, 'q', 0);
    SendMessage(ed, EM_SETHANDLE,
                SendMessage(ed, EM_GETHANDLE, 0, 0), 0);
    st_check("undo: EM_SETHANDLE clears",
             SendMessage(ed, EM_CANUNDO, 0, 0) == FALSE);

    /* fail-loud probe: a LISTBOX WITHOUT WS_VSCROLL has no SB_VERT bar —
     * the call must fail AND say so on stderr (the e2e asserts the
     * stderr line) */
    HWND lb = CreateWindowEx(0, "LISTBOX", "", WS_CHILD | WS_VISIBLE,
                             10, 120, 100, 60, top, (HMENU)901, NULL, NULL);
    st_check("GetScrollPos on LISTBOX fails", GetScrollPos(lb, SB_VERT) == 0);

    /* the built-in LISTBOX WS_VSCROLL bar (0275): programmatic contract.
     * 7 items in a 60px box overflow at any live font, so the bar shows. */
    HWND slb = CreateWindowEx(0, "LISTBOX", "",
                              WS_CHILD | WS_VISIBLE | WS_VSCROLL,
                              10, 190, 100, 60, top, (HMENU)902, NULL, NULL);
    for (int i = 0; i < 7; i++) {
        char it[8];
        snprintf(it, sizeof it, "it%d", i);
        SendMessage(slb, LB_ADDSTRING, 0, (LPARAM)it);
    }
    st_check("lb vscroll: pos starts at 0", GetScrollPos(slb, SB_VERT) == 0);
    int lmn = -1, lmx = -1;
    st_check("lb vscroll: GetScrollRange = the item count",
             GetScrollRange(slb, SB_VERT, &lmn, &lmx) && lmn == 0 && lmx == 6);
    memset(&si, 0, sizeof si);
    si.cbSize = sizeof si;
    si.fMask = SIF_ALL;
    st_check("lb vscroll: GetScrollInfo page = visible rows",
             GetScrollInfo(slb, SB_VERT, &si) &&
             (int)si.nPage >= 1 && (int)si.nPage < 7);
    int lrows = (int)si.nPage, lmax = 7 - lrows;
    st_check("lb vscroll: SetScrollPos scrolls, returns the old pos",
             SetScrollPos(slb, SB_VERT, 2, TRUE) == 0 &&
             GetScrollPos(slb, SB_VERT) == 2);
    st_check("lb vscroll: LB_GETTOPINDEX agrees",
             SendMessage(slb, LB_GETTOPINDEX, 0, 0) == 2);
    SetScrollPos(slb, SB_VERT, 99, TRUE);
    st_check("lb vscroll: SetScrollPos clamps to the max top",
             GetScrollPos(slb, SB_VERT) == lmax);
    st_check("lb vscroll: LB_SETTOPINDEX drives the view",
             SendMessage(slb, LB_SETTOPINDEX, 1, 0) == 0 &&
             SendMessage(slb, LB_GETTOPINDEX, 0, 0) == 1);
    st_check("lb vscroll: LB_SETTOPINDEX rejects out-of-range",
             SendMessage(slb, LB_SETTOPINDEX, 7, 0) == LB_ERR);
    SendMessage(slb, WM_VSCROLL, MAKEWPARAM(SB_TOP, 0), 0);
    SendMessage(slb, WM_VSCROLL, MAKEWPARAM(SB_LINEDOWN, 0), 0);
    st_check("lb vscroll: WM_VSCROLL SB_LINEDOWN",
             SendMessage(slb, LB_GETTOPINDEX, 0, 0) == 1);
    SendMessage(slb, WM_VSCROLL, MAKEWPARAM(SB_BOTTOM, 0), 0);
    st_check("lb vscroll: WM_VSCROLL SB_BOTTOM = the max top",
             SendMessage(slb, LB_GETTOPINDEX, 0, 0) == lmax);
    int wexp = lmax - 3;                    /* one wheel notch = 3 rows */
    if (wexp < 0) wexp = 0;
    SendMessage(slb, WM_MOUSEWHEEL, MAKEWPARAM(0, 120), 0);
    st_check("lb vscroll: the wheel rides the same clamp",
             SendMessage(slb, LB_GETTOPINDEX, 0, 0) == wexp);

    /* SetTimer with a TIMERPROC: refused, and loudly since #318 — the
     * callback would never fire, which must read as a missing feature */
    st_check("SetTimer TIMERPROC refused",
             SetTimer(top, 901, 50, (void *)StProc) == 0);

    /* the created-style net (#318 (i)): BS_FLAT is unread on BUTTON and
     * 0x100 (WS_EX_WINDOWEDGE) unread everywhere — both report, and the
     * window still creates (a report is not a refusal) */
    HWND sn = CreateWindowEx(0x100, "BUTTON", "x",
                             WS_CHILD | WS_VISIBLE | 0x8000 /* BS_FLAT */,
                             0, 0, 10, 10, top, (HMENU)903, NULL, NULL);
    st_check("style-net window still creates", sn != NULL);
    if (sn) DestroyWindow(sn);

    /* dlg_create template reports (#318 (iii)): IDD_ODD (ctldemo.rc, id
     * 51) asks for DS_CENTER|WS_THICKFRAME and "Courier New" 12 — both
     * discarded, both must report (honoring is #322) */
    HWND odd = CreateDialogParamW(NULL, MAKEINTRESOURCEW(51), top, NULL, 0);
    st_check("oddball template dialog created", odd != NULL);
    if (odd) DestroyWindow(odd);

    /* statusbar contract-message net (#318, gap #10): an unhandled SB_*
     * (SB_GETRECT here) reports instead of silently DefWindowProc-ing */
    HWND sbar = CreateStatusWindowA(WS_CHILD | WS_VISIBLE, "sb", top, 902);
    st_check("status bar created", sbar != NULL);
    RECT sbr;
    SendMessageW(sbar, SB_GETRECT, 0, (LPARAM)&sbr);   /* unhandled: reports */

    /* NULL-HWND control sends (#318, gap #1): loud, and the LB_/CB_
     * ranges return their contract error, not fake-success 0 — the calc
     * CB_GETLBTEXT class */
    char nbuf[8];
    st_check("CB_GETLBTEXT to NULL -> CB_ERR",
             SendMessage(NULL, CB_GETLBTEXT, 0, (LPARAM)nbuf) == CB_ERR);
    st_check("LB_GETCOUNT to NULL -> LB_ERR",
             SendMessage(NULL, LB_GETCOUNT, 0, 0) == LB_ERR);
    st_check("EM_GETSEL to NULL -> 0",
             SendMessage(NULL, EM_GETSEL, 0, 0) == 0);
    st_check("SendDlgItemMessage to a missing id -> CB_ERR",   /* W name: no
                              ANSI generic exists (windows.h UNICODE block) */
             SendDlgItemMessageW(top, 9999, CB_GETCOUNT, 0, 0) == CB_ERR);

    /* ---- BS_NOTIFY (#343): BN_SETFOCUS/BN_KILLFOCUS on focus moves and
     * BN_DBLCLK on the second click of a pair — only with the bit set.
     * BN_CLICKED never requires it. All SendMessage-synchronous (SetFocus
     * delivers WM_SET/KILLFOCUS inline; btn_proc notifies inline). */
    HWND bn = CreateWindowEx(0, "BUTTON", "notify",
                             WS_CHILD | WS_VISIBLE | BS_NOTIFY,
                             120, 120, 60, 24, top, (HMENU)910, NULL, NULL);
    HWND bp = CreateWindowEx(0, "BUTTON", "plain", WS_CHILD | WS_VISIBLE,
                             190, 120, 60, 24, top, (HMENU)911, NULL, NULL);
    st_check("notify/plain probe buttons created", bn != NULL && bp != NULL);
    st_bn_reset();
    SetFocus(bn);
    st_check("BS_NOTIFY: BN_SETFOCUS on focus gain",
             st_bnset == 1 && st_bnkill == 0);
    SetFocus(bp);                                /* bn kills; plain bp is mute */
    st_check("BS_NOTIFY: BN_KILLFOCUS on focus loss", st_bnkill == 1);
    st_check("plain button sends no focus notifications", st_bnset == 1);
    st_bn_reset();
    SendMessage(bp, BM_CLICK, 0, 0);
    st_check("BN_CLICKED without BS_NOTIFY", st_bnclick == 1);
    st_bn_reset();
    SendMessage(bn, BM_CLICK, 0, 0);
    st_check("BN_CLICKED with BS_NOTIFY", st_bnclick == 1);
    st_bn_reset();
    SendMessage(bn, WM_LBUTTONDBLCLK, MK_LBUTTON, MAKELPARAM(5, 5));
    SendMessage(bn, WM_LBUTTONUP, 0, MAKELPARAM(5, 5));
    st_check("BS_NOTIFY: BN_DBLCLK on the pair's second click", st_bndbl == 1);
    st_check("BS_NOTIFY: the notified dblclk is not also a press",
             st_bnclick == 0);
    st_bn_reset();
    SendMessage(bp, WM_LBUTTONDBLCLK, MK_LBUTTON, MAKELPARAM(5, 5));
    SendMessage(bp, WM_LBUTTONUP, 0, MAKELPARAM(5, 5));
    st_check("plain dblclk stays a press (BN_CLICKED, no BN_DBLCLK)",
             st_bnclick == 1 && st_bndbl == 0);

    /* ---- ES_NUMBER (#343): WM_CHAR is digits-only — rejects insert
     * nothing (and beep); backspace still edits; a plain EDIT keeps
     * accepting letters. WM_PASTE is deliberately unfiltered (classic
     * Windows behaviour), pinned here so a future "fix" is a decision. */
    HWND ne = CreateWindowEx(0, "EDIT", "", WS_CHILD | WS_VISIBLE | ES_NUMBER,
                             120, 150, 80, 24, top, (HMENU)912, NULL, NULL);
    st_check("ES_NUMBER edit created", ne != NULL);
    SendMessage(ne, WM_CHAR, '5', 0);
    SendMessage(ne, WM_CHAR, 'a', 0);            /* rejected */
    SendMessage(ne, WM_CHAR, '7', 0);
    GetWindowText(ne, buf, sizeof buf);
    st_check("ES_NUMBER filters WM_CHAR to digits", strcmp(buf, "57") == 0);
    SendMessage(ne, WM_CHAR, 8, 0);              /* backspace passes */
    GetWindowText(ne, buf, sizeof buf);
    st_check("ES_NUMBER lets backspace through", strcmp(buf, "5") == 0);
    SendMessage(ne, EM_SETSEL, 0, 1);
    SendMessage(ne, WM_PASTE, 0, 0);             /* clip = "cut" (undo leg) */
    GetWindowText(ne, buf, sizeof buf);
    st_check("ES_NUMBER paste is unfiltered (classic Windows)",
             strcmp(buf, "cut") == 0);
    SetWindowText(ed, "");
    SendMessage(ed, EM_SETSEL, 0, 0);
    SendMessage(ed, WM_CHAR, 'a', 0);
    GetWindowText(ed, buf, sizeof buf);
    st_check("plain EDIT still accepts letters", strcmp(buf, "a") == 0);

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

/* ---- `ctldemo listview` (0370): the SysListView32 acceptance pane — a
 * report-view listview filling a resizable-content window, columns with a
 * right-aligned Size, sort-by-column on LVN_COLUMNCLICK (toggling
 * direction), and every notification echoed as a `ctldemo:` marker for
 * the headless e2e (tests/kernel/test_listview_e2e.js). 24 rows so the
 * embedded scrollbar engages. ---- */

#define IDC_LV 300

typedef struct { const char *name, *ver, *size, *status; } LvRow;
static const LvRow LV_DATA[] = {
    { "alpha",    "1.0",  "12 KB",  "available" },
    { "bravo",    "2.1",  "340 KB", "installed" },
    { "charlie",  "0.9",  "7 KB",   "available" },
    { "delta",    "3.2",  "1.2 MB", "installed" },
    { "echo",     "1.1",  "88 KB",  "available" },
    { "foxtrot",  "4.0",  "220 KB", "built-in" },
    { "golf",     "2.7",  "19 KB",  "available" },
    { "hotel",    "1.5",  "3.1 MB", "installed" },
    { "india",    "0.3",  "5 KB",   "available" },
    { "juliett",  "6.2",  "450 KB", "available" },
    { "kilo",     "1.0",  "1 KB",   "built-in" },
    { "lima",     "2.0",  "77 KB",  "installed" },
    { "mike",     "5.1",  "910 KB", "available" },
    { "november", "1.9",  "33 KB",  "available" },
    { "oscar",    "0.8",  "2.4 MB", "installed" },
    { "papa",     "3.3",  "150 KB", "available" },
    { "quebec",   "2.2",  "60 KB",  "available" },
    { "romeo",    "1.4",  "8 KB",   "installed" },
    { "sierra",   "7.0",  "5.5 MB", "available" },
    { "tango",    "1.2",  "42 KB",  "available" },
    { "uniform",  "0.5",  "17 KB",  "built-in" },
    { "victor",   "2.8",  "230 KB", "available" },
    { "whiskey",  "1.6",  "95 KB",  "installed" },
    { "xray",     "4.4",  "700 KB", "available" },
};
#define LV_NDATA ((int)(sizeof LV_DATA / sizeof LV_DATA[0]))

static int lv_sort_col = -1, lv_sort_desc;

static const char *lv_field(const LvRow *r, int col) {
    switch (col) {
    case 1: return r->ver;
    case 2: return r->size;
    case 3: return r->status;
    default: return r->name;
    }
}

static int CALLBACK lv_demo_cmp(LPARAM a, LPARAM b, LPARAM ctx) {
    int col = (int)(ctx & 0xFF), desc = (int)(ctx >> 8);
    int r = strcmp(lv_field(&LV_DATA[a], col), lv_field(&LV_DATA[b], col));
    return desc ? -r : r;
}

static void lv_fill(HWND lv) {
    ListView_DeleteAllItems(lv);
    for (int i = 0; i < LV_NDATA; i++) {
        LVITEM li;
        memset(&li, 0, sizeof li);
        li.mask = LVIF_TEXT | LVIF_PARAM;
        li.iItem = i;
        li.pszText = (char *)LV_DATA[i].name;
        li.lParam = i;
        ListView_InsertItem(lv, &li);
        for (int c = 1; c <= 3; c++) {
            LVITEM ls;
            memset(&ls, 0, sizeof ls);
            ls.iSubItem = c;
            ls.pszText = (char *)lv_field(&LV_DATA[i], c);
            SendMessage(lv, LVM_SETITEMTEXT, (WPARAM)i, (LPARAM)&ls);
        }
    }
}

static LRESULT CALLBACK LvDemoProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE: {
        HWND lv = CreateWindowEx(0, WC_LISTVIEW, "",
                                 WS_CHILD | WS_VISIBLE | LVS_REPORT,
                                 12, 12, 456, 336, hwnd, (HMENU)IDC_LV,
                                 NULL, NULL);
        LVCOLUMN lc;
        memset(&lc, 0, sizeof lc);
        lc.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_FMT;
        lc.fmt = LVCFMT_LEFT;
        lc.cx = 140; lc.pszText = "Name";
        SendMessage(lv, LVM_INSERTCOLUMN, 0, (LPARAM)&lc);
        lc.cx = 80;  lc.pszText = "Version";
        SendMessage(lv, LVM_INSERTCOLUMN, 1, (LPARAM)&lc);
        lc.fmt = LVCFMT_RIGHT;
        lc.cx = 90;  lc.pszText = "Size";
        SendMessage(lv, LVM_INSERTCOLUMN, 2, (LPARAM)&lc);
        lc.fmt = LVCFMT_LEFT;
        lc.cx = 120; lc.pszText = "Status";
        SendMessage(lv, LVM_INSERTCOLUMN, 3, (LPARAM)&lc);
        ListView_SetExtendedListViewStyle(lv, LVS_EX_FULLROWSELECT);
        lv_fill(lv);
        return 0;
    }
    case WM_SIZE: {
        RECT r;
        GetClientRect(hwnd, &r);
        MoveWindow(GetDlgItem(hwnd, IDC_LV), 12, 12,
                   r.right - 24, r.bottom - 24, TRUE);
        return 0;
    }
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        if (dc) EndPaint(hwnd, &ps);
        if (!g_painted) { g_painted = 1; mark("ready"); }
        return 0;
    }
    case WM_NOTIFY: {
        const NMLISTVIEW *nm = (const NMLISTVIEW *)lp;
        if (!nm || nm->hdr.idFrom != IDC_LV) return 0;
        HWND lv = GetDlgItem(hwnd, IDC_LV);
        if (nm->hdr.code == LVN_ITEMCHANGED) {
            if ((nm->uNewState & LVIS_SELECTED)
                && !(nm->uOldState & LVIS_SELECTED)) {
                char name[64] = "";
                LVITEM li;
                memset(&li, 0, sizeof li);
                li.iSubItem = 0;
                li.pszText = name;
                li.cchTextMax = sizeof name;
                SendMessage(lv, LVM_GETITEMTEXT, (WPARAM)nm->iItem, (LPARAM)&li);
                printf("ctldemo: lv sel=%d name=%s\n", nm->iItem, name);
                fflush(stdout);
            }
        } else if (nm->hdr.code == NM_CLICK) {
            printf("ctldemo: lv click=%d\n", nm->iItem);
            fflush(stdout);
        } else if (nm->hdr.code == NM_DBLCLK) {
            printf("ctldemo: lv dblclk=%d\n", nm->iItem);
            fflush(stdout);
        } else if (nm->hdr.code == NM_RCLICK) {
            printf("ctldemo: lv rclick=%d\n", nm->iItem);
            fflush(stdout);
        } else if (nm->hdr.code == LVN_COLUMNCLICK) {
            int col = nm->iSubItem;
            lv_sort_desc = col == lv_sort_col ? !lv_sort_desc : 0;
            lv_sort_col = col;
            ListView_SortItems(lv, lv_demo_cmp,
                               (LPARAM)(col | (lv_sort_desc << 8)));
            char first[64] = "";
            LVITEM li;
            memset(&li, 0, sizeof li);
            li.iSubItem = 0;
            li.pszText = first;
            li.cchTextMax = sizeof first;
            SendMessage(lv, LVM_GETITEMTEXT, 0, (LPARAM)&li);
            printf("ctldemo: lv colclick=%d dir=%d first=%s\n",
                   col, lv_sort_desc, first);
            fflush(stdout);
        }
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

static int lvdemo(void) {
    INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_LISTVIEW_CLASSES };
    InitCommonControlsEx(&icc);
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = LvDemoProc;
    wc.lpszClassName = "lvdemo";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;
    HWND hwnd = CreateWindowEx(0, "lvdemo", "ListView Demo",
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

/* ---- `ctldemo lvtest` (0370): synchronous message-surface asserts for
 * SysListView32 + SysHeader32 — the `selftest` shape (st_check), no pump
 * needed. The e2e runs it headless and checks "0 failed". ---- */

static int lv_nchanged;                          /* LVN_ITEMCHANGED count */

static int CALLBACK lvtest_cmp(LPARAM a, LPARAM b, LPARAM ctx) {
    (void)ctx;
    return (int)a - (int)b;                      /* lParam rank, ascending */
}

static LRESULT CALLBACK LvTestProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NOTIFY) {
        const NMLISTVIEW *nm = (const NMLISTVIEW *)lp;
        if (nm && nm->hdr.code == LVN_ITEMCHANGED) lv_nchanged++;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

static int lvtest(void) {
    INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_LISTVIEW_CLASSES };
    st_check("InitCommonControlsEx", InitCommonControlsEx(&icc));
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = LvTestProc;
    wc.lpszClassName = "lvtest";
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    if (!RegisterClass(&wc)) return 3;
    HWND top = CreateWindowEx(0, "lvtest", "lvtest",
                              WS_OVERLAPPED | WS_VISIBLE,
                              0, 0, 400, 300, NULL, NULL, NULL, NULL);
    if (!top) return 3;
    /* Short on purpose: ~5 visible rows so scroll paths engage. */
    HWND lv = CreateWindowEx(0, WC_LISTVIEWA, "",
                             WS_CHILD | WS_VISIBLE | LVS_REPORT,
                             10, 10, 300, 140, top, (HMENU)900, NULL, NULL);
    st_check("listview created", lv != NULL);
    HWND hdr = (HWND)SendMessage(lv, LVM_GETHEADER, 0, 0);
    st_check("LVM_GETHEADER", hdr != NULL);

    /* columns */
    LVCOLUMNA lc;
    memset(&lc, 0, sizeof lc);
    lc.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_FMT;
    lc.fmt = LVCFMT_LEFT;
    lc.cx = 120; lc.pszText = (char *)"Name";
    st_check("insert col 0", SendMessage(lv, LVM_INSERTCOLUMNA, 0, (LPARAM)&lc) == 0);
    lc.fmt = LVCFMT_RIGHT;
    lc.cx = 70; lc.pszText = (char *)"Size";
    st_check("insert col 1", SendMessage(lv, LVM_INSERTCOLUMNA, 1, (LPARAM)&lc) == 1);
    lc.fmt = LVCFMT_LEFT;
    lc.cx = 90; lc.pszText = (char *)"Status";
    st_check("insert col 2", SendMessage(lv, LVM_INSERTCOLUMNA, 2, (LPARAM)&lc) == 2);
    st_check("header count", (int)SendMessage(hdr, HDM_GETITEMCOUNT, 0, 0) == 3);
    char cbuf[64];
    memset(&lc, 0, sizeof lc);
    lc.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_FMT;
    lc.pszText = cbuf;
    lc.cchTextMax = sizeof cbuf;
    st_check("get col 1", SendMessage(lv, LVM_GETCOLUMNA, 1, (LPARAM)&lc));
    st_check("col text roundtrip", strcmp(cbuf, "Size") == 0);
    st_check("col width roundtrip", lc.cx == 70);
    st_check("col fmt roundtrip", (lc.fmt & 3) == LVCFMT_RIGHT);
    memset(&lc, 0, sizeof lc);
    lc.mask = LVCF_WIDTH;
    lc.cx = 80;
    st_check("set col 1 width", SendMessage(lv, LVM_SETCOLUMNA, 1, (LPARAM)&lc));
    memset(&lc, 0, sizeof lc);
    lc.mask = LVCF_WIDTH;
    st_check("get col 1 again", SendMessage(lv, LVM_GETCOLUMNA, 1, (LPARAM)&lc));
    st_check("set col width took", lc.cx == 80);

    /* items: 10 rows, one inserted out of order */
    static const char *NAMES[] = { "ant", "bee", "cat", "dog", "eel",
                                   "fox", "gnu", "hen", "ibx", "jay" };
    for (int i = 0; i < 10; i++) {
        LVITEMA li;
        memset(&li, 0, sizeof li);
        li.mask = LVIF_TEXT | LVIF_PARAM;
        li.iItem = i;
        li.pszText = (char *)NAMES[i];
        li.lParam = 9 - i;                       /* reverse rank for the sort leg */
        SendMessage(lv, LVM_INSERTITEMA, 0, (LPARAM)&li);
        LVITEMA ls;
        memset(&ls, 0, sizeof ls);
        ls.iSubItem = 2;
        ls.pszText = (char *)(i % 2 ? "ok" : "new");
        SendMessage(lv, LVM_SETITEMTEXTA, (WPARAM)i, (LPARAM)&ls);
    }
    st_check("item count", (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0) == 10);
    {
        LVITEMA li;
        memset(&li, 0, sizeof li);
        li.mask = LVIF_TEXT;
        li.iItem = 5;                            /* out-of-order insert */
        li.pszText = (char *)"mid";
        st_check("insert mid", (int)SendMessage(lv, LVM_INSERTITEMA, 0, (LPARAM)&li) == 5);
        st_check("count after mid", (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0) == 11);
        char b[32] = "";
        LVITEMA lg;
        memset(&lg, 0, sizeof lg);
        lg.iSubItem = 0;
        lg.pszText = b;
        lg.cchTextMax = sizeof b;
        SendMessage(lv, LVM_GETITEMTEXTA, 5, (LPARAM)&lg);
        st_check("mid text", strcmp(b, "mid") == 0);
        SendMessage(lv, LVM_GETITEMTEXTA, 6, (LPARAM)&lg);
        st_check("shifted row follows", strcmp(b, "fox") == 0);
        st_check("delete mid", SendMessage(lv, LVM_DELETEITEM, 5, 0));
        st_check("count restored", (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0) == 10);
    }

    /* subitem + W roundtrips */
    {
        char b[32] = "";
        LVITEMA lg;
        memset(&lg, 0, sizeof lg);
        lg.iSubItem = 2;
        lg.pszText = b;
        lg.cchTextMax = sizeof b;
        SendMessage(lv, LVM_GETITEMTEXTA, 3, (LPARAM)&lg);
        st_check("subitem text", strcmp(b, "ok") == 0);
        WCHAR wb[32];
        LVITEMW lw;
        memset(&lw, 0, sizeof lw);
        lw.iSubItem = 0;
        lw.pszText = wb;
        lw.cchTextMax = 32;
        SendMessage(lv, LVM_GETITEMTEXTW, 0, (LPARAM)&lw);
        st_check("W gettext", wb[0] == 'a' && wb[1] == 'n' && wb[2] == 't' && wb[3] == 0);
        LVITEMW li;
        memset(&li, 0, sizeof li);
        li.mask = LVIF_TEXT;
        li.iItem = 10;
        li.pszText = (WCHAR *)u"w\x00E9ide";     /* é: UTF-16 -> UTF-8 -> back */
        st_check("W insert", (int)SendMessage(lv, LVM_INSERTITEMW, 0, (LPARAM)&li) == 10);
        memset(&lw, 0, sizeof lw);
        lw.iSubItem = 0;
        lw.pszText = wb;
        lw.cchTextMax = 32;
        SendMessage(lv, LVM_GETITEMTEXTW, 10, (LPARAM)&lw);
        st_check("W roundtrip", wb[0] == 'w' && wb[1] == 0x00E9 && wb[2] == 'i');
        st_check("W delete", SendMessage(lv, LVM_DELETEITEM, 10, 0));
    }

    /* state + selection + notify */
    lv_nchanged = 0;
    ListView_SetItemState(lv, 2, LVIS_SELECTED | LVIS_FOCUSED,
                          LVIS_SELECTED | LVIS_FOCUSED);
    st_check("state set", (ListView_GetItemState(lv, 2, LVIS_SELECTED | LVIS_FOCUSED)
                           == (LVIS_SELECTED | LVIS_FOCUSED)));
    st_check("ITEMCHANGED notified", lv_nchanged == 1);
    st_check("selected count", (int)SendMessage(lv, LVM_GETSELECTEDCOUNT, 0, 0) == 1);
    st_check("next selected", ListView_GetNextItem(lv, -1, LVNI_SELECTED) == 2);
    st_check("next focused", ListView_GetNextItem(lv, -1, LVNI_FOCUSED) == 2);
    {
        LVITEMA li;
        memset(&li, 0, sizeof li);
        li.mask = LVIF_PARAM;
        li.iItem = 2;
        SendMessage(lv, LVM_GETITEMA, 0, (LPARAM)&li);
        st_check("lparam roundtrip", li.lParam == 7);
    }
    ListView_SetItemState(lv, -1, 0, LVIS_SELECTED);
    st_check("clear all sel", (int)SendMessage(lv, LVM_GETSELECTEDCOUNT, 0, 0) == 0);

    /* keyboard: focus row moves + selects (single gesture from focus row) */
    SendMessage(lv, WM_KEYDOWN, VK_DOWN, 0);
    st_check("VK_DOWN moves focus", ListView_GetNextItem(lv, -1, LVNI_FOCUSED) == 3);
    st_check("VK_DOWN selects", ListView_GetItemState(lv, 3, LVIS_SELECTED) == LVIS_SELECTED);
    st_check("WM_GETDLGCODE arrows",
             SendMessage(lv, WM_GETDLGCODE, 0, 0) == DLGC_WANTARROWS);

    /* hit test + scroll */
    {
        RECT lr;
        GetClientRect(lv, &lr);
        HDC ldc = GetDC(lv);
        TEXTMETRIC ltm;
        ltm.tmHeight = -1;
        if (ldc) { GetTextMetrics(ldc, &ltm); ReleaseDC(lv, ldc); }
        printf("ctldemo lvmetrics: client=%dx%d tmHeight=%d\n",
               (int)lr.right, (int)lr.bottom, (int)ltm.tmHeight);
        fflush(stdout);
        LVHITTESTINFO ht;
        memset(&ht, 0, sizeof ht);
        ht.pt.x = 20;
        ht.pt.y = 60;                            /* inside the rows area */
        int r0 = ListView_HitTest(lv, &ht);
        st_check("hittest hits a row", r0 >= 0 && (ht.flags & LVHT_ONITEM));
        memset(&ht, 0, sizeof ht);
        ht.pt.x = 20;
        ht.pt.y = 4;                             /* header band */
        st_check("hittest header = none", ListView_HitTest(lv, &ht) == -1
                 && ht.flags == LVHT_NOWHERE);
        memset(&ht, 0, sizeof ht);
        ht.pt.x = 20;
        ht.pt.y = 60;
        /* pin the scroll to the top first — the keyboard leg above may
         * already have scrolled (vis rows are font-dependent) */
        ListView_EnsureVisible(lv, 0, FALSE);
        int before = ListView_HitTest(lv, &ht);
        st_check("ensure visible", ListView_EnsureVisible(lv, 9, FALSE));
        int after = ListView_HitTest(lv, &ht);
        st_check("ensure visible scrolled", after > before);
        SendMessage(lv, WM_VSCROLL, MAKEWPARAM(SB_LINEUP, 0), 0);
        int lineup = ListView_HitTest(lv, &ht);
        st_check("SB_LINEUP scrolls back", lineup == after - 1);
        ListView_EnsureVisible(lv, 0, FALSE);
        int final = ListView_HitTest(lv, &ht);
        printf("ctldemo lvscroll: before=%d after=%d lineup=%d final=%d\n",
               before, after, lineup, final);
        fflush(stdout);
        st_check("ensure visible top", final == before);
    }

    /* sort by lParam ascending (items carry reverse rank, so the name
     * order flips) — texts, states and the focus row travel with items */
    {
        ListView_SetItemState(lv, -1, 0, LVIS_SELECTED);
        ListView_SetItemState(lv, 2, LVIS_SELECTED | LVIS_FOCUSED,
                              LVIS_SELECTED | LVIS_FOCUSED);   /* "cat", rank 7 */
        st_check("sort", ListView_SortItems(lv, lvtest_cmp, 0));
        char b[32] = "";
        LVITEMA lg;
        memset(&lg, 0, sizeof lg);
        lg.iSubItem = 0;
        lg.pszText = b;
        lg.cchTextMax = sizeof b;
        SendMessage(lv, LVM_GETITEMTEXTA, 0, (LPARAM)&lg);
        st_check("sort reordered (rank 0 first)", strcmp(b, "jay") == 0);
        SendMessage(lv, LVM_GETITEMTEXTA, 9, (LPARAM)&lg);
        st_check("sort last (rank 9)", strcmp(b, "ant") == 0);
        st_check("selection travels with the row",
                 ListView_GetNextItem(lv, -1, LVNI_SELECTED) == 7);
        st_check("focus travels with the row",
                 ListView_GetNextItem(lv, -1, LVNI_FOCUSED) == 7);
    }

    /* WM_GETTEXT agent format: header line + "> " on the selected row */
    {
        ListView_SetItemState(lv, -1, 0, LVIS_SELECTED);
        ListView_SetItemState(lv, 0, LVIS_SELECTED, LVIS_SELECTED);
        char big[2048];
        int n = (int)SendMessage(lv, WM_GETTEXT, sizeof big, (LPARAM)big);
        st_check("gettext nonempty", n > 0);
        st_check("gettext header line",
                 strncmp(big, "Name | Size | Status\n", 21) == 0);
        st_check("gettext sel marker", strstr(big, "\n> ") != NULL);
    }

    /* extended style */
    {
        DWORD old = (DWORD)SendMessage(lv, LVM_SETEXTENDEDLISTVIEWSTYLE, 0,
                                       LVS_EX_FULLROWSELECT);
        st_check("ex style old", old == 0);
        st_check("ex style get",
                 (DWORD)SendMessage(lv, LVM_GETEXTENDEDLISTVIEWSTYLE, 0, 0)
                 == LVS_EX_FULLROWSELECT);
    }

    /* column delete shifts subitems (row 0 is "jay" post-sort: old rank 9,
     * odd index -> Status "ok") */
    st_check("delete col 1", SendMessage(lv, LVM_DELETECOLUMN, 1, 0));
    {
        char b[32] = "";
        LVITEMA lg;
        memset(&lg, 0, sizeof lg);
        lg.iSubItem = 1;                         /* was col 2 (Status) */
        lg.pszText = b;
        lg.cchTextMax = sizeof b;
        SendMessage(lv, LVM_GETITEMTEXTA, 0, (LPARAM)&lg);
        st_check("col delete shifts subitems", strcmp(b, "ok") == 0);
        st_check("header count after delete",
                 (int)SendMessage(hdr, HDM_GETITEMCOUNT, 0, 0) == 2);
    }

    st_check("delete all", SendMessage(lv, LVM_DELETEALLITEMS, 0, 0));
    st_check("count after clear", (int)SendMessage(lv, LVM_GETITEMCOUNT, 0, 0) == 0);

    printf("ctldemo lvtest: %d checks, %d failed\n", st_checks, st_fails);
    fflush(stdout);
    DestroyWindow(top);
    return st_fails ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) return selftest();
    if (argc > 1 && strcmp(argv[1], "menudemo") == 0) return menudemo();
    if (argc > 1 && strcmp(argv[1], "listview") == 0) return lvdemo();
    if (argc > 1 && strcmp(argv[1], "lvtest") == 0) return lvtest();
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
