/* oomdlg — the 0255/R4 out-of-memory acceptance fixture (compiled and
 * injected by tests/kernel/test_comdlg_diag_e2e.js; NOT part of the OS
 * image). It opens the real comdlg32 file dialog, then — on an agent
 * `wmctl settext oomdlg ballast` — exhausts its own heap so the dialog's
 * next fd_refill snapshot malloc (FD_MAX_ENT * sizeof(ld_ent) = 139,264
 * bytes) genuinely fails, proving the "(cannot allocate directory
 * listing)" row renders instead of an empty-looking listing.
 *
 * Ballast keeps every chunk and stops at a 64 KiB floor: no free block
 * can serve the ~136 KiB snapshot, while sub-64K blocks stay available
 * for the diagnostic row, listbox nodes and agent replies (an allocator
 * left bone-dry couldn't even render the failure it's reporting).
 */
#include <windows.h>
#include <commdlg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void eat_heap(void) {
    size_t sz = (size_t)16 << 20;
    while (sz >= (size_t)64 << 10) {
        void *p = malloc(sz);
        if (!p) { sz >>= 1; continue; }
        *(volatile char *)p = 1;   /* touch it; kept forever, by design */
    }
}

static LRESULT CALLBACK wproc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
    if (m == WM_SETTEXT && lp && !strcmp((const char *)lp, "ballast")) {
        eat_heap();
        /* retitle so the driver can wait on completion (kernel title) */
        return DefWindowProc(h, m, wp, (LPARAM)"ballasted");
    }
    if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProc(h, m, wp, lp);
}

int main(void) {
    WNDCLASS wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wproc;
    wc.lpszClassName = "OomDlg";
    RegisterClass(&wc);
    HWND w = CreateWindowEx(0, "OomDlg", "oomdlg",
                            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                            20, 40, 220, 90, NULL, NULL, NULL, NULL);
    if (!w) return 1;

    WCHAR file[512];
    file[0] = 0;
    OPENFILENAMEW ofn;
    memset(&ofn, 0, sizeof ofn);
    ofn.lStructSize = sizeof ofn;
    ofn.lpstrFile = file;
    ofn.nMaxFile = 512;
    /* no hwndOwner: the main window must stay ENABLED so the agent's
     * WM_SETTEXT "ballast" trigger reaches wproc mid-modal */
    GetOpenFileNameW(&ofn);
    printf("oomdlg: dialog done\n");
    return 0;
}
