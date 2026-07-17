#!/usr/bin/env node
// R4 (todos/0255): a directory listing that comes up short must SAY SO.
// Pre-fix, comdlg32.c's fd_refill had two silent-no-op paths — a failed
// snapshot malloc showed ONLY "../" (an OOM indistinguishable from an
// empty directory: the exact fail-loud regression class the 0233/0252/0254
// batches were killing), and a list_dir() -1 (unopenable dir) looked the
// same. The 512-entry snapshot cap was a third member: entry 513+ just
// vanished, in fd_refill AND fileman's pane. Post-fix every short listing
// is a visible row: "(cannot allocate directory listing)",
// "(cannot open directory)", "(N more entries not shown)" — and
// list_dir() returns the TRUE count so callers can render the last one.
//
// Legs:
//   A. list_dir semantics (real C harness including os/listdir.h):
//      -1 on unopenable, TRUE count past the fill cap, exact-cap no lie.
//   B. notepad's Open dialog in a deleted cwd -> "(cannot open directory)"
//      (real mechanism: getcwd returns the stale path, opendir fails).
//   C. notepad dialog + fileman pane on a 520-entry dir -> the
//      "(8 more entries not shown)" row; fileman's status keeps the TRUE
//      "520 object(s)" count.
//   D. the OOM row itself: tests/kernel/fixtures/oomdlg (a real win32 app
//      compiled here, injected into the root volume) opens the dialog,
//      then heap-ballasts itself on an agent WM_SETTEXT trigger so the
//      next fd_refill snapshot malloc GENUINELY fails ->
//      "(cannot allocate directory listing)".
//
// Run: node tests/kernel/test_comdlg_diag_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const COMMON = require(path.join(ROOT, 'os/os-common.js'));
const CompilerJS = require(COMPILER);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

// ---- leg A: list_dir semantics, in-wasm over the real header ----
const LISTDIR_C = `
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "listdir.h"

static int fail = 0;
static void ck(const char *what, int cond) {
    printf("%s=%d\\n", what, cond ? 1 : 0);
    if (!cond) fail = 1;
}
static ld_ent ents[600];   /* static: 600 * sizeof(ld_ent) dwarfs the wasm stack */

static void mkfiles(const char *dir, const char *pfx, int n) {
    mkdir(dir, 0755);
    char p[64];
    for (int i = 0; i < n; i++) {
        snprintf(p, sizeof p, "%s/%s%03d", dir, pfx, i);
        FILE *f = fopen(p, "w");
        fputc('x', f);
        fclose(f);
    }
}

int main(void) {
    ck("nodir-minus1", list_dir("/nosuch", ents, 600, 0) == -1);

    mkfiles("/d", "f", 520);
    int n = list_dir("/d", ents, 600, 0);
    printf("full-n=%d\\n", n);
    ck("full-count", n == 520);

    /* capped fill still reports the TRUE count (the 0255 point) */
    memset(ents, 0, sizeof ents);
    n = list_dir("/d", ents, 512, 0);
    printf("capped-n=%d\\n", n);
    ck("capped-true-count", n == 520);
    int named = 0;
    for (int i = 0; i < 600; i++) if (ents[i].name[0]) named++;
    ck("capped-fill-exact", named == 512);

    /* a directory landing EXACTLY on the cap reports exactly it */
    mkfiles("/d2", "g", 8);
    ck("exact-cap-no-lie", list_dir("/d2", ents, 8, 0) == 8);

    /* flags unchanged: dotfiles hidden on request */
    mkdir("/d3", 0755);
    FILE *f = fopen("/d3/.hidden", "w"); fputc('x', f); fclose(f);
    f = fopen("/d3/shown", "w"); fputc('x', f); fclose(f);
    ck("dotfile-flag", list_dir("/d3", ents, 8, LIST_HIDE_DOTFILES) == 1 &&
                       strcmp(ents[0].name, "shown") == 0);

    printf("done\\n");
    return fail ? 1 : 42;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-comdlgdiag-'));
function compileC(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-I' + path.join(ROOT, 'os'), '-o', wasm],
    { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}

function runBareKernel(imageBytes) {
  return new Promise((resolve, reject) => {
    const store = new BLOCK_FS.MemoryByteStore(8 << 20);
    const kfs = BLOCK_FS.createV4(store);
    let out = '';
    const watchdog = setTimeout(() => reject(new Error('bare-kernel timeout\n' + out)), 60000);
    const kernel = new K.Kernel({
      fs: kfs,
      createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
      loadImage: (p) => (p === '/bin/init' ? imageBytes : null),
      onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
      onHalt: (status) => { clearTimeout(watchdog); resolve({ status, out }); },
      log: () => {},
    });
    kernel.createTty({ output: () => {} });
    kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' }).catch(reject);
  });
}

const { dir: imgDir, image } = freshImage('os-comdlgdiag-');
const boot = (script, opts) =>
  driveBoot(script, Object.assign({ image, maxBuffer: 64 * 1024 * 1024 }, opts)).stdout;

// One awk process makes the 520-file fixture (520 `touch` spawns would crawl).
const MK_MANY = 'awk \'BEGIN{for(i=0;i<520;i++){f=sprintf("/root/many/f%03d",i);' +
                'printf "x" > f;close(f)}}\'';

(async () => {
  // ---- leg A ----
  {
    const { status, out } = await runBareKernel(compileC('listdir', LISTDIR_C));
    console.log(out.split('\n').map((l) => '  | ' + l).join('\n'));
    check('leg A: harness exited 42 (every in-wasm ck passed)',
      ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
    for (const probe of ['nodir-minus1', 'full-count', 'capped-true-count',
                         'capped-fill-exact', 'exact-cap-no-lie', 'dotfile-flag']) {
      check('leg A: ' + probe, out.includes(probe + '=1'));
    }
  }

  // ---- legs B + C (notepad's Open dialog), one boot ----
  {
    const out = boot([
      // B: notepad spawned with a cwd that then disappears — the dialog's
      // getcwd hands fd_refill a stale path, opendir fails.
      'mkdir /root/gone',
      'cd /root/gone && notepad &',
      'wmctl wait label EDIT:0 12000',
      'rmdir /root/gone',
      'wmctl click "Open..."',
      'wmctl wait label Open 6000',
      'wmctl wait text LISTBOX:0 "(cannot open directory)" 8000',
      'echo ==badlist',
      'wmctl gettext LISTBOX:0',
      'echo ==cut',
      'wmctl click Cancel',
      'wmctl wait nowin Open 6000',
      // C: 520 entries, 512-capped snapshot -> an explicit remainder row
      'mkdir /root/many',
      MK_MANY,
      'echo ==count',
      'ls /root/many | wc -l',
      'echo ==cut',
      'wmctl click "Open..."',
      'wmctl wait label Open 6000',
      'wmctl settext EDIT:2 /root/many',
      'wmctl click Open',
      'wmctl wait text LISTBOX:0 "(8 more entries not shown)" 10000',
      'echo ==manyrows',
      'wmctl gettext LISTBOX:0 | grep -c .',   // non-empty rows (gettext adds a trailing \n)
      'echo ==cut',
      'wmctl click Cancel',
    ]);
    check('leg B: deleted cwd renders the explicit cannot-open row',
      section(out, 'badlist').includes('(cannot open directory)'));
    check('leg B: only ../ beside the diagnostic (no stale rows)',
      section(out, 'badlist').trim().split('\n').length === 2,
      JSON.stringify(section(out, 'badlist')));
    check('leg C fixture: 520 files created', section(out, 'count').trim() === '520');
    // ../ + 512 filled entries + the remainder marker = 514 listbox rows
    check('leg C: dialog rows = ../ + 512 + marker',
      section(out, 'manyrows').trim() === '514', section(out, 'manyrows').trim());
  }

  // ---- leg C (fileman pane + TRUE status count), reusing /root/many ----
  {
    const out = boot([
      'fileman /root/many &',
      'wmctl wait label Go 10000',
      'wmctl wait text LISTBOX:0 "(8 more entries not shown)" 10000',
      'wmctl wait text msctls_statusbar32:0 "520 object(s)" 8000',
      'echo ==fmstat',
      'wmctl gettext msctls_statusbar32:0',
      'echo ==cut',
    ]);
    check('leg C: fileman status counts the TRUE 520, not the shown 512',
      section(out, 'fmstat').includes('520 object(s)'), section(out, 'fmstat'));
  }

  // ---- leg D: the OOM row, via a genuinely failing snapshot malloc ----
  //
  // Determinism knob: --wasm-max-mem-pages=4096 caps EVERY wasm instance's
  // heap at 256 MiB, so the fixture's ballast really exhausts the heap
  // (cheap: ~3s vs the unbounded 4 GiB engine limit) and the snapshot
  // malloc genuinely returns NULL. Readback is via `wmctl tree`, NOT
  // gettext: gettext(LISTBOX:0) must allocate a reply buffer, which a
  // deliberately-starved heap can't serve — but the OOM row IS rendered
  // (tree reads it), and that is exactly what's under test.
  {
    // Compile the fixture app against the real win32 veneer and inject it
    // into the (already-seeded) root volume between boots.
    const oomWasm = COMMON.buildProject(CompilerJS,
      'tests/kernel/fixtures/oomdlg/bin.json',
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'));
    const rootImg = image.slice(0, -4) + '-root.img';   // boot.js pairing rule
    const store = new COMMON.NodeFileStore(fs, rootImg, false);
    const rfs = BLOCK_FS.createV4(store);
    const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
    const fd = rfs.open('/root/oomdlg', O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
    rfs.write(fd, oomWasm, oomWasm.length);
    rfs.close(fd);
    store.close();

    const out = boot([
      '/root/oomdlg &',
      'wmctl wait label Open 20000',            // the dialog is up + pumping
      'wmctl settext oomdlg ballast',           // wproc eats the heap
      'wmctl wait win ballasted 60000',         // kernel-title flip = ballast done
      'wmctl settext EDIT:1 /root',             // name box (EDIT:0 is the dir box)
      'wmctl click Open',                       // navigate -> fd_refill -> OOM
      // Poll via tree (gettext can't allocate under the starved heap).
      'for i in $(seq 1 60); do wmctl tree 2>/dev/null | ' +
        'grep -q "cannot allocate directory listing" && break; sleep 0.3; done',
      'echo ==oomtree',
      'wmctl tree',
      'echo ==cut',
      'wmctl click Cancel',
    ], { nodeArgs: ['--wasm-max-mem-pages=4096'] });
    const tree = section(out, 'oomtree');
    const lb = (tree.split('\n').find((l) => l.includes('class=LISTBOX')) || '');
    check('leg D: exhausted heap renders the explicit OOM row',
      lb.includes('(cannot allocate directory listing)'), lb);
    // The listbox text field is '../\n(cannot allocate...)\n' — a two-row
    // listing, distinguishable from an empty dir's lone '../\n'.
    check('leg D: OOM is distinguishable from an empty dir (../ + diagnostic)',
      lb.includes("'../\\n(cannot allocate directory listing)\\n'"), lb);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(imgDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\ncomdlg diag e2e: PASS' : `\ncomdlg diag e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
