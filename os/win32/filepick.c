/* filepick — the out-of-process file chooser (todos/0433).
 *
 * One GetOpenFileNameW call wrapped in argv: `filepick [--title T]
 * [--dir D]` raises the comdlg32 file dialog and reports the verdict
 * on stdout — accept prints the absolute path plus '\n' and exits 0,
 * cancel prints nothing and exits 1.  The stream is newline-separated
 * paths: version 1 emits one line, a future multi-select emits N lines
 * with no protocol change.
 *
 * The first consumer is netsurf's <input type=file> handler
 * (vendor/netsurf/gucos/gui.c).  netsurf is SDL-native, so the win32
 * modal pump cannot run in its process: pump_sdl would eat the
 * browser's SDL queue and the engine's scheduled callbacks would
 * starve for the dialogue's whole life.  As its own process the picker
 * is a full win32 app — it serves its own agent socket, so wmctl
 * drives it with the existing comdlg32 vocabulary (settext the name
 * EDIT, click Open/Cancel), and a picker crash cannot take the
 * browser. */

#include <windows.h>
#include <commdlg.h>
#include <stdio.h>
#include <string.h>

#define FP_MAX 1024   /* comdlg32's own path buffers are 512/1024 */

int main(int argc, char **argv) {
    const char *title = "Open";
    const char *dir = NULL;
    for (int i = 1; i + 1 < argc; i++) {
        if (!strcmp(argv[i], "--title")) title = argv[++i];
        else if (!strcmp(argv[i], "--dir")) dir = argv[++i];
    }

    static WCHAR wfile[FP_MAX], wtitle[256], wdir[FP_MAX];
    wfile[0] = 0;
    MultiByteToWideChar(CP_UTF8, 0, title, -1, wtitle, 256);

    OPENFILENAMEW ofn;
    memset(&ofn, 0, sizeof ofn);
    ofn.lStructSize = sizeof ofn;
    ofn.lpstrFile = wfile;
    ofn.nMaxFile = FP_MAX;
    ofn.lpstrTitle = wtitle;
    ofn.Flags = OFN_FILEMUSTEXIST;
    if (dir && dir[0] == '/') {
        MultiByteToWideChar(CP_UTF8, 0, dir, -1, wdir, FP_MAX);
        ofn.lpstrInitialDir = wdir;
    }
    if (!GetOpenFileNameW(&ofn)) return 1;

    static char path[FP_MAX * 4];
    WideCharToMultiByte(CP_UTF8, 0, wfile, -1, path, sizeof path, NULL, NULL);
    printf("%s\n", path);
    fflush(stdout);
    return 0;
}
