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
