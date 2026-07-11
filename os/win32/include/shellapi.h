/* shellapi.h — shell32 surface for the port corpus (todos/0060).
 * Declaration-only; unimplemented symbols land in PORTS.md (0059+). */
#pragma once

#include <windows.h>

HINSTANCE ShellExecuteW(HWND hwnd, LPCWSTR op, LPCWSTR file, LPCWSTR params,
                        LPCWSTR dir, int showCmd);
int  ShellAboutW(HWND hwnd, LPCWSTR app, LPCWSTR otherStuff, HICON icon);
void DragAcceptFiles(HWND hwnd, BOOL accept);
UINT DragQueryFileW(HDROP drop, UINT index, LPWSTR buf, UINT n);
void DragFinish(HDROP drop);
BOOL DragQueryPoint(HDROP drop, POINT *p);
HICON ExtractIconW(HINSTANCE inst, LPCWSTR file, UINT index);
void SHAddToRecentDocs(UINT flags, LPCVOID data);

/* ---- 0092 file operations — VENEER-LOCAL (not a Windows API) ----
 * Thin exports over the shared os/fileops.h core (see shell32.c): copy is
 * recursive (symlinks copy as links), move refuses an existing
 * destination (EEXIST), delete is recursive. 0 or -1 with errno set.
 * The SHClip* set rides the 0090 kernel clipboard slot as a format-2
 * file list ("cut\n"/"copy\n" header + one absolute path per line). */
int SHFileCopy(const char *src, const char *dst);
int SHFileMove(const char *src, const char *dst);
int SHFileDelete(const char *path);
int SHPasteDest(const char *dir, const char *name, char *out, int cap);
int SHNewDest(const char *dir, const char *base, const char *ext,
              char *out, int cap);
int SHClipSetFiles(int cut, const char *const *paths, int n);
int SHClipHasFiles(void);
int SHClipLoadFiles(char *buf, int cap, int *cut);
const char *SHClipPath(const char *buf, int i);
int SHClipClear(void);
/* The trash store (0093, fileops.h /root/.recycle): trash moves a path
 * into the store with an original-path sidecar; restore returns a stored
 * entry (its full files/ path) to that original — EEXIST when occupied,
 * so the caller can prompt-and-replace. Empty clears the whole store. */
int SHFileTrash(const char *path);
int SHFileRestore(const char *stored);
int SHRestoreTarget(const char *stored, char *out, int cap);
void SHTrashForget(const char *stored);   /* drop a sidecar (perm delete) */
int SHTrashEmpty(void);
int SHTrashCount(void);
const char *SHTrashFilesDir(void);
#define SHCLIP_MAX 8192              /* fileops.h FO_CLIP_MAX */
#define SHARD_PIDL  1
#define SHARD_PATHA 2
#define SHARD_PATHW 3

#ifdef UNICODE
#define ShellExecute ShellExecuteW
#define ShellAbout ShellAboutW
#define DragQueryFile DragQueryFileW
#define ExtractIcon ExtractIconW
#endif

#define WM_DROPFILES 0x0233
