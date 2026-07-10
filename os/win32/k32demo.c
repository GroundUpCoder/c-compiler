/* k32demo.c — the 0059 kernel32 acceptance app (design todos/WIN32.md).
 *
 * A UNICODE console program (the corpus's build flavor) that exercises
 * the kernel32/advapi32/wide-CRT veneer end to end and self-checks like
 * gdidemo's selftest: files, seek/size/truncate, directories, wildcard
 * find, file mapping, memory, time, UTF-16<->UTF-8, the registry hive,
 * the profile shim, CreateProcess -> the real posix_spawn (a child
 * writes through a redirected std handle), and the clear-failure stubs.
 *
 * The POSIX-twin identity legs: it writes /root/k32-out.txt through
 * WriteFile (the e2e diffs it against hush's cat) and reads back a file
 * hush created (byte equality both directions across the veneer).
 *
 * Prints "K32: <pass>/<total> PASS" and exits 0 only when everything
 * passed. Run a second time it also proves registry persistence
 * (k32demo reg-persist prints the round-tripped value).
 */

#include <windows.h>
#include <tchar.h>
#include <strsafe.h>
#include <stdio.h>
#include <string.h>

static int g_pass, g_total;

static void check(const char *name, int cond) {
    g_total++;
    if (cond) { g_pass++; return; }
    printf("FAIL %s\n", name);
}

/* narrow a WCHAR string for printf */
static const char *n8(const WCHAR *w) {
    static char buf[4][512];
    static int slot;
    slot = (slot + 1) & 3;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, buf[slot], 512, NULL, NULL);
    return buf[slot];
}

static void test_files(void) {
    /* create + write */
    HANDLE h = CreateFile(TEXT("/root/k32-out.txt"), GENERIC_WRITE, 0, NULL,
                          CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    check("CreateFile CREATE_ALWAYS", h != INVALID_HANDLE_VALUE);
    const char *text = "kernel32 wrote this line\nsecond line\n";
    DWORD wr = 0;
    check("WriteFile", WriteFile(h, text, (DWORD)strlen(text), &wr, NULL) &&
                       wr == (DWORD)strlen(text));
    check("GetFileSize", GetFileSize(h, NULL) == (DWORD)strlen(text));

    /* seek + read back through the same handle? handle is write-only;
     * reopen for read */
    check("CloseHandle", CloseHandle(h));
    h = CreateFile(TEXT("/root/k32-out.txt"), GENERIC_READ, FILE_SHARE_READ,
                   NULL, OPEN_EXISTING, 0, NULL);
    check("CreateFile OPEN_EXISTING", h != INVALID_HANDLE_VALUE);
    check("SetFilePointer", SetFilePointer(h, 9, NULL, FILE_BEGIN) == 9);
    char buf[64] = { 0 };
    DWORD rd = 0;
    check("ReadFile at offset", ReadFile(h, buf, 10, &rd, NULL) && rd == 10 &&
                                memcmp(buf, "wrote this", 10) == 0);
    /* EOF: TRUE with zero read */
    SetFilePointer(h, 0, NULL, FILE_END);
    check("ReadFile at EOF -> TRUE, 0 bytes",
          ReadFile(h, buf, 8, &rd, NULL) && rd == 0);
    CloseHandle(h);

    /* error path: missing file sets ERROR_FILE_NOT_FOUND */
    h = CreateFile(TEXT("/root/k32-missing.txt"), GENERIC_READ, 0, NULL,
                   OPEN_EXISTING, 0, NULL);
    check("missing file -> INVALID_HANDLE_VALUE + ERROR_FILE_NOT_FOUND",
          h == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND);

    /* read back what hush wrote (POSIX-twin leg, direction 2) */
    h = CreateFile(TEXT("/root/k32-posix.txt"), GENERIC_READ, 0, NULL,
                   OPEN_EXISTING, 0, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        rd = 0;
        ReadFile(h, buf, sizeof buf - 1, &rd, NULL);
        buf[rd] = 0;
        printf("posix-says: %s", buf);
        CloseHandle(h);
    }

    /* truncate via SetEndOfFile */
    h = CreateFile(TEXT("/root/k32-trunc.txt"), GENERIC_READ | GENERIC_WRITE,
                   0, NULL, CREATE_ALWAYS, 0, NULL);
    WriteFile(h, "0123456789", 10, &wr, NULL);
    SetFilePointer(h, 4, NULL, FILE_BEGIN);
    check("SetEndOfFile", SetEndOfFile(h) && GetFileSize(h, NULL) == 4);
    check("FlushFileBuffers", FlushFileBuffers(h));
    CloseHandle(h);

    /* CREATE_ALWAYS on an existing file reports ERROR_ALREADY_EXISTS */
    h = CreateFile(TEXT("/root/k32-trunc.txt"), GENERIC_WRITE, 0, NULL,
                   CREATE_ALWAYS, 0, NULL);
    check("CREATE_ALWAYS existing -> ERROR_ALREADY_EXISTS",
          h != INVALID_HANDLE_VALUE && GetLastError() == ERROR_ALREADY_EXISTS);
    CloseHandle(h);
    check("DeleteFile", DeleteFile(TEXT("/root/k32-trunc.txt")));
}

static void test_dirs_find(void) {
    check("CreateDirectory", CreateDirectory(TEXT("/root/k32-dir"), NULL));
    check("CreateDirectory again -> FALSE + ERROR_ALREADY_EXISTS",
          !CreateDirectory(TEXT("/root/k32-dir"), NULL) &&
          GetLastError() == ERROR_ALREADY_EXISTS);
    check("GetFileAttributes directory",
          GetFileAttributes(TEXT("/root/k32-dir")) & FILE_ATTRIBUTE_DIRECTORY);

    /* seed three files, then wildcard them */
    static const WCHAR *names[3] = {
        u"/root/k32-dir/alpha.txt", u"/root/k32-dir/beta.txt",
        u"/root/k32-dir/gamma.dat" };
    for (int i = 0; i < 3; i++) {
        HANDLE h = CreateFileW(names[i], GENERIC_WRITE, 0, NULL,
                               CREATE_ALWAYS, 0, NULL);
        DWORD wr;
        WriteFile(h, "x", 1, &wr, NULL);
        CloseHandle(h);
    }
    WIN32_FIND_DATA fd;
    HANDLE f = FindFirstFile(TEXT("/root/k32-dir/*.txt"), &fd);
    int count = 0, sawAlpha = 0, sizesOk = 1;
    if (f != INVALID_HANDLE_VALUE) {
        do {
            count++;
            if (lstrcmpiW(fd.cFileName, u"alpha.txt") == 0) sawAlpha = 1;
            if (fd.nFileSizeLow != 1) sizesOk = 0;
        } while (FindNextFile(f, &fd));
        check("FindNextFile exhausts with ERROR_NO_MORE_FILES",
              GetLastError() == ERROR_NO_MORE_FILES);
        FindClose(f);
    }
    check("FindFirstFile *.txt matches exactly 2", count == 2);
    check("find saw alpha.txt with size 1", sawAlpha && sizesOk);
    check("FindFirstFile no match -> ERROR_FILE_NOT_FOUND",
          FindFirstFile(TEXT("/root/k32-dir/*.nope"), &fd) == INVALID_HANDLE_VALUE &&
          GetLastError() == ERROR_FILE_NOT_FOUND);

    /* MoveFile + RemoveDirectory */
    check("MoveFile", MoveFile(TEXT("/root/k32-dir/gamma.dat"),
                               TEXT("/root/k32-dir/delta.dat")));
    check("moved file exists",
          GetFileAttributes(TEXT("/root/k32-dir/delta.dat")) != INVALID_FILE_ATTRIBUTES);
    check("RemoveDirectory non-empty -> FALSE",
          !RemoveDirectory(TEXT("/root/k32-dir")));
    DeleteFile(TEXT("/root/k32-dir/alpha.txt"));
    DeleteFile(TEXT("/root/k32-dir/beta.txt"));
    DeleteFile(TEXT("/root/k32-dir/delta.dat"));
    check("RemoveDirectory empty", RemoveDirectory(TEXT("/root/k32-dir")));

    /* GetFullPathName resolves and normalizes */
    WCHAR full[MAX_PATH];
    WCHAR *filePart = NULL;
    DWORD n = GetFullPathName(TEXT("/root/./k32-dir/../k32-out.txt"),
                              MAX_PATH, full, &filePart);
    check("GetFullPathName normalizes",
          n > 0 && lstrcmpW(full, u"/root/k32-out.txt") == 0);
    check("GetFullPathName file part", filePart &&
          lstrcmpW(filePart, u"k32-out.txt") == 0);
}

static void test_mapping(void) {
    HANDLE h = CreateFile(TEXT("/root/k32-out.txt"), GENERIC_READ, 0, NULL,
                          OPEN_EXISTING, 0, NULL);
    HANDLE map = CreateFileMappingW(h, NULL, PAGE_READONLY, 0, 0, NULL);
    check("CreateFileMapping", map != NULL);
    DWORD size = GetFileSize(h, NULL);
    CloseHandle(h);                               /* view outlives the file handle */
    char *view = (char *)MapViewOfFile(map, FILE_MAP_READ, 0, 0, 0);
    check("MapViewOfFile content", view != NULL &&
          memcmp(view, "kernel32 wrote", 14) == 0);
    check("view spans the file", view != NULL && view[size - 1] == '\n');
    check("UnmapViewOfFile", UnmapViewOfFile(view));
    CloseHandle(map);
}

static void test_memory(void) {
    HGLOBAL g = GlobalAlloc(GHND, 64);
    char *p = (char *)GlobalLock(g);
    int zeroed = 1;
    for (int i = 0; i < 64; i++) zeroed &= p[i] == 0;
    check("GlobalAlloc GHND zeroed + lock", p != NULL && zeroed);
    check("GlobalSize", GlobalSize(g) == 64);
    GlobalUnlock(g);
    check("GlobalFree -> NULL", GlobalFree(g) == NULL);

    HLOCAL l = LocalAlloc(LPTR, 32);
    check("LocalAlloc + LocalLock", LocalLock(l) != NULL);
    LocalUnlock(l);
    LocalFree(l);

    char *hp = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 16);
    check("HeapAlloc zeroed", hp != NULL && hp[15] == 0);
    memset(hp, 0x5A, 16);
    hp = (char *)HeapReAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, hp, 64);
    check("HeapReAlloc keeps data, zeroes growth",
          hp != NULL && hp[15] == 0x5A && hp[63] == 0);
    check("HeapFree", HeapFree(GetProcessHeap(), 0, hp));

    void *v = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    check("VirtualAlloc zeroed", v != NULL && ((char *)v)[4095] == 0);
    check("VirtualFree", VirtualFree(v, 0, MEM_RELEASE));
}

static void test_strings(void) {
    /* UTF-16 <-> UTF-8 round trip through non-ASCII code points:
     * "café ☃" = 6 WCHARs; utf8 = 3 + 2(é) + 1 + 3(☃) + NUL = 10 bytes */
    const WCHAR *w = u"caf\x00e9 \x2603";
    char u8[64];
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, u8, sizeof u8, NULL, NULL);
    check("WideCharToMultiByte len", n == 10);
    WCHAR back[64];
    int m = MultiByteToWideChar(CP_UTF8, 0, u8, -1, back, 64);
    check("MultiByteToWideChar round-trip", m == 7 && lstrcmpW(back, w) == 0);

    check("lstrlenW", lstrlenW(w) == 6);
    WCHAR tmp[32];
    lstrcpynW(tmp, u"truncate-me", 9);
    check("lstrcpynW truncates + terminates", lstrlenW(tmp) == 8 &&
          lstrcmpW(tmp, u"truncate") == 0);
    check("lstrcmpiW", lstrcmpiW(u"HeLLo", u"hello") == 0);

    /* wsprintfW */
    WCHAR out[128];
    int len = wsprintfW(out, u"%s=%d 0x%X [%3u]", u"n", -5, 0xBEEF, 7u);
    check("wsprintfW", lstrcmpW(out, u"n=-5 0xBEEF [  7]") == 0 && len == 17);

    /* the wide CRT */
    check("_tcslen/_tcscmp", _tcslen(u"abc") == 3 && _tcscmp(u"a", u"b") < 0);
    check("_tcsicmp", _tcsicmp(u"WinMine", u"WINMINE") == 0);
    check("_tcsrchr", lstrcmpW(_tcsrchr(u"a/b/c", '/'), u"/c") == 0);
    check("_totupper", _totupper('q') == 'Q' && _istalnum('7') && !_istalnum('!'));
    check("_ttoi", _ttoi(u"-42") == -42);

    /* _stscanf: calc's exact conversions */
    unsigned long long v64 = 0;
    check("_stscanf %I64X", _stscanf(u"DEADBEEFCAFE", u"%I64X", &v64) == 1 &&
                            v64 == 0xDEADBEEFCAFEull);
    double d = 0;
    check("_stscanf %lf", _stscanf(u"-2.5e2", u"%lf", &d) == 1 && d == -250.0);
    v64 = 0;
    check("_stscanf %I64o", _stscanf(u"777", u"%I64o", &v64) == 1 && v64 == 0777);

    /* strsafe */
    WCHAR sb[8];
    check("StringCchCopyW fits", StringCchCopyW(sb, 8, u"seven77") == S_OK);
    check("StringCchCopyW truncates",
          StringCchCopyW(sb, 8, u"eight888") == STRSAFE_E_INSUFFICIENT_BUFFER &&
          lstrcmpW(sb, u"eight88") == 0);
    check("StringCchPrintfW", StringCchPrintfW(sb, 8, u"%d-%d", 12, 34) == S_OK &&
                              lstrcmpW(sb, u"12-34") == 0);
    WCHAR cb[16];
    check("StringCbPrintfW cap is bytes",
          StringCbPrintfW(cb, sizeof cb, u"%u", 12345u) == S_OK &&
          lstrcmpW(cb, u"12345") == 0);
    char up[8];
    strcpy(up, "mIx3d");
    check("_strupr", strcmp(_strupr(up), "MIX3D") == 0);
}

static void test_time(void) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    check("GetLocalTime sane", st.wYear >= 2024 && st.wMonth >= 1 &&
          st.wMonth <= 12 && st.wDay >= 1 && st.wDay <= 31 && st.wHour < 24);

    DWORD t0 = GetTickCount();
    LARGE_INTEGER c0, c1, freq;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&c0);
    Sleep(30);
    QueryPerformanceCounter(&c1);
    DWORD t1 = GetTickCount();
    check("GetTickCount advances across Sleep", t1 - t0 >= 20 && t1 - t0 < 5000);
    long long dns = c1.QuadPart - c0.QuadPart;
    check("QueryPerformanceCounter advances",
          dns > 0 && freq.QuadPart == 1000000000ll);

    WCHAR buf[64];
    st.wYear = 2026; st.wMonth = 7; st.wDay = 10; st.wDayOfWeek = 5;
    st.wHour = 15; st.wMinute = 4; st.wSecond = 9;
    GetDateFormatW(LOCALE_USER_DEFAULT, DATE_LONGDATE, &st, NULL, buf, 64);
    check("GetDateFormatW long", lstrcmpW(buf, u"Friday, July 10, 2026") == 0);
    GetTimeFormatW(LOCALE_USER_DEFAULT, 0, &st, NULL, buf, 64);
    check("GetTimeFormatW", lstrcmpW(buf, u"3:04:09 PM") == 0);
    GetLocaleInfoW(LOCALE_USER_DEFAULT, LOCALE_SDECIMAL, buf, 64);
    check("GetLocaleInfoW SDECIMAL", lstrcmpW(buf, u".") == 0);
}

static void test_registry(void) {
    HKEY h;
    DWORD disp = 0;
    check("RegCreateKeyEx",
          RegCreateKeyExW(HKEY_CURRENT_USER, u"Software\\K32Demo", 0, NULL, 0,
                          KEY_ALL_ACCESS, NULL, &h, &disp) == ERROR_SUCCESS);
    DWORD val = 12345;
    check("RegSetValueEx DWORD",
          RegSetValueExW(h, u"Answer", 0, REG_DWORD, (const BYTE *)&val,
                         sizeof val) == ERROR_SUCCESS);
    static const WCHAR name[] = u"Minesweeper Fan";
    check("RegSetValueEx SZ",
          RegSetValueExW(h, u"Name1", 0, REG_SZ, (const BYTE *)name,
                         sizeof name) == ERROR_SUCCESS);
    RegCloseKey(h);

    check("RegOpenKeyEx existing",
          RegOpenKeyExW(HKEY_CURRENT_USER, u"Software\\K32Demo", 0, KEY_READ,
                        &h) == ERROR_SUCCESS);
    DWORD got = 0, type = 0, cb = sizeof got;
    check("RegQueryValueEx DWORD round-trip",
          RegQueryValueExW(h, u"answer", NULL, &type, (LPBYTE)&got, &cb) ==
              ERROR_SUCCESS && type == REG_DWORD && got == 12345 && cb == 4);
    WCHAR wgot[32];
    cb = sizeof wgot;
    check("RegQueryValueEx SZ round-trip (case-insensitive name)",
          RegQueryValueExW(h, u"NAME1", NULL, &type, (LPBYTE)wgot, &cb) ==
              ERROR_SUCCESS && type == REG_SZ && lstrcmpW(wgot, name) == 0);
    cb = 2;                                        /* deliberately small */
    check("RegQueryValueEx short buffer -> ERROR_MORE_DATA + size",
          RegQueryValueExW(h, u"Name1", NULL, NULL, (LPBYTE)wgot, &cb) ==
              ERROR_MORE_DATA && cb == sizeof name);
    RegCloseKey(h);

    check("RegOpenKeyEx missing -> ERROR_FILE_NOT_FOUND",
          RegOpenKeyExW(HKEY_CURRENT_USER, u"Software\\NoSuchKey60", 0,
                        KEY_READ, &h) == ERROR_FILE_NOT_FOUND);

    /* the profile shim rides the same hive */
    check("WriteProfileString", WriteProfileStringW(u"K32Demo", u"layout", u"2"));
    check("GetProfileInt reads it back",
          GetProfileIntW(u"K32Demo", u"layout", 0) == 2);
    check("GetProfileInt default", GetProfileIntW(u"K32Demo", u"nope", 7) == 7);
}

static void test_process(void) {
    /* spawn `sh -c` writing through a redirected stdout handle — the
     * kernel32 twin of `sh -c ... > file` */
    HANDLE out = CreateFile(TEXT("/root/k32-child.txt"), GENERIC_WRITE, 0,
                            NULL, CREATE_ALWAYS, 0, NULL);
    STARTUPINFO si;
    GetStartupInfo(&si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = out;
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION pi;
    WCHAR cmd[] = u"sh -c \"echo spawned-by-kernel32; exit 3\"";
    BOOL ok = CreateProcess(NULL, cmd, NULL, NULL, TRUE, 0, NULL,
                            u"/root", &si, &pi);
    check("CreateProcess sh -c", ok);
    if (ok) {
        check("WaitForSingleObject", WaitForSingleObject(pi.hProcess, INFINITE) ==
                                     WAIT_OBJECT_0);
        DWORD code = 0;
        check("GetExitCodeProcess", GetExitCodeProcess(pi.hProcess, &code) &&
                                    code == 3);
        CloseHandle(pi.hProcess);
    }
    CloseHandle(out);
    HANDLE h = CreateFile(TEXT("/root/k32-child.txt"), GENERIC_READ, 0, NULL,
                          OPEN_EXISTING, 0, NULL);
    char buf[64] = { 0 };
    DWORD rd = 0;
    ReadFile(h, buf, sizeof buf - 1, &rd, NULL);
    CloseHandle(h);
    check("child wrote through the redirected handle",
          strcmp(buf, "spawned-by-kernel32\n") == 0);
    DeleteFile(TEXT("/root/k32-child.txt"));

    check("GetCurrentProcessId", GetCurrentProcessId() > 0);
    WCHAR mod[MAX_PATH];
    DWORD n = GetModuleFileNameW(NULL, mod, MAX_PATH);
    check("GetModuleFileName absolute", n > 0 && mod[0] == '/');
    printf("module: %s\n", n8(mod));
    printf("cmdline: %s\n", n8(GetCommandLineW()));

    /* the deliberate clear-failure stubs */
    check("CreateThread -> NULL + ERROR_CALL_NOT_IMPLEMENTED",
          CreateThread(NULL, 0, NULL, NULL, 0, NULL) == NULL &&
          GetLastError() == ERROR_CALL_NOT_IMPLEMENTED);
    check("LoadLibrary -> NULL (graceful degrade)",
          LoadLibraryW(u"UXTHEME") == NULL);
    OSVERSIONINFOW vi;
    vi.dwOSVersionInfoSize = sizeof vi;
    check("GetVersionEx reports NT",
          GetVersionExW(&vi) && vi.dwPlatformId == VER_PLATFORM_WIN32_NT);

    /* misc boundary bits notepad leans on */
    static const unsigned char bom[] = { 0xFF, 0xFE, 'h', 0, 'i', 0 };
    int itFlags = IS_TEXT_UNICODE_SIGNATURE;
    check("IsTextUnicode BOM", IsTextUnicode(bom, sizeof bom, &itFlags) &&
                               itFlags == IS_TEXT_UNICODE_SIGNATURE);
    check("IsTextUnicode rejects UTF-8", !IsTextUnicode("plain ascii text", 16, NULL));
    WCHAR msg[128];
    check("FormatMessage known error",
          FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM, NULL, ERROR_FILE_NOT_FOUND,
                         0, msg, 128, NULL) > 0 &&
          lstrcmpW(msg, u"The system cannot find the file specified.") == 0);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "reg-persist") == 0) {
        /* second-session probe: the hive persisted to $HOME/.win32reg */
        UINT v = GetProfileIntW(u"K32Demo", u"layout", 0);
        printf("reg-persist: layout=%u\n", v);
        return v == 2 ? 0 : 1;
    }

    test_files();
    test_dirs_find();
    test_mapping();
    test_memory();
    test_strings();
    test_time();
    test_registry();
    test_process();

    printf("K32: %d/%d PASS\n", g_pass, g_total);
    return g_pass == g_total ? 0 : 1;
}
