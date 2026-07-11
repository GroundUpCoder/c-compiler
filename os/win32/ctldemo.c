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
        CreateWindowEx(0, "EDIT", "line one\nline two",
                       WS_CHILD | WS_VISIBLE | ES_MULTILINE,
                       12, 176, 268, 96, hwnd, (HMENU)IDC_NOTES_EDIT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Verbose", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                       12, 284, 120, 20, hwnd, (HMENU)IDC_CHECK, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Options", WS_CHILD | WS_VISIBLE,
                       140, 284, 76, 26, hwnd, (HMENU)IDB_OPTIONS, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "About", WS_CHILD | WS_VISIBLE,
                       300, 284, 76, 26, hwnd, (HMENU)IDB_ABOUT, NULL, NULL);
        CreateWindowEx(0, "BUTTON", "Quit", WS_CHILD | WS_VISIBLE,
                       388, 284, 76, 26, hwnd, (HMENU)IDB_QUIT, NULL, NULL);
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

int main(void) {
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
