#!/usr/bin/env node
// Lua + SQLite as linkable source libraries (#663): each library's own
// header carries its __require_source block (source-lib §4.2, the zlib.h
// pattern), so the in-OS `cc` embeds the Lua interpreter from a bare
// #include <lua.h> and links the whole SQLite engine from a bare
// #include <sqlite3.h> — no -I, no TU list. Both are the FIRST packages
// that ship a binary AND a srclib in ONE package (the ticket's (a) ruling:
// the package that owns the NAME owns everything planted under it), so the
// acceptance's "install order both ways" is dissolved by construction —
// there is no second package to order. What replaces it here: ONE install
// plants bin + include + src tiers together, `gucman remove` unplants ALL
// of them, and a reinstall restores them.
//
//   - FAT image: luaembed.c really runs Lua (define a fib, call it, read
//     integer + _VERSION back; sizeof(lua_Integer)==4 pins the C89-numbers
//     ABI the header now hardwires); sqlembed.c opens a file-backed DB on
//     the writable volume, INSERTs, closes, REOPENS and reads the rows
//     back. The hatches (-DLUA_NO_REQUIRE_SOURCES /
//     -DSQLITE_NO_REQUIRE_SOURCES) must fail AT LINK naming a library
//     symbol — the proof the header block is the link metadata. The
//     shipped shells keep working, unchanged (piped lua + sqlite3).
//   - MINIMAL image (no packages baked) + the served index: absence is
//     honest (<lua.h>/<sqlite3.h> fail clean, no shells), then `gucman
//     install lua` / `gucman install sqlite3` each plant bin + srclib
//     tiers from the ONE package and the same programs compile and run;
//     `gucman remove lua` unplants BOTH tiers (compile fails clean again,
//     shell gone), and a reinstall works.
//
// Run: node tests/kernel/test_cc_lua_sqlite_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const writeApp = (path, lines) => [`cat > ${path} << 'EOF'`, ...lines, 'EOF'];

// <lua.h>/<lauxlib.h>/<lualib.h> ONLY — embed the interpreter: state, stdlib,
// run a chunk that defines + calls a function, read multiple results back.
const LUAEMBED_C = [
  '#include <stdio.h>',
  '#include <lua.h>',
  '#include <lauxlib.h>',
  '#include <lualib.h>',
  'int main(void) {',
  '    lua_State *L = luaL_newstate();',
  '    if (!L) { printf("LUAEMBED-STATE-FAIL\\n"); return 1; }',
  '    luaL_openlibs(L);',
  '    if (luaL_dostring(L, "function fib(n) if n<2 then return n end"',
  '        " return fib(n-1)+fib(n-2) end return fib(10), _VERSION")) {',
  '        printf("LUAEMBED-ERR %s\\n", lua_tostring(L, -1)); return 1; }',
  '    printf("LUAEMBED fib=%d ver=%s int=%d\\n", (int)lua_tointeger(L, -2),',
  '           lua_tostring(L, -1), (int)sizeof(lua_Integer));',
  '    lua_close(L);',
  '    printf("LUAEMBED-DONE\\n");',
  '    return 0;',
  '}',
];
// int=4 pins the LUA_C89_NUMBERS ABI (luaconf.h hardwires LUA_USE_C89 since
// #663 precisely so a flagless consumer TU and the library TUs agree).
const LUAEMBED_OK = /LUAEMBED fib=55 ver=Lua 5\.5 int=4/;

// <sqlite3.h> ONLY — file-backed DB on the writable volume: create, insert,
// close, REOPEN (the rows really landed on disk), select back.
const SQLEMBED_C = [
  '#include <stdio.h>',
  '#include <sqlite3.h>',
  'static int cb(void *n, int argc, char **argv, char **col) {',
  '    (void)col; (void)argc; (*(int *)n)++;',
  '    printf("ROW %s|%s\\n", argv[0], argv[1]);',
  '    return 0;',
  '}',
  'int main(void) {',
  '    sqlite3 *db; char *err = 0; int rows = 0;',
  '    if (sqlite3_open("/root/t663.db", &db) != SQLITE_OK) { printf("SQL-OPEN-FAIL\\n"); return 1; }',
  '    if (sqlite3_exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);"',
  '        "INSERT INTO t VALUES(1,\'alice\'),(2,\'bob\');", 0, 0, &err) != SQLITE_OK) {',
  '        printf("SQL-EXEC-FAIL %s\\n", err); return 1; }',
  '    sqlite3_close(db);',
  '    if (sqlite3_open("/root/t663.db", &db) != SQLITE_OK) { printf("SQL-REOPEN-FAIL\\n"); return 1; }',
  '    if (sqlite3_exec(db, "SELECT id, name FROM t ORDER BY id;", cb, &rows, &err) != SQLITE_OK) {',
  '        printf("SQL-SELECT-FAIL %s\\n", err); return 1; }',
  '    printf("SQLEMBED rows=%d ver=%s\\n", rows, sqlite3_libversion());',
  '    sqlite3_close(db);',
  '    printf("SQLEMBED-DONE\\n");',
  '    return 0;',
  '}',
];
const SQLEMBED_OK = (s) => /ROW 1\|alice/.test(s) && /ROW 2\|bob/.test(s) &&
  /SQLEMBED rows=2 ver=3\.53\.1/.test(s);

// The shipped shells, piped (exit clean on EOF — the todos/0036 contract).
const SHELL_LEGS = [
  'echo ==shells',
  `echo 'print("shell-ok", 2^10)' | lua`,
  'echo shlrc=$?',
  `echo 'select 40+2;' | sqlite3`,
  'echo shsrc=$?',
];
function checkShells(out, label) {
  const sh = section(out, 'shells');
  check(label + ': the lua shell still works, unchanged (piped)',
    sh.includes('shell-ok\t1024.0') && sh.includes('shlrc=0'), sh);
  check(label + ': the sqlite3 shell still works, unchanged (piped)',
    sh.includes('42') && sh.includes('shsrc=0'), sh);
}

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-luasql-');
  const scriptA = [
    ...writeApp('/root/luaembed.c', LUAEMBED_C),
    ...writeApp('/root/sqlembed.c', SQLEMBED_C),
    'cd /root',
    'echo ==lua',
    'cc luaembed.c -o luaembed && ./luaembed',
    'echo lrc=$?',
    'echo ==sql',
    'cc sqlembed.c -o sqlembed && ./sqlembed',
    'echo src=$?',
    // the hatches: with a block suppressed nothing links that library.
    // NB no pipeline: `cc ... | head` would make $? head's status (the
    // imagelibs e2e's rule).
    'echo ==lhatch',
    'cc -DLUA_NO_REQUIRE_SOURCES luaembed.c -o lhatch.out 2>&1',
    'echo lhrc=$?',
    'echo ==shatch',
    'cc -DSQLITE_NO_REQUIRE_SOURCES sqlembed.c -o shatch.out 2>&1',
    'echo shrc=$?',
    ...SHELL_LEGS,
    'echo ==pkgs',
    'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 900000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const lu = section(aout, 'lua');
  check('fat: <lua.h> STANDALONE embeds the interpreter (fib via lua, C89 ABI pinned)',
    LUAEMBED_OK.test(lu) && lu.includes('LUAEMBED-DONE') && lu.includes('lrc=0'), lu);
  const sq = section(aout, 'sql');
  check('fat: <sqlite3.h> STANDALONE links the engine (file-backed rows survive a reopen)',
    SQLEMBED_OK(sq) && sq.includes('SQLEMBED-DONE') && sq.includes('src=0'), sq);
  const lh = section(aout, 'lhatch');
  check('fat: LUA_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*lua/i.test(lh) && /lhrc=[^0]/.test(lh), lh);
  const sh = section(aout, 'shatch');
  check('fat: SQLITE_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*sqlite3_/i.test(sh) && /shrc=[^0]/.test(sh), sh);
  checkShells(aout, 'fat');
  const pkgs = section(aout, 'pkgs');
  check('fat: both folded as built-in packages (os-release PACKAGES=)',
    ['lua', 'sqlite3'].every(
      (n) => new RegExp('^PACKAGES=(.*,)?' + n + '(,|$)', 'm').test(aout)), pkgs);

  /* ---- session B: minimal image + the served index ---- */
  const repo = ensurePackages(['lua', 'sqlite3']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-luasql-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const port = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/luaembed.c', LUAEMBED_C),
    ...writeApp('/root/sqlembed.c', SQLEMBED_C),
    'cd /root',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    // absence is honest before anything is installed: no headers, no shells.
    'echo ==absent',
    'cc luaembed.c 2>&1',
    'echo larc=$?',
    'cc sqlembed.c 2>&1',
    'echo sarc=$?',
    'lua -v 2>&1',
    'echo lsrc=$?',
    // ONE install plants bin + include + src together (the (a) shape).
    'echo ==linstall',
    'gucman install lua; echo LRC=$?',
    'test -f /usr/local/include/lua.h && echo LUA-INC-OK',
    'test -f /usr/local/src/lua/lapi.c && echo LUA-SRC-OK',
    'test -x /usr/local/bin/lua && echo LUA-BIN-OK',
    'cc luaembed.c -o luaembed && ./luaembed',
    'echo lrc=$?',
    'echo ==sinstall',
    'gucman install sqlite3; echo SRC=$?',
    'test -f /usr/local/include/sqlite3.h && echo SQL-INC-OK',
    'test -f /usr/local/src/sqlite3/sqlite3.c && echo SQL-SRC-OK',
    'test -x /usr/local/bin/sqlite3 && echo SQL-BIN-OK',
    'cc sqlembed.c -o sqlembed && ./sqlembed',
    'echo src=$?',
    ...SHELL_LEGS,
    // remove unplants BOTH tiers — the one-package shape's removal contract.
    'echo ==remove',
    'gucman remove lua; echo RMRC=$?',
    'cc luaembed.c -o luaembed2 2>&1',
    'echo rarc=$?',
    'test -e /usr/local/bin/lua || echo LUA-BIN-GONE',
    'test -e /usr/local/include/lua.h || echo LUA-INC-GONE',
    'test -e /usr/local/src/lua || echo LUA-SRC-GONE',
    // and a reinstall restores everything.
    'echo ==reinstall',
    'gucman install lua; echo RIRC=$?',
    'cc luaembed.c -o luaembed3 && ./luaembed3',
    'echo rirc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 900000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const absent = section(bout, 'absent');
  check('minimal: <lua.h>/<sqlite3.h> fail CLEAN and no shell, with nothing installed',
    /Could not find include file: lua\.h/.test(absent) &&
    /Could not find include file: sqlite3\.h/.test(absent) &&
    /larc=[^0]/.test(absent) && /sarc=[^0]/.test(absent) && /lsrc=(?!0)/.test(absent), absent);
  const li = section(bout, 'linstall');
  check('minimal: gucman install lua plants bin + include + src from the ONE package',
    li.includes('LRC=0') && li.includes('LUA-INC-OK') && li.includes('LUA-SRC-OK') &&
    li.includes('LUA-BIN-OK'), li);
  check('minimal: <lua.h> embeds + runs through the installed tiers',
    LUAEMBED_OK.test(li) && li.includes('lrc=0'), li);
  const si = section(bout, 'sinstall');
  check('minimal: gucman install sqlite3 plants bin + include + src from the ONE package',
    si.includes('SRC=0') && si.includes('SQL-INC-OK') && si.includes('SQL-SRC-OK') &&
    si.includes('SQL-BIN-OK'), si);
  check('minimal: <sqlite3.h> links + round-trips through the installed tiers',
    SQLEMBED_OK(si) && si.includes('src=0'), si);
  checkShells(bout, 'minimal (installed)');
  const rm = section(bout, 'remove');
  check('minimal: gucman remove lua unplants BOTH tiers (compile fails clean, bin gone)',
    rm.includes('RMRC=0') && /Could not find include file: lua\.h/.test(rm) &&
    /rarc=[^0]/.test(rm) && rm.includes('LUA-BIN-GONE') &&
    rm.includes('LUA-INC-GONE') && rm.includes('LUA-SRC-GONE'), rm);
  const ri = section(bout, 'reinstall');
  check('minimal: reinstall restores the working library',
    ri.includes('RIRC=0') && LUAEMBED_OK.test(ri) && ri.includes('rirc=0'), ri);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-lua-sqlite e2e: ${failures} FAILED` : '\ncc-lua-sqlite e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
