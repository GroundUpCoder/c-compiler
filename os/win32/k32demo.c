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

    /* OPEN_ALWAYS on an EXISTING file must not carry O_CREAT: on the
     * read-only /usr volume that was EROFS ("write protected") even for
     * GENERIC_READ — the notepad-views-a-/usr-deck regression (0202). */
    h = CreateFile(TEXT("/usr/share/os-release"), GENERIC_READ,
                   FILE_SHARE_READ, NULL, OPEN_ALWAYS, 0, NULL);
    check("OPEN_ALWAYS existing on the RO volume opens (ERROR_ALREADY_EXISTS)",
          h != INVALID_HANDLE_VALUE && GetLastError() == ERROR_ALREADY_EXISTS);
    CloseHandle(h);
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
    /* "*.*" is the DOS-heritage EVERYTHING pattern (0211): it must also
     * match extensionless names */
    HANDLE hx = CreateFileW(u"/root/k32-dir/Makefile", GENERIC_WRITE, 0, NULL,
                            CREATE_ALWAYS, 0, NULL);
    CloseHandle(hx);
    int all = 0;
    HANDLE fa = FindFirstFile(TEXT("/root/k32-dir/*.*"), &fd);
    if (fa != INVALID_HANDLE_VALUE) {
        do { all++; } while (FindNextFile(fa, &fd));
        FindClose(fa);
    }
    check("FindFirstFile *.* matches everything incl. extensionless", all == 4);
    DeleteFile(TEXT("/root/k32-dir/Makefile"));

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
    /* a WRITE view of a PAGE_READONLY mapping must refuse (0211) — the
     * old copy-view silently DROPPED the writes at unmap */
    check("FILE_MAP_WRITE on PAGE_READONLY refused",
          MapViewOfFile(map, FILE_MAP_WRITE, 0, 0, 0) == NULL &&
          GetLastError() == ERROR_ACCESS_DENIED);
    check("UnmapViewOfFile", UnmapViewOfFile(view));
    CloseHandle(map);
    /* single-module world: a NAMED GetModuleHandle is honest NULL (0211;
     * it used to hand a fake "loaded" handle for any DLL name) */
    check("GetModuleHandleW(name) -> NULL",
          GetModuleHandleW(u"uxtheme.dll") == NULL);
    check("GetModuleHandleW(NULL) -> exe base",
          GetModuleHandleW(NULL) != NULL);
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

    /* narrow %hs decodes UTF-8 (CP_ACP == CP_UTF8), not Latin-1
       zero-extension; astral code points become surrogate pairs */
    static const WCHAR expu8[] = { 'h', 0x00E9, 'l', 'l', 'o', ' ', 0x20AC, '|', 'w', 0 };
    len = wsprintfW(out, u"%hs|%s", "h\xc3\xa9llo \xe2\x82\xac", u"w");
    check("wsprintfW %hs decodes UTF-8", len == 9 && lstrcmpW(out, expu8) == 0);
    static const WCHAR expsp[] = { 0xD83D, 0xDE00, '!', 0 };
    len = wsprintfW(out, u"%hs!", "\xf0\x9f\x98\x80");
    check("wsprintfW %hs astral -> surrogate pair", len == 3 && lstrcmpW(out, expsp) == 0);

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

/* ------------------------------------------- the 0288 two-process legs
 *
 * The registry hive is shared by every live win32 process, so a flush
 * must merge, not overwrite (see the header of os/win32/advapi32.c).
 * `reg-race FIRST SECOND` reproduces the exact ordinary flow that used
 * to lose data — two apps open, both mutate, both close:
 *
 *   1. spawn two agents; each opens the hive (taking its snapshot),
 *      makes ITS OWN mutation, and then parks on a go-file — so both
 *      snapshots are taken before either flush lands;
 *   2. release FIRST, wait for it to exit (its flush lands);
 *   3. release SECOND, wait for it to exit (its flush lands SECOND —
 *      this is the flush that used to revert FIRST's write wholesale);
 *   4. read the hive back in a THIRD process (this one, which has not
 *      touched the registry yet, so its load is fresh) and print what
 *      survived.
 *
 * Naming the winner on the command line makes both exit orders one
 * argument apart. An agent spec of `-NAME` DELETES that value instead
 * of writing it, which pins the other half of the merge rule: the
 * delete must survive a peer's later flush (tombstone), and the peer —
 * which loaded the value but never touched it — must NOT resurrect it
 * (only DIRTY values are written back). `reg-set NAME` seeds a value
 * from a throwaway process so a race has something to preserve. */

#define RACE_KEY u"Software\\K32Race"

/* an agent spec is NAME (write) or -NAME (delete) */
static int spec_is_del(const char *spec) { return spec[0] == '-'; }
static const char *spec_name(const char *spec) { return spec + (spec[0] == '-'); }

static void race_wpath(const char *kind, const char *name, WCHAR *out, int cap) {
    char p[256];
    snprintf(p, sizeof p, "/root/k32race-%s-%s", kind, name);
    MultiByteToWideChar(CP_UTF8, 0, p, -1, out, cap);
}

static int race_exists(const WCHAR *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static void race_touch(const WCHAR *path) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
}

/* wait up to ~15s for `path` to appear; 1 = appeared, 0 = timed out */
static int race_wait_file(const WCHAR *path) {
    for (int i = 0; i < 750; i++) {
        if (race_exists(path)) return 1;
        Sleep(20);
    }
    return 0;
}

/* seed a value from a throwaway process (the "already in the hive" case) */
static int reg_set(const char *name) {
    WCHAR wname[64];
    MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 64);
    HKEY h;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, RACE_KEY, 0, NULL, 0,
                        KEY_ALL_ACCESS, NULL, &h, NULL) != ERROR_SUCCESS)
        return 2;
    DWORD one = 1;
    LONG r = RegSetValueExW(h, wname, 0, REG_DWORD, (const BYTE *)&one,
                            sizeof one);
    RegCloseKey(h);
    return r == ERROR_SUCCESS ? 0 : 2;
}

/* one racing "app": snapshot the hive, make my mutation, park, then flush */
static int reg_agent(const char *spec) {
    const char *name = spec_name(spec);
    WCHAR ready[256], go[256], wname[64];
    race_wpath("ready", name, ready, 256);
    race_wpath("go", name, go, 256);
    MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 64);

    HKEY h;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, RACE_KEY, 0, NULL, 0,
                        KEY_ALL_ACCESS, NULL, &h, NULL) != ERROR_SUCCESS)
        return 2;                       /* the hive snapshot is taken here */
    if (spec_is_del(spec)) {
        if (RegDeleteValueW(h, wname) != ERROR_SUCCESS) return 2;
    } else {
        DWORD one = 1;
        if (RegSetValueExW(h, wname, 0, REG_DWORD, (const BYTE *)&one,
                           sizeof one) != ERROR_SUCCESS)
            return 2;
    }
    race_touch(ready);                  /* "loaded and mutated, not flushed" */
    if (!race_wait_file(go)) return 3;
    RegCloseKey(h);                     /* the flush under test */
    return 0;
}

static int reg_race(const char *first, const char *second) {
    const char *who[2] = { first, second };
    HANDLE proc[2];
    for (int i = 0; i < 2; i++) {
        WCHAR ready[256], go[256];
        race_wpath("ready", spec_name(who[i]), ready, 256);
        race_wpath("go", spec_name(who[i]), go, 256);
        DeleteFileW(ready);                          /* no stale handshakes */
        DeleteFileW(go);
        WCHAR cmd[256];
        char line[256];
        snprintf(line, sizeof line, "k32demo reg-agent %s", who[i]);
        MultiByteToWideChar(CP_UTF8, 0, line, -1, cmd, 256);
        STARTUPINFOW si;
        GetStartupInfoW(&si);
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, u"/root",
                            &si, &pi)) {
            printf("reg-race: CreateProcess %s failed\n", who[i]);
            return 2;
        }
        proc[i] = pi.hProcess;
    }
    /* both agents must hold a pre-flush snapshot before EITHER flushes */
    for (int i = 0; i < 2; i++) {
        WCHAR ready[256];
        race_wpath("ready", spec_name(who[i]), ready, 256);
        if (!race_wait_file(ready)) {
            printf("reg-race: agent %s never became ready\n", who[i]);
            return 2;
        }
    }
    /* release them one at a time, in the requested exit order */
    for (int i = 0; i < 2; i++) {
        WCHAR go[256];
        race_wpath("go", spec_name(who[i]), go, 256);
        race_touch(go);
        if (WaitForSingleObject(proc[i], 20000) != WAIT_OBJECT_0) {
            printf("reg-race: agent %s did not exit\n", who[i]);
            return 2;
        }
        DWORD code = 1;
        GetExitCodeProcess(proc[i], &code);
        CloseHandle(proc[i]);
        if (code != 0) {
            printf("reg-race: agent %s exited %u\n", who[i], (unsigned)code);
            return 2;
        }
    }
    /* fresh reader: this process has not touched the registry until now */
    HKEY h;
    int got[2] = { 0, 0 };
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RACE_KEY, 0, KEY_READ, &h) ==
        ERROR_SUCCESS) {
        for (int i = 0; i < 2; i++) {
            WCHAR wname[64];
            MultiByteToWideChar(CP_UTF8, 0, spec_name(who[i]), -1, wname, 64);
            DWORD v = 0, type = 0, cb = sizeof v;
            got[i] = RegQueryValueExW(h, wname, NULL, &type, (LPBYTE)&v, &cb) ==
                         ERROR_SUCCESS && type == REG_DWORD && v == 1;
        }
        RegCloseKey(h);
    }
    /* a writer's value must be there, a deleter's must be gone */
    int ok = 1;
    for (int i = 0; i < 2; i++)
        if (got[i] != !spec_is_del(who[i])) ok = 0;
    printf("reg-race(%s,%s): %s=%d %s=%d -> %s\n", first, second,
           spec_name(who[0]), got[0], spec_name(who[1]), got[1],
           ok ? "OK" : "LOST");
    return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc > 2 && strcmp(argv[1], "reg-set") == 0)
        return reg_set(argv[2]);
    if (argc > 2 && strcmp(argv[1], "reg-agent") == 0)
        return reg_agent(argv[2]);
    if (argc > 3 && strcmp(argv[1], "reg-race") == 0)
        return reg_race(argv[2], argv[3]);
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
