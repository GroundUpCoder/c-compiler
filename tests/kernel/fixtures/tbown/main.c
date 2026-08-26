/* tbown — the #740 taskbar-classification acceptance fixture (compiled and
 * injected by tests/kernel/test_taskbar_owner_e2e.js; NOT part of the OS
 * image).
 *
 * It creates one top-level window per branch of the Win32 taskbar rule, so
 * `wmctl list` reads the whole rule off one boot. The rule (user32.c
 * create_window_impl) is:
 *
 *   WS_EX_APPWINDOW      -> listed, even when owned
 *   else owner != NULL   -> NOT listed (an owned modal / secondary window)
 *   else WS_EX_TOOLWINDOW-> NOT listed
 *   else                 -> listed
 *
 * "NOT listed" is WMP_F_TRANSIENT, the 'U' in the wmctl FLAGS column: no
 * taskbar button and skipped by cycle/cascade/tile/minimize-all.
 *
 * Deliberately class-agnostic: every window here uses the SAME registered
 * class, so a test that reads different flags off them can only be reading
 * ownership and the ex-style bits — never a class name. That is the whole
 * point of #740.
 */
#include <windows.h>
#include <string.h>

static LRESULT CALLBACK wproc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, wp, lp);
}

int main(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wproc;
    wc.lpszClassName = "TbOwn";
    RegisterClass(&wc);

    /* unowned, no ex-style: the ordinary application window -> listed */
    HWND main_ = CreateWindowEx(0, "TbOwn", "tb-main",
                                WS_OVERLAPPED | WS_VISIBLE,
                                20, 40, 240, 120, NULL, NULL, NULL, NULL);
    if (!main_) return 1;

    /* OWNED by tb-main -> not listed. Pre-#740 this was listed, because the
     * classifier only asked whether the class name was "#32770". */
    if (!CreateWindowEx(0, "TbOwn", "tb-owned",
                        WS_OVERLAPPED | WS_VISIBLE,
                        40, 60, 200, 100, main_, NULL, NULL, NULL))
        return 1;

    /* unowned but WS_EX_TOOLWINDOW -> not listed (a floating palette) */
    if (!CreateWindowEx(WS_EX_TOOLWINDOW, "TbOwn", "tb-tool",
                        WS_OVERLAPPED | WS_VISIBLE,
                        60, 80, 200, 100, NULL, NULL, NULL, NULL))
        return 1;

    /* OWNED but WS_EX_APPWINDOW -> listed anyway: the app-window bit is the
     * documented override, and it must beat ownership, not merely add to it. */
    if (!CreateWindowEx(WS_EX_APPWINDOW, "TbOwn", "tb-appwin",
                        WS_OVERLAPPED | WS_VISIBLE,
                        80, 100, 200, 100, main_, NULL, NULL, NULL))
        return 1;

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return 0;
}
