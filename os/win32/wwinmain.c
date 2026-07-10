/* wwinmain.c — the wWinMain CRT entry shim (todos/0068, design
 * todos/WIN32.md). Windows picks the CRT entry (main / WinMain /
 * wWinMain) at link time; in this static-link world the project manifest
 * does — a UNICODE GUI port whose entry is wWinMain lists this file in
 * its bin.json `sources` (see vendor/winmine/bin.json). Deliberately NOT
 * in os/win32/lib.json: apps with their own main() (gdidemo/ctldemo/
 * k32demo) must not collide. */

#include <windows.h>

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR cmdLine, int show);

int main(void) {
    /* lpCmdLine is the tail AFTER argv0, like the real CRT: skip the
     * (possibly quoted) program token and following blanks. */
    LPWSTR cmd = GetCommandLineW();
    if (cmd) {
        int quoted = *cmd == (WCHAR)'"';
        if (quoted) cmd++;
        while (*cmd && (quoted ? *cmd != (WCHAR)'"' : *cmd != (WCHAR)' ')) cmd++;
        if (quoted && *cmd) cmd++;
        while (*cmd == (WCHAR)' ') cmd++;
    }
    return wWinMain(GetModuleHandleW(NULL), NULL, cmd, 1 /* SW_SHOWNORMAL */);
}
