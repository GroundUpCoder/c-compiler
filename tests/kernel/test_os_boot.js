#!/usr/bin/env node
// OS acceptance, headless (0004 + 0005): the reference OS boots under plain
// Node with busybox hush as pid 1 (/bin/sh), driven the way an agent or CI
// would drive it — pipes and exit codes.
//
//   - first boot seeds the image from os/image.json: protoshell, cc,
//     BUSYBOX HUSH built from vendor/busybox/bin.json, and the busybox
//     COREUTILS multicall (vendor/busybox/coreutils.json) with its /bin
//     applet symlinks — all by the kernel's own compiler (no build step)
//   - the shell is real: pipelines (cross-process), command substitution
//     (spawn-self with serialized state, the NOMMU re-exec machinery on
//     __spawn), redirections, here-docs (bash-style temp file), control
//     flow, functions, exit-status propagation
//   - `cc hello.c && ./a.out` — the OS compiles and runs a program
//   - popen()/system() light up (the 0005 acceptance): a C program written
//     via here-doc, compiled in-OS, runs `popen("... | cat")` and
//     `system("... > file")`
//   - a second boot on the same image REUSES it; files persist
//   - the 0040 layout: a writable root volume at / and a READ-ONLY baked
//     system blob at /usr (/bin -> /usr/bin). Upgrades swap the blob and
//     never touch user territory; writes under /usr are EROFS; factory
//     reset (wipe /etc + /var) boots identically
//
// Run: node tests/kernel/test_os_boot.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-boot-'));
const image = path.join(tmp, 'os.img');

function session(input, extraArgs) {
  // Not --quiet: the [boot] lines on stderr are themselves under test
  // (seeded vs reused); program stdout stays byte-clean either way (hush is
  // non-interactive under piped stdio — no prompts).
  const r = cp.spawnSync('node',
    [BOOT, '--image=' + image].concat(extraArgs || []),
    { input, encoding: 'utf8', timeout: 300000 });
  if (r.error) throw r.error;
  return r;
}

// ---- first boot: seed + the full shell gauntlet ----
let r = session([
  'ls /',                                  // seeded tree (tiny native ls)
  'echo A | cat | cat',                    // 3-stage cross-process pipeline
  'echo sub=$(echo inner $(echo deep))',   // nested command substitution
  'echo redir > /root/r.txt',
  'cat /root/r.txt',
  'for i in 1 2; do echo loop-$i; done',
  'f() { echo fn-$1; }; f arg',
  'case zap in z*) echo case-ok;; esac',
  'test 2 -gt 1 && echo test-ok',
  'false || echo or-ok',
  'false; echo status=$?',
  'cc hello.c && ./a.out',                 // compile + run, in-OS
  'exit 7',
  '',
].join('\n'), ['--fresh']);

check('exit N propagates through hush', r.status === 7, String(r.status) + ' ' + (r.stderr || '').slice(-300));
const lines = r.stdout.split('\n');
const expectStdout = [
  'bin', 'dev', 'etc', 'proc', 'root', 'run', 'tmp', 'usr', 'var',   // ls / (0040 layout + 0043 /proc)
  'A',                                     // pipeline
  'sub=inner deep',                        // nested $( )
  'redir',                                 // > then cat
  'loop-1', 'loop-2',                      // for
  'fn-arg',                                // function
  'case-ok', 'test-ok', 'or-ok',           // case/test/||
  'status=1',                              // $?
  'hello, wasm world',                     // cc hello.c && ./a.out
];
for (let i = 0; i < expectStdout.length; i++) {
  check('stdout[' + i + '] = ' + JSON.stringify(expectStdout[i]),
    lines[i] === expectStdout[i], JSON.stringify(lines[i]));
}
check('first boot bakes the system blob', r.stderr.includes('baking system image'),
  r.stderr.slice(0, 300));
check('first boot builds hush from vendor/busybox', r.stderr.includes('built vendor/busybox/bin.json'),
  r.stderr.slice(0, 300));
check('first boot builds the coreutils multicall', r.stderr.includes('built vendor/busybox/coreutils.json'),
  r.stderr.slice(0, 300));
check('applet names baked as symlinks', r.stderr.includes('/usr/bin/ls -> /usr/bin/coreutils'),
  r.stderr.slice(0, 600));
check('first boot seeds the user volume', r.stderr.includes('seeding user volume'),
  r.stderr.slice(0, 300));

// ---- popen()/system(): the 0005 acceptance — heredoc -> cc -> run ----
r = session([
  "cat > po.c << 'CEOF'",
  '#include <stdio.h>',
  '#include <stdlib.h>',
  'int main(void) {',
  '    FILE *p = popen("echo from-popen | cat", "r");',
  '    char line[64];',
  '    if (p && fgets(line, sizeof line, p)) printf("read: %s", line);',
  '    printf("pclose: %d\\n", pclose(p));',
  '    printf("system: %d\\n", system("echo from-system > /tmp/sys.txt"));',
  '    FILE *f = fopen("/tmp/sys.txt", "r");',
  '    if (f && fgets(line, sizeof line, f)) printf("file: %s", line);',
  '    return 0;',
  '}',
  'CEOF',
  'cc po.c -o po && ./po',
  'exit',
  '',
].join('\n'));
check('popen/system session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
const po = r.stdout.split('\n');
const expectPo = ['read: from-popen', 'pclose: 0', 'system: 0', 'file: from-system'];
for (let i = 0; i < expectPo.length; i++) {
  check('popen[' + i + '] = ' + JSON.stringify(expectPo[i]), po[i] === expectPo[i], JSON.stringify(po[i]));
}

// ---- coreutils (0010): real applets, /bin symlinks to the multicall ----
r = session([
  'cd /tmp && mkdir cu && cd cu',
  "printf 'cherry 3\\napple 1\\nbanana 2\\n' > fruit.txt",
  'sort fruit.txt | head -2 | wc -l',       // applet pipeline, 3 processes
  'grep -c an fruit.txt',
  "sed 's/apple/APPLE/' fruit.txt | grep APPLE",
  'cp fruit.txt copy.txt && mv copy.txt moved.txt && rm fruit.txt && ls',
  'echo x | egrep x >/dev/null && echo egrep-ok',   // argv[0] alias applet
  'touch t.txt && test -f t.txt && echo touch-ok',
  'ls -l /bin/grep | grep -c coreutils',    // ls -l renders the symlink
  'coreutils basename /a/b/c.txt',          // busybox-style explicit form
  'exit',
  '',
].join('\n'));
check('coreutils session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
const cu = r.stdout.split('\n');
const expectCu = ['2', '1', 'APPLE 1', 'moved.txt', 'egrep-ok', 'touch-ok', '1', 'c.txt'];
for (let i = 0; i < expectCu.length; i++) {
  check('coreutils[' + i + '] = ' + JSON.stringify(expectCu[i]), cu[i] === expectCu[i], JSON.stringify(cu[i]));
}

// ---- coreutils batch 2 (0034): a leg per applet class ----
// Text filters (cut/tr/uniq/tac/nl/fold/od/comm/paste), file ops
// (cmp/du/dd/split/truncate/unlink/readlink/realpath/mktemp/stat/sync),
// misc (yes/seq/env/expr/date/uname/usleep/which/cksum/base64), hashes,
// and the single-user stubs (whoami/id/hostname). `yes | head` doubles as
// the EPIPE-terminates-the-writer check; `env /bin/true` exercises the
// bare-exec emulation the multicall gained with todos/0035 (spawn + wait
// + exit-with-child-status behind the scenes).
r = session([
  'cd /tmp && mkdir cu2 && cd cu2',
  'seq 3 | tac',
  "printf 'a:b:c\\n' | cut -d: -f2 | tr a-z A-Z",
  "printf 'x\\nx\\ny\\n' | uniq | wc -l",
  'echo hello | md5sum | cut -c1-32',
  'echo hello | base64 | base64 -d',
  'echo abc > f.txt && truncate -s 2 f.txt && stat -c %s f.txt',
  'dd if=f.txt bs=1 count=1 2>/dev/null | wc -c',
  'split -b 2 f.txt p_ && cat p_aa | wc -c',
  'ln -s f.txt l && readlink l && unlink l && echo unlink-ok',
  'realpath /bin/../tmp',
  'yes | head -2',
  'seq 2 | tee copy >/dev/null && wc -l copy',
  'expr 7 % 3',
  'date +%s | wc -c',                       // epoch seconds: 10 digits + \n
  'uname -m && whoami && id -u && hostname',
  'which sh',
  'cksum f.txt | cut -d" " -f1',            // CRC of "ab" (truncated f.txt)
  "printf '1\\n3\\n' > ca && printf '2\\n3\\n' > cb && comm ca cb | wc -l",
  'paste ca cb | head -1',
  "printf 'long line here\\n' | fold -w5 | head -1",
  "printf 'AB\\n' | od -c | head -1",
  "printf 'x\\n' | nl | wc -w",
  'mktemp m.XXXXXX >/dev/null && echo mktemp-ok',
  'sync && echo sync-ok',
  'cmp f.txt f.txt && echo cmp-same',
  'du -s /etc | cut -f2',
  'env | grep -c ^PATH=',
  'env /bin/true; echo env-exec=$?',
  'usleep 1000 && echo usleep-ok',
  'exit',
  '',
].join('\n'));
check('coreutils batch-2 session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
const cu2 = r.stdout.split('\n');
const expectCu2 = [
  '3', '2', '1',                            // seq | tac
  'B',                                      // cut | tr
  '2',                                      // uniq | wc
  'b1946ac92492d2347c6235b4d2611184',       // md5sum ("hello\n")
  'hello',                                  // base64 round-trip
  '2',                                      // truncate + stat -c %s
  '1',                                      // dd bs=1 count=1
  '2',                                      // split -b 2, first part
  'f.txt', 'unlink-ok',                     // readlink, unlink
  '/tmp',                                   // realpath normalizes
  'y', 'y',                                 // yes stops on EPIPE
  '2 copy',                                 // tee
  '1',                                      // expr 7 % 3
  '11',                                     // date +%s length
  'wasm32', 'root', '0', 'localhost',       // uname -m + stubs
  '/bin/sh',                                // which
  '2072780115',                             // cksum ("ab")
  '3',                                      // comm line count
  '1\t2',                                   // paste
  'long ',                                  // fold -w5
  '0000000   A   B  \\n',                   // od -c (literal backslash-n)
  '2',                                      // nl | wc -w
  'mktemp-ok', 'sync-ok', 'cmp-same',
  '/etc',                                   // du -s field 2
  '1',                                      // env sees PATH
  'env-exec=0',                             // bare-exec emulation (0035)
  'usleep-ok',
];
for (let i = 0; i < expectCu2.length; i++) {
  check('coreutils2[' + i + '] = ' + JSON.stringify(expectCu2[i]), cu2[i] === expectCu2[i], JSON.stringify(cu2[i]));
}

// ---- coreutils batch 3: the spawn-capable applets (todos/0035) ----
// find -exec / xargs spawn real processes through the vfork-on-__spawn
// shim (now linked into the multicall); awk exercises popen (cmd |
// getline) and system(); tar -z covers BOTH shim paths — create spawns
// gzip via the patched vfork_compressor, extract re-execs `gunzip -cf -`
// via the NOMMU fork_transformer; diff/gzip/gunzip/zcat are file-only.
r = session([
  'cd /tmp && mkdir cu3 && cd cu3',
  'mkdir -p s && echo alpha > s/a.txt && printf "b1\\nb2\\n" > s/b.txt',
  'find s -name "*.txt" | sort',
  'find s -name "a.*" -exec wc -c {} \\;',
  'find s -type f | sort | xargs -n1 basename',
  'printf "one two\\nthree four\\n" | awk "{print \\$NF}"',
  'awk "BEGIN { \\"echo piped\\" | getline v; print \\"got-\\" v }"',
  'awk "BEGIN { r = system(\\"echo sys-out\\"); print \\"sys-rc=\\" r }"',
  'tar cf x.tar s && tar tf x.tar | sort',
  'mkdir e1 && cd e1 && tar xf ../x.tar && cat s/a.txt && cd ..',
  'tar czf x.tgz s',
  'mkdir e2 && cd e2 && tar xzf ../x.tgz && cat s/b.txt && cd ..',
  'tar cf - s | gzip | gunzip | tar tf - | sort | tail -1',
  'gzip -k x.tar && ls x.tar x.tar.gz',
  'zcat x.tar.gz | cmp - x.tar && echo zcat-matches',
  'gunzip -c x.tar.gz | wc -c && rm x.tar.gz',
  'echo one > d1 && echo two > d2',
  'diff d1 d2 > d.out; echo diff-rc=$?',
  'tail -2 d.out',
  'diff d1 d1 && echo diff-same-rc=$?',
  'exit',
  '',
].join('\n'));
check('coreutils batch-3 session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
const cu3 = r.stdout.split('\n');
const expectCu3 = [
  's/a.txt', 's/b.txt',                     // find -name
  '6 s/a.txt',                              // find -exec wc -c ("alpha\n")
  'a.txt', 'b.txt',                         // find | xargs -n1 basename
  'two', 'four',                            // awk $NF
  'got-piped',                              // awk cmd | getline (popen)
  'sys-out', 'sys-rc=0',                    // awk system()
  's/', 's/a.txt', 's/b.txt',               // tar cf + tf
  'alpha',                                  // tar xf roundtrip content
  'b1', 'b2',                               // tar czf/xzf roundtrip content
  's/b.txt',                                // piped tar|gzip|gunzip|tar
  'x.tar', 'x.tar.gz',                      // gzip -k keeps the original
  'zcat-matches',                           // zcat == original bytes
  '3584',                                   // gunzip -c byte count (7 tar records)
  'diff-rc=1',                              // differing files exit 1
  '-one', '+two',                           // unified diff hunk body
  'diff-same-rc=0',                         // identical files exit 0
];
for (let i = 0; i < expectCu3.length; i++) {
  check('coreutils3[' + i + '] = ' + JSON.stringify(expectCu3[i]), cu3[i] === expectCu3[i], JSON.stringify(cu3[i]));
}

// ---- procfs + the process tools (0043): busybox procps over /proc ----
// ps lists pid 1 and itself; pgrep finds a background job by name and
// pkill terminates it (SIGTERM -> wait status 143); /proc/1/status agrees
// with the process table; top -bn1 parses /proc/stat+meminfo+loadavg;
// uptime/free go through the port's sysinfo().
r = session([
  'ps | awk "NR>1 {print \\$1, \\$5}"',      // strip header + volatile cols
  'sleep 30 &',
  'pgrep -l sleep',
  'pkill sleep && echo pkill-ok',
  'wait $! ; echo bg-status=$?',
  'pgrep sleep || echo sleep-gone',
  'awk "/^(State|PPid|NSpgid):/ {print \\$1, \\$2}" /proc/1/status',
  'uptime | grep -c "load average:"',
  'free | awk "NR==2 {print \\$1, (\\$2>0) ? \\"total-ok\\" : \\"bad\\"}"',
  'top -bn1 | head -1 | grep -c "^Mem:"',
  'cat /proc/uptime | grep -cE "^[0-9]+\\.[0-9]{2} "',
  'exit',
  '',
].join('\n'));
check('procps session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
{
  const pp = r.stdout.split('\n');
  check('ps lists pid 1 as sh', pp.includes('1 sh'), JSON.stringify(pp.slice(0, 6)));
  check('ps lists itself', pp.some((l) => /^\d+ ps$/.test(l)), JSON.stringify(pp.slice(0, 6)));
  const rest = pp.slice(pp.findIndex((l) => / sleep$/.test(l)));
  check('pgrep -l finds the bg sleep', /^\d+ sleep$/.test(rest[0] || ''), JSON.stringify(rest[0]));
  check('pkill signals it', rest[1] === 'pkill-ok', JSON.stringify(rest[1]));
  check('bg job died of SIGTERM', rest[2] === 'bg-status=143', JSON.stringify(rest[2]));
  check('pgrep confirms it is gone', rest[3] === 'sleep-gone', JSON.stringify(rest[3]));
  check('status State S (pid 1 waits)', rest[4] === 'State: S', JSON.stringify(rest[4]));
  check('status PPid 0 for init', rest[5] === 'PPid: 0', JSON.stringify(rest[5]));
  check('status NSpgid 1 for init', rest[6] === 'NSpgid: 1', JSON.stringify(rest[6]));
  check('uptime prints load average', rest[7] === '1', JSON.stringify(rest[7]));
  check('free parses meminfo', rest[8] === 'Mem: total-ok', JSON.stringify(rest[8]));
  check('top -bn1 renders the Mem header', rest[9] === '1', JSON.stringify(rest[9]));
  check('/proc/uptime format', rest[10] === '1', JSON.stringify(rest[10]));
}

// ---- shebang exec (todos/0065): `./script` runs via its #! line ----
// The kernel re-dispatches a "#!" image to its interpreter, so a shell
// script is directly executable (no explicit `sh`) — the 0066 launcher
// primitive. `-e` rides through as one interpreter arg; a shebang cycle
// dies with ENOEXEC ("Exec format error") instead of hanging.
r = session([
  "printf '#!/bin/sh\\necho hi-$1\\n' > /root/foo",
  'chmod +x /root/foo',
  './foo world',                            // relative path, no explicit sh
  '/root/foo direct',                       // absolute path
  'sh /root/foo classic',                   // the old spelling still works
  "printf '#!/bin/sh -e\\nfalse\\necho unreachable\\n' > strict",
  './strict; echo strict-rc=$?',
  "printf '#!/root/loop\\n' > loop",
  './loop 2>/dev/null; echo loop-rc=$?',
  'exit',
  '',
].join('\n'));
check('shebang session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
{
  const sh = r.stdout.split('\n');
  const expectSh = [
    'hi-world',                             // ./foo
    'hi-direct',                            // /root/foo
    'hi-classic',                           // sh foo unchanged
    'strict-rc=1',                          // #!/bin/sh -e: false aborts
    'loop-rc=2',                            // cycle -> ENOEXEC -> hush exit 2
  ];
  for (let i = 0; i < expectSh.length; i++) {
    check('shebang[' + i + '] = ' + JSON.stringify(expectSh[i]), sh[i] === expectSh[i], JSON.stringify(sh[i]));
  }
}

// ---- second boot, same image: persistence + no re-seed ----
r = session('ls\nexit\n');
check('second boot exits clean', r.status === 0, String(r.status));
check('no re-bake on second boot', !r.stderr.includes('baking system image'), r.stderr.slice(0, 200));
check('no user re-seed on second boot', !r.stderr.includes('seeding user volume'), r.stderr.slice(0, 200));
const names = r.stdout.split('\n');
check('a.out persisted across reboot', names.includes('a.out'), JSON.stringify(names.slice(0, 5)));
check('po persisted across reboot', names.includes('po'), JSON.stringify(names.slice(0, 6)));

// ---- the 0040 layout: read-only /usr, writable root volume ----
check('system + root images both exist on disk',
  fs.existsSync(image) && fs.existsSync(image.slice(0, -4) + '-root.img'),
  fs.readdirSync(tmp).join(','));
// Writes under the sealed blob are EROFS — via /bin (symlink into /usr) too.
r = session([
  'echo x > /bin/hack 2>/dev/null || echo erofs-bin',
  'touch /usr/x || echo erofs-usr',
  'echo precious > /root/keep.txt',
  'echo override > /etc/keep-etc.txt',
  'echo tool > /usr/local/bin/mytool && cat /var/local/bin/mytool',
  'exit',
  '',
].join('\n'));
check('EROFS session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-200));
{
  const ro = r.stdout.split('\n');
  check('write via /bin is EROFS', ro[0] === 'erofs-bin', JSON.stringify(ro[0]));
  check('write under /usr is EROFS', ro[1] === 'erofs-usr', JSON.stringify(ro[1]));
  check('/usr/local lands on /var/local (writable)', ro[2] === 'tool', JSON.stringify(ro[2]));
}

// ---- upgrade = swap the blob: user territory untouched ----
// Bake a v(N+1) blob with mkimage against a version-bumped manifest and swap
// it in place of the system image; boot must keep it (no re-bake, no user
// seed) and every user file must survive.
const vNext = (JSON.parse(fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf-8')).version | 0) + 1;
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf-8'));
  manifest.version = vNext;
  const mfPath = path.join(tmp, 'image-vnext.json');
  fs.writeFileSync(mfPath, JSON.stringify(manifest));
  const mk = cp.spawnSync('node',
    [path.join(ROOT, 'tools/mkimage.js'), '--out=' + image, '--manifest=' + mfPath, '--quiet'],
    { encoding: 'utf8', timeout: 300000 });
  check('mkimage bakes the v(N+1) blob', mk.status === 0, (mk.stderr || '').slice(-300));
}
r = session([
  'cat /usr/share/os-release',
  'cat /root/keep.txt',
  'cat /etc/keep-etc.txt',
  'cat /var/local/bin/mytool',
  'cc hello.c && ./a.out',
  'exit',
  '',
].join('\n'));
check('upgraded boot exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-300));
check('the swapped blob is kept (no re-bake)', !r.stderr.includes('baking system image'),
  r.stderr.slice(0, 200));
check('no user re-seed on upgrade', !r.stderr.includes('seeding user volume'), r.stderr.slice(0, 200));
{
  const up = r.stdout.split('\n');
  check('os-release reports the upgraded version', up.includes('VERSION_ID=' + vNext),
    JSON.stringify(up.slice(0, 3)));
  check('user file survived the upgrade', up.includes('precious'), JSON.stringify(up));
  check('/etc override survived the upgrade', up.includes('override'), JSON.stringify(up));
  check('admin-installed tool survived the upgrade', up.includes('tool'), JSON.stringify(up));
  check('upgraded /bin/cc still compiles', up.includes('hello, wasm world'), JSON.stringify(up));
}

// ---- factory reset: wipe /etc + /var -> boots identically ----
r = session('rm -rf /etc/* /var/*\nexit\n');
check('factory-reset wipe exits clean', r.status === 0, String(r.status));
r = session('ls /etc\necho etc-rc=$?\ncc hello.c && ./a.out\nexit\n');
check('post-reset boot exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-300));
{
  const fr = r.stdout.split('\n');
  check('/etc is empty after the reset', fr[0] === 'etc-rc=0', JSON.stringify(fr.slice(0, 2)));
  check('the OS still compiles and runs', fr.includes('hello, wasm world'), JSON.stringify(fr));
}

// --fresh-system: re-bake the blob outright; user volume untouched.
r = session('cat /root/keep.txt\nexit\n', ['--fresh-system']);
check('--fresh-system re-bakes', r.stderr.includes('baking system image'), r.stderr.slice(0, 200));
check('--fresh-system keeps user files', r.stdout.split('\n')[0] === 'precious',
  JSON.stringify(r.stdout.split('\n')[0]));

// ---- failure modes leave the OS alive ----
r = session('cc nosuch.c\necho alive\nexit\n');
check('OS survives a failed cc', r.stdout.split('\n')[0] === 'alive', JSON.stringify(r.stdout.split('\n')[0]));
check('cc error reaches stderr', /nosuch\.c/.test(r.stderr), r.stderr.slice(-300));

r = session('definitely-not-a-command\nexit\n');
check('unknown command reported', /can't execute|not found/.test(r.stderr), r.stderr.slice(-200));
check('unknown command is 127 via $?', r.status === 127, String(r.status));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nos boot (headless, hush): PASS' : `\nos boot (headless, hush): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
