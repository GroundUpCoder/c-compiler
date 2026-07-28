#!/usr/bin/env node
// Egress end-to-end (todos/0398): the gucOS -> host file transfer seam,
// proven WITHOUT a browser — the point of the design's headless twin. A
// REAL C program (os/egress.h -> __egress -> kernel EGRESS RPC) names
// paths; the kernel materializes ONE artifact per call and hands it to the
// embedder hook. Covers:
//   - lone file: exact bytes, basename naming, both dispositions
//   - lone symlink FOLLOWS to its target (name stays the link's); a
//     dangling lone symlink is ENOENT
//   - directory -> ONE store-only zip: explicit dir entries (empty dirs
//     survive), sorted deterministic order, correct CRCs, binary data
//     intact, symlinks preserved as SYMLINK entries (S_IFLNK external
//     attrs, target as data — the Info-ZIP convention)
//   - multi-selection -> gucOS-selection.zip with each root's basename
//   - loud refusals: ENOENT (missing path), EINVAL (relative path, bad
//     disposition), E2BIG (list over the cap), EFBIG (lstat-summed size
//     over EGRESS_MAX — via a SPARSE 300MB file, so no bytes ever move,
//     proving the pre-read refusal), ENOSYS (embedder without the hook)
//   - the boot.js --egress-dir twin: artifacts land as host files with
//     the '-N' collision suffix; no flag -> ENOSYS
//
// Run: node tests/kernel/test_egress_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- tiny zip reader (independent of the kernel's writer) ---- */
function crc32(bytes) {
  const tab = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tab[n] = c;
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = tab[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function parseZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const eocd = buf.length - 22;                       // no archive comment
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('bad EOCD');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header @' + p);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const extAttrs = dv.getUint32(p + 38, true);
    const locOff = dv.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    // data via the local header's own name/extra lengths
    const lNameLen = dv.getUint16(locOff + 26, true);
    const lExtraLen = dv.getUint16(locOff + 28, true);
    const dataOff = locOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataOff, dataOff + usize);
    entries.push({ name, method, crc, usize, extAttrs, data,
                   unixMode: (extAttrs >>> 16) & 0xffff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---- session 1: bare kernel, in-memory artifact capture ---- */

const APP_C = `
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include "egress.h"

static void leg(const char *tag, int r) {
    printf("%s rc=%d errno=%d enoent=%d einval=%d e2big=%d efbig=%d enosys=%d\\n",
           tag, r, r == 0 ? 0 : errno, errno == ENOENT, errno == EINVAL,
           errno == E2BIG, errno == EFBIG, errno == ENOSYS);
}
static int send1(int dispo, const char *p) {
    const char *v[1] = { p };
    errno = 0;
    return eg_send(dispo, v, 1);
}

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "enosys")) {
        int fd = open("/t.txt", O_WRONLY | O_CREAT, 0644);
        write(fd, "x", 1);
        close(fd);
        leg("N1", send1(EG_DOWNLOAD, "/t.txt"));
        printf("DONE\\n");
        return 0;
    }

    /* -------- fixture tree -------- */
    mkdir("/exp", 0755);
    mkdir("/exp/sub", 0755);
    mkdir("/exp/empty", 0755);
    int fd = open("/exp/a.txt", O_WRONLY | O_CREAT, 0644);
    write(fd, "alpha-bytes", 11);
    close(fd);
    fd = open("/exp/sub/b.bin", O_WRONLY | O_CREAT, 0644);
    unsigned char bb[512];
    for (int i = 0; i < 512; i++) bb[i] = (unsigned char)i;
    write(fd, bb, sizeof bb);
    close(fd);
    symlink("a.txt", "/exp/link");
    fd = open("/top.txt", O_WRONLY | O_CREAT, 0644);
    write(fd, "top-level", 9);
    close(fd);
    symlink("/top.txt", "/lonelink");
    symlink("/nowhere", "/dangle");
    mkdir("/bigdir", 0755);
    fd = open("/bigdir/huge", O_WRONLY | O_CREAT, 0644);   /* sparse: 300MB */
    lseek(fd, 300 * 1024 * 1024, SEEK_SET);
    write(fd, "x", 1);
    close(fd);
    printf("SETUP done\\n");

    leg("L1", send1(EG_DOWNLOAD, "/exp/a.txt"));         /* lone file */
    leg("L2", send1(EG_SAVEAS, "/top.txt"));             /* saveas dispo */
    leg("L3", send1(EG_DOWNLOAD, "/lonelink"));          /* lone symlink follows */
    leg("L4", send1(EG_DOWNLOAD, "/dangle"));            /* dangling -> ENOENT */
    leg("L5", send1(EG_DOWNLOAD, "/exp"));               /* dir -> exp.zip */
    const char *multi[2] = { "/top.txt", "/exp" };
    errno = 0;
    leg("L6", eg_send(EG_DOWNLOAD, multi, 2));           /* multi -> selection zip */
    leg("L7", send1(EG_DOWNLOAD, "/no/such"));           /* ENOENT */
    errno = 0;
    leg("L8", __egress(EG_DOWNLOAD, "foo\\n", 4));        /* relative -> EINVAL */
    errno = 0;
    leg("L9", __egress(99, "/top.txt\\n", 9));            /* bad dispo -> EINVAL */
    static char big[9000];
    memset(big, 'x', sizeof big);
    errno = 0;
    leg("L10", __egress(EG_DOWNLOAD, big, sizeof big));  /* list cap -> E2BIG */
    leg("L11a", send1(EG_DOWNLOAD, "/bigdir/huge"));     /* lone-file EFBIG */
    leg("L11b", send1(EG_DOWNLOAD, "/bigdir"));          /* walk-summed EFBIG */
    errno = 0;
    leg("L12", eg_send(EG_DOWNLOAD, 0, 0));              /* empty list, local EINVAL */
    printf("DONE\\n");
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-e2e-'));
fs.writeFileSync(path.join(tmp, 'app.c'), APP_C);
cp.execFileSync('node',
  [path.join(ROOT, 'compiler.js'), path.join(tmp, 'app.c'),
   '-o', path.join(tmp, 'app.wasm'), '-I' + path.join(ROOT, 'os')],
  { stdio: 'pipe' });
const appImage = fs.readFileSync(path.join(tmp, 'app.wasm'));

function bareBoot(mode, withHook) {
  const store = new BLOCK_FS.MemoryByteStore(8 << 20);
  const kfs = BLOCK_FS.createV4(store);
  const state = { out: '', artifacts: [] };
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'),
                                       kernelPath: path.join(ROOT, 'kernel.js') }),
    loadImage: (p) => (p === '/bin/app' ? appImage : null),
    onOutput: (pid, fd, bytes) => { state.out += Buffer.from(bytes).toString(); },
    onEgress: withHook
      ? (dispo, name, bytes) => { state.artifacts.push({ dispo, name, bytes }); }
      : undefined,
    onHalt: () => {},
    log: () => {},
  });
  kernel.createTty({ cols: 80, rows: 24, output: () => {} });
  const run = kernel.boot({ path: '/bin/app', argv: ['app', mode], envp: [], cwd: '/' })
    .then(() => new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        if (state.out.includes('DONE')) return resolve();
        if (Date.now() - t0 > 60000)
          return reject(new Error('timeout; out=' + JSON.stringify(state.out)));
        setTimeout(poll, 10);
      })();
    }));
  return run.then(() => state);
}

function field(out, tag, key) {
  const l = out.split('\n').find((s) => s.startsWith(tag + ' ')) || '';
  const m = l.match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
}

async function session1() {
  console.log('-- session 1: bare kernel, in-memory hook --');
  const st = await bareBoot('main', true);
  const out = st.out;
  const byName = (n) => st.artifacts.find((a) => a.name === n);

  // L1: lone file
  check('L1 lone file accepted', field(out, 'L1', 'rc') === 0, out);
  const a1 = byName('a.txt');
  check('L1 artifact: download disposition', a1 && a1.dispo === 'download');
  check('L1 artifact: exact bytes', a1 && Buffer.from(a1.bytes).toString() === 'alpha-bytes',
    a1 && Buffer.from(a1.bytes).toString());

  // L2: saveas rides the same seam
  check('L2 saveas accepted', field(out, 'L2', 'rc') === 0);
  const a2 = byName('top.txt');
  check('L2 artifact: saveas disposition + bytes',
    a2 && a2.dispo === 'saveas' && Buffer.from(a2.bytes).toString() === 'top-level');

  // L3: lone symlink follows; the artifact keeps the LINK's name
  check('L3 lone symlink accepted', field(out, 'L3', 'rc') === 0);
  const a3 = byName('lonelink');
  check('L3 artifact: target bytes under the link name',
    a3 && Buffer.from(a3.bytes).toString() === 'top-level');

  // L4/L7: ENOENT
  check('L4 dangling lone symlink is ENOENT',
    field(out, 'L4', 'rc') === -1 && field(out, 'L4', 'enoent') === 1, out);
  check('L7 missing path is ENOENT',
    field(out, 'L7', 'rc') === -1 && field(out, 'L7', 'enoent') === 1);

  // L5: directory zip
  check('L5 dir accepted', field(out, 'L5', 'rc') === 0);
  const z = byName('exp.zip');
  check('L5 artifact named exp.zip', !!z);
  if (z) {
    const ents = parseZip(z.bytes);
    check('L5 zip: sorted deterministic entry list',
      ents.map((e) => e.name).join(',') ===
      'exp/,exp/a.txt,exp/empty/,exp/link,exp/sub/,exp/sub/b.bin',
      ents.map((e) => e.name).join(','));
    check('L5 zip: store-only (method 0 everywhere)', ents.every((e) => e.method === 0));
    const fa = ents.find((e) => e.name === 'exp/a.txt');
    check('L5 zip: file bytes intact + CRC good',
      fa && Buffer.from(fa.data).toString() === 'alpha-bytes' && crc32(fa.data) === fa.crc);
    const fb = ents.find((e) => e.name === 'exp/sub/b.bin');
    check('L5 zip: binary data intact (512 bytes, 0..255 pattern)',
      fb && fb.usize === 512 && fb.data[255] === 255 && fb.data[511] === 255 &&
      crc32(fb.data) === fb.crc);
    const fl = ents.find((e) => e.name === 'exp/link');
    check('L5 zip: symlink entry (S_IFLNK mode, target as data)',
      fl && (fl.unixMode & 0o170000) === 0o120000 &&
      Buffer.from(fl.data).toString() === 'a.txt',
      fl && '0o' + fl.unixMode.toString(8) + ' ' + Buffer.from(fl.data).toString());
    const fe = ents.find((e) => e.name === 'exp/empty/');
    check('L5 zip: empty dir survives as an explicit entry',
      fe && fe.usize === 0 && (fe.unixMode & 0o170000) === 0o040000 &&
      (fe.extAttrs & 0x10) === 0x10);
  }

  // L6: multi-selection zip
  check('L6 multi accepted', field(out, 'L6', 'rc') === 0);
  const zm = byName('gucOS-selection.zip');
  check('L6 artifact named gucOS-selection.zip', !!zm);
  if (zm) {
    const names = parseZip(zm.bytes).map((e) => e.name);
    check('L6 zip: both roots under their basenames',
      names.includes('top.txt') && names.includes('exp/') && names.includes('exp/sub/b.bin'),
      names.join(','));
  }

  // refusals
  check('L8 relative path is EINVAL',
    field(out, 'L8', 'rc') === -1 && field(out, 'L8', 'einval') === 1, out);
  check('L9 unknown disposition is EINVAL',
    field(out, 'L9', 'rc') === -1 && field(out, 'L9', 'einval') === 1);
  check('L10 oversize list is E2BIG',
    field(out, 'L10', 'rc') === -1 && field(out, 'L10', 'e2big') === 1);
  check('L11a lone sparse 300MB file is EFBIG (pre-read refusal)',
    field(out, 'L11a', 'rc') === -1 && field(out, 'L11a', 'efbig') === 1, out);
  check('L11b dir containing it is EFBIG (walk-summed)',
    field(out, 'L11b', 'rc') === -1 && field(out, 'L11b', 'efbig') === 1);
  check('L12 empty list is EINVAL (builder-local)',
    field(out, 'L12', 'rc') === -1 && field(out, 'L12', 'einval') === 1);
  check('exactly the 5 accepted artifacts were delivered', st.artifacts.length === 5,
    st.artifacts.map((a) => a.name).join(','));
}

async function session1b() {
  console.log('-- session 1b: no embedder hook -> ENOSYS --');
  const st = await bareBoot('enosys', false);
  check('N1 hookless kernel answers ENOSYS (no silent fallback)',
    field(st.out, 'N1', 'rc') === -1 && field(st.out, 'N1', 'enosys') === 1, st.out);
  check('N1 no artifact materialized', st.artifacts.length === 0);
}

/* ---- session 2: the boot.js --egress-dir twin (full OS image) ---- */

// The in-OS caller declares the import directly: /usr/include has no
// egress.h (os/ headers are bake-time includes), and the REAL header is
// exercised by session 1 through -I os/.
const EG_TOOL = [
  'cat > /tmp/eg.c << "EOF"',
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  '#include <errno.h>',
  '__import int __egress(int dispo, const void *paths, int len);',
  'int main(int argc, char **argv) {',
  '    char buf[4096]; int len = 0;',
  '    for (int i = 2; i < argc; i++)',
  '        len += snprintf(buf + len, sizeof buf - (size_t)len, "%s\\n", argv[i]);',
  '    errno = 0;',
  '    int r = __egress(atoi(argv[1]), buf, len);',
  '    printf("EG rc=%d enosys=%d\\n", r, errno == ENOSYS);',
  '    return 0;',
  '}',
  'EOF',
  'cc -o /tmp/eg /tmp/eg.c',
];

function session2() {
  console.log('-- session 2: boot.js --egress-dir twin --');
  const outDir = path.join(tmp, 'egress-out');
  const { dir: imgDir, image } = freshImage('os-egress-');
  const r1 = driveBoot([
    ...EG_TOOL,
    'printf "hostbound-bytes" > /tmp/out.txt',
    'echo ==eg1',
    '/tmp/eg 1 /tmp/out.txt',
    '/tmp/eg 1 /tmp/out.txt',
    'echo ==done',
    '',
  ], { image, args: ['--egress-dir=' + outDir], timeout: 420000 });
  const eg1 = section(r1.stdout, 'eg1');
  check('twin: both sends accepted', (eg1.match(/EG rc=0/g) || []).length === 2, eg1);
  const f1 = path.join(outDir, 'out.txt');
  const f2 = path.join(outDir, 'out-1.txt');
  check('twin: artifact landed as a host file with exact bytes',
    fs.existsSync(f1) && fs.readFileSync(f1, 'utf8') === 'hostbound-bytes');
  check('twin: second egress got the -N collision suffix',
    fs.existsSync(f2) && fs.readFileSync(f2, 'utf8') === 'hostbound-bytes');

  const r2 = driveBoot([
    ...EG_TOOL,
    'printf "x" > /tmp/out.txt',
    'echo ==eg1',
    '/tmp/eg 1 /tmp/out.txt',
    'echo ==done',
    '',
  ], { image, timeout: 420000 });
  check('twin: no --egress-dir -> ENOSYS',
    section(r2.stdout, 'eg1').includes('EG rc=-1 enosys=1'), section(r2.stdout, 'eg1'));
  fs.rmSync(imgDir, { recursive: true, force: true });
}

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — egress e2e did not finish in 600s');
  process.exit(1);
}, 600000);

(async () => {
  await session1();
  await session1b();
  session2();
  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\negress e2e: ${failures} FAILED` : '\negress e2e: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
