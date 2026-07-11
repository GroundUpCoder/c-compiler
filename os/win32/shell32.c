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
#include "../fileops.h"

/* ---- 0092: the SHFileOperation-style helpers ----
 * VENEER-LOCAL, not a Windows API (the real SHFileOperation struct-and-
 * double-NUL shape has no consumer in the corpus): thin exports over the
 * shared os/fileops.h core, so fileman and wm.c (which includes fileops.h
 * directly — it is not a win32 app) stay behaviorally identical. 0 or -1
 * with errno set; surface strerror(errno) to the user. */

int SHFileCopy(const char *src, const char *dst) { return fo_copy(src, dst); }
int SHFileMove(const char *src, const char *dst) { return fo_move(src, dst); }
int SHFileDelete(const char *path) { return fo_delete(path); }

int SHPasteDest(const char *dir, const char *name, char *out, int cap) {
    return fo_paste_dest(dir, name, out, (size_t)cap);
}

int SHNewDest(const char *dir, const char *base, const char *ext,
              char *out, int cap) {
    return fo_new_dest(dir, base, ext, out, (size_t)cap);
}

/* The trash store (todos/0093, fileops.h /root/.recycle — files/ entries
 * + info/ sidecars). Same veneer-local convention as the SHFile* set. */
int SHFileTrash(const char *path) { return fo_trash(path); }
int SHFileRestore(const char *stored) { return fo_restore(stored); }
int SHRestoreTarget(const char *stored, char *out, int cap) {
    return fo_restore_target(stored, out, (size_t)cap);
}
void SHTrashForget(const char *stored) { fo_trash_forget(stored); }
int SHTrashEmpty(void) { return fo_trash_empty(); }
int SHTrashCount(void) { return fo_trash_count(); }
const char *SHTrashFilesDir(void) { return FO_TRASH_FILES; }

/* The clipboard file list (fileops.h FO_CLIP_FMT over the 0090 slot). */
int SHClipSetFiles(int cut, const char *const *paths, int n) {
    return fo_clip_set(cut, paths, n);
}
int SHClipHasFiles(void) { return fo_clip_has(); }
int SHClipLoadFiles(char *buf, int cap, int *cut) {
    return fo_clip_load(buf, cap, cut);
}
const char *SHClipPath(const char *buf, int i) { return fo_clip_path(buf, i); }
int SHClipClear(void) { return fo_clip_clear(); }

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
