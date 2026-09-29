// pyplay (apps/pyplay) — the standalone "drop a zip of Python, run it" page.
//
// No gucOS here: the page runs the cpython-clang PACKAGE (the served /packages
// repo, exactly what a deployed origin publishes) on bare host.js in a Worker
// over a private OPFS BlockFS. This file proves, against real Chromium:
//   A. a multi-file program (sibling import, stdlib, file I/O, argv, stdin
//      via the live-stdin SAB ring, exit status) runs end to end;
//   B. the zip path — a zipped FOLDER (top-level dir stripped), stored and
//      deflate members, junk (__MACOSX) ignored, main.py auto-picked;
//   C. the runtime is installed ONCE per package sha: the second run in the
//      same origin must not download again (negative control on the status
//      events, which name the download);
//   D. an uncaught exception surfaces its traceback on stderr with exit 1.
// The package must be present in dist/packages: it is produced by
// `tools/mkpkg.js --clang` (clang-simplified sibling) and carried forward by
// later builds (#580). Absent = red naming the fix, never a skip.
import fsMod from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, waitForServer, launchBrowser, ROOT } from './lib/os-harness.mjs';

const PORT = 3287;
const BASE = `http://localhost:${PORT}`;
const PAGE = `${BASE}/apps/pyplay/index.html`;
const failures = [];
const check = (cond, name) => { if (cond) { console.log('  ok   ' + name); } else { console.log('  FAIL ' + name); failures.push(name); } };

// ---- preconditions: the served package repo carries cpython-clang ----------
const idxPath = path.join(ROOT, 'dist', 'packages', 'index.json');
if (!fsMod.existsSync(idxPath)) {
  console.error(`[pyplay] ${idxPath} missing — build the package repo first (node tools/mkpkg.js --clang)`);
  process.exit(1);
}
const idx = JSON.parse(fsMod.readFileSync(idxPath, 'utf8'));
const entry = (idx.packages || idx)['cpython-clang'];
if (!entry || !entry.payload) {
  console.error('[pyplay] dist/packages/index.json has no cpython-clang entry — run `node tools/mkpkg.js --clang` (needs ../clang-simplified)');
  process.exit(1);
}
const payloadPath = path.join(ROOT, 'dist', 'packages', entry.payload.url);
if (!fsMod.existsSync(payloadPath)) {
  console.error(`[pyplay] payload ${payloadPath} missing — the index carries an entry whose bytes are gone; rebuild with --clang`);
  process.exit(1);
}

// ---- a deterministic zip writer (stored + deflate) for leg B ---------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(members) {   // [{name, data:Buffer, deflate:boolean}]
  const locals = [], centrals = [];
  let off = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const data = m.deflate ? zlib.deflateRawSync(m.data) : m.data;
    const method = m.deflate ? 8 : 0;
    const crc = crc32(m.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(m.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(m.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const MAIN_PY = `
import sys, os, json, math, random, struct, re, collections, dataclasses, pathlib
from lib import helper
print("PYVER", sys.version_info[:3], sys.platform)
print("CWD", os.getcwd(), "ARGV", sys.argv[1:])
print("HELPER", helper.twice(21))
print("STDLIB", json.dumps({"pi": round(math.pi, 3)}), struct.pack("<I", 7).hex(), re.sub(r"a+", "b", "caaat"))
pathlib.Path("out.txt").write_text("written by pyplay\\n")
print("FILE", open("out.txt").read().strip())
print("PREFIX", sys.prefix)
name = input("NAME? ")
print("HELLO", name.upper())
sys.exit(3)
`;
const HELPER_PY = 'def twice(x):\n    return 2 * x\n';
const BOOM_PY = 'import sys\nprint("before")\nraise RuntimeError("boom from pyplay")\n';

const zipMembers = [
  { name: 'mygame/', data: Buffer.alloc(0), deflate: false },
  { name: 'mygame/main.py', data: Buffer.from(
      'import sys, pkg.util\nfrom pkg import util\nprint("ZIPRUN", util.answer(), open("data/words.txt").read().split())\nsys.exit(0)\n'), deflate: true },
  { name: 'mygame/pkg/__init__.py', data: Buffer.alloc(0), deflate: false },
  { name: 'mygame/pkg/util.py', data: Buffer.from('def answer():\n    return 42\n'), deflate: true },
  { name: 'mygame/data/words.txt', data: Buffer.from('alpha beta gamma\n'), deflate: false },
  { name: '__MACOSX/mygame/._main.py', data: Buffer.from('junk'), deflate: false },
];
const zipDir = path.join(ROOT, 'build', 'test-browser');
fsMod.mkdirSync(zipDir, { recursive: true });
const zipPath = path.join(zipDir, 'pyplay-fixture.zip');
fsMod.writeFileSync(zipPath, makeZip(zipMembers));

// ---- drive -----------------------------------------------------------------
const server = startServer(PORT, { serveArgs: ['--minimal'] });
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

const waitState = (want, timeout = 180_000) =>
  page.waitForFunction((w) => window.__pyplay && window.__pyplay.state === w, want, { timeout, polling: 100 });
const waitOutput = (needle, timeout = 60_000) =>
  page.waitForFunction((n) => window.__pyplay && window.__pyplay.output.includes(n), needle, { timeout, polling: 100 });

try {
  await waitForServer(PAGE, { tries: 1200, interval: 250 });   // serve.js may re-bake the minimal image first
  await page.goto(PAGE);
  await page.waitForFunction(() => !!window.__pyplay, {}, { timeout: 20_000 });

  // ---- A: multi-file program through the probe (the drop path minus the DOM)
  console.log('[pyplay] leg A: multi-file program, stdin, exit status');
  await page.fill('#args', 'one "two words"');
  const runA = page.evaluate(([main, helper]) =>
    window.__pyplay.runFiles([{ path: 'main.py', data: main }, { path: 'lib/helper.py', data: helper }, { path: 'lib/__init__.py', data: '' }]),
    [MAIN_PY, HELPER_PY]);
  await waitOutput('NAME? ');
  await page.keyboard.type('ada\n');
  const codeA = await runA;
  const outA = await page.evaluate(() => window.__pyplay.output);
  const eventsA = await page.evaluate(() => window.__pyplay.events.slice());
  check(codeA === 3, `A: exit status propagates (got ${codeA})`);
  check(/PYVER \(3, 13, \d+\)/.test(outA), 'A: CPython 3.13 ran');
  check(outA.includes("CWD /game ARGV ['one', 'two words']"), 'A: cwd is /game and argv splits quoted args');
  check(outA.includes('HELPER 42'), 'A: sibling package import from the script dir');
  check(outA.includes('STDLIB {"pi": 3.142} 07000000 cbt'), 'A: json/math/struct/re work');
  check(outA.includes('FILE written by pyplay'), 'A: file write+read in /game');
  check(outA.includes('PREFIX /opt/cpython-clang'), 'A: zero-env landmark discovery found the package prefix');
  check(outA.includes('HELLO ADA'), 'A: input() read the typed line through the stdin ring');
  check(!/Could not find platform dependent/.test(outA), 'A: no exec_prefix warning (lib-dynload present)');
  check(eventsA.some((e) => /Downloading Python/.test(e)), 'A: first run downloaded the package');
  check(eventsA.some((e) => /^Installed \d+ files/.test(e)), 'A: first run installed the package');
  console.log(outA.split('\n').filter((l) => /^(PYVER|PREFIX)/.test(l)).join(' | '));

  // ---- C: second run must reuse the OPFS image (no download) ---------------
  console.log('[pyplay] leg C: runtime cached across runs');
  const codeC = await page.evaluate((boom) => {
    window.__pyplay.events.length = 0;
    return window.__pyplay.runFiles([{ path: 'main.py', data: 'print("AGAIN")\n' }]);
  });
  const eventsC = await page.evaluate(() => window.__pyplay.events.slice());
  const outC = await page.evaluate(() => window.__pyplay.output);
  check(codeC === 0 && outC.includes('AGAIN'), 'C: second run executes (exit ' + codeC + ': ' + JSON.stringify(outC.slice(-300)) + ')');
  check(!eventsC.some((e) => /Downloading|Unpacking|Installed/.test(e)), `C: no re-download on the cached image (${JSON.stringify(eventsC)})`);

  // ---- D: traceback + exit 1 ------------------------------------------------
  console.log('[pyplay] leg D: uncaught exception');
  const codeD = await page.evaluate((src) => window.__pyplay.runFiles([{ path: 'main.py', data: src }]), BOOM_PY);
  // 3.13 colorizes tracebacks on a tty stderr (PYTHON_COLORS); match the plain text.
  const outD = (await page.evaluate(() => window.__pyplay.output)).replace(/\x1b\[[0-9;]*m/g, '');
  check(codeD === 1, `D: exit 1 on uncaught exception (got ${codeD}: ${JSON.stringify(outD.slice(-300))})`);
  check(outD.includes('before') && /Traceback[\s\S]*RuntimeError: boom from pyplay/.test(outD), 'D: traceback reaches the terminal (' + JSON.stringify(outD.slice(-400)) + ')');

  // ---- B: the zip path (?run= autoload) -------------------------------------
  console.log('[pyplay] leg B: zipped folder via ?run=');
  await page.goto(`${PAGE}?run=/build/test-browser/pyplay-fixture.zip`);
  await page.waitForFunction(() => !!window.__pyplay, {}, { timeout: 20_000 });
  await waitState('done');
  const [codeB, outB, prog, entrySel] = await page.evaluate(() => [
    window.__pyplay.lastExit, window.__pyplay.output,
    window.__pyplay.program().files.map((f) => f.path).sort(),
    document.getElementById('entry').value,
  ]);
  check(codeB === 0, `B: zip program exits 0 (got ${codeB}: ${JSON.stringify(outB.slice(-300))})`);
  check(outB.includes("ZIPRUN 42 ['alpha', 'beta', 'gamma']"), 'B: deflate + stored members, package import, data file');
  check(JSON.stringify(prog) === JSON.stringify(['data/words.txt', 'main.py', 'pkg/__init__.py', 'pkg/util.py']),
    `B: top-level folder stripped and __MACOSX dropped (${prog.join(',')})`);
  check(entrySel === 'main.py', 'B: main.py auto-selected as entry');
  check(!consoleLines.some((l) => /^\[pageerror\]/.test(l)), `no page errors (${consoleLines.filter((l) => l.startsWith('[pageerror]')).join(' ; ')})`);
} catch (e) {
  failures.push('exception: ' + (e && e.stack || e));
  try {
    const dump = await page.evaluate(() => ({ state: window.__pyplay.state, exit: window.__pyplay.lastExit, events: window.__pyplay.events, output: window.__pyplay.output.slice(-2000), status: document.getElementById('status').textContent }));
    console.error('[pyplay] page state at failure: ' + JSON.stringify(dump, null, 1));
  } catch (e2) { console.error('[pyplay] (no page state: ' + e2.message + ')'); }
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
}
if (failures.length) {
  console.error('[pyplay] FAIL\n  ' + failures.join('\n  '));
  console.error('[pyplay] console tail:\n  ' + consoleLines.slice(-30).join('\n  '));
  process.exit(1);
}
console.log('[pyplay] PASS');
