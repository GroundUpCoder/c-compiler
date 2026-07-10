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
