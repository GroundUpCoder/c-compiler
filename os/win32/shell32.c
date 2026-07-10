/* shell32.c — the shell32 veneer slice (todos/0068, design todos/WIN32.md).
 * First entry: ShellAboutW, composed over the user32 MessageBox modal (the
 * icon parameter is one of user32's stub handles — nothing to draw).
 * Grow strictly to os/win32/PORTS.md demand (ShellExecuteW,
 * SHAddToRecentDocs, the drag-drop set are notepad's, still logged). */

/* Implemented ANSI-internal like gdi32/user32 (WIN32.md friction #2). */
#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int ShellAboutW(HWND owner, LPCWSTR app, LPCWSTR otherStuff, HICON icon) {
    (void)icon;
    char a[256] = "", o[512] = "";
    if (app) WideCharToMultiByte(CP_UTF8, 0, app, -1, a, sizeof a, NULL, NULL);
    if (otherStuff)
        WideCharToMultiByte(CP_UTF8, 0, otherStuff, -1, o, sizeof o, NULL, NULL);
    /* Windows: "App#OtherName" — the part before '#' titles the box. */
    char *hash = strchr(a, '#');
    if (hash) *hash = 0;
    char caption[300], text[800];
    snprintf(caption, sizeof caption, "About %s", a);
    snprintf(text, sizeof text, "%s\n\n%s", a, o);
    return MessageBox(owner, text, caption, MB_OK) != 0;
}

/* ---- 0048 additions (notepad's tail) ---- */

/* ShellExecuteW: "open" on a file — spawn it via kernel32's CreateProcessW
 * (posix_spawn under the hood; a #! script or wasm binary just runs —
 * kernel exec dispatch). The verb is ignored: open IS the only verb. */
HINSTANCE ShellExecuteW(HWND hwnd, LPCWSTR op, LPCWSTR file, LPCWSTR params,
                        LPCWSTR dir, int showCmd) {
    (void)hwnd; (void)op; (void)dir; (void)showCmd;
    if (!file) return (HINSTANCE)2;              /* SE_ERR_FNF-ish */
    WCHAR cmd[1024];
    int n = 0;
    for (; file[n] && n < 1000; n++) cmd[n] = file[n];
    if (params && params[0] && n < 1000) {
        cmd[n++] = u' ';
        for (int i = 0; params[i] && n < 1020; i++) cmd[n++] = params[i];
    }
    cmd[n] = 0;
    PROCESS_INFORMATION pi;
    STARTUPINFOW si;
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi))
        return (HINSTANCE)2;
    if (pi.hProcess) CloseHandle(pi.hProcess);
    if (pi.hThread) CloseHandle(pi.hThread);
    return (HINSTANCE)33;                        /* > 32 = success */
}

void SHAddToRecentDocs(UINT flags, LPCVOID data) {
    (void)flags; (void)data;                     /* no recent-docs shell UI */
}

/* Drag and drop: the kernel has no DnD transport into surfaces (the
 * desktop's 0067 drop lands FILES in /root/Desktop, not messages) — so
 * accepting is a no-op and no WM_DROPFILES ever arrives. Queries answer
 * "no files" honestly rather than faking a drop. */
void DragAcceptFiles(HWND hwnd, BOOL accept) { (void)hwnd; (void)accept; }

UINT DragQueryFileW(HDROP drop, UINT index, LPWSTR buf, UINT n) {
    (void)drop; (void)index;
    if (buf && n) buf[0] = 0;
    return 0;
}

void DragFinish(HDROP drop) { (void)drop; }

BOOL DragQueryPoint(HDROP drop, POINT *p) {
    (void)drop;
    if (p) { p->x = 0; p->y = 0; }
    return FALSE;
}
