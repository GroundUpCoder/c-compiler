#!/usr/bin/env node
// R3 (todos/0254): os/cfgstore.h must never silently truncate a config
// store. Pre-fix, cfg_set read the user file through ONE bounded
// fread(text, 1, 8191, uf) and rebuilt the file from that snapshot — so a
// ~/.config/openwith larger than 8191 bytes lost EVERYTHING past the prefix
// the moment any single key was set (silent persistent data loss). A real C
// harness including os/openwith.h (so ow_set is the genuine consumer path)
// proves:
//   - a user override file LARGER than CFG_STORE_MAX survives a single-key
//     set INTACT (every pre-existing line still present, new key appended)
//   - updating an existing key mid-way through the big file replaces
//     exactly that line and keeps the tail
//   - cfg_load3 on an over-cap merged store FAILS LOUD: -1/EFBIG, with the
//     line-boundary prefix still a valid overlay (no half-value lines)
//   - small-store delta semantics are unchanged (replace + dedupe +
//     comment preserved + append)
//   - the failure paths set errno: oversize key -> ENAMETOOLONG; an
//     existing-but-unopenable user "file" (a directory) -> -1 without ever
//     writing (a bad read must never be renamed over the original)
//
// Run: node tests/kernel/test_cfgstore_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const INIT_C = `
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "openwith.h"

#define NKEYS 700   /* ~700 * 18B = ~12.6K, well past CFG_STORE_MAX */

static int fail = 0;
static void ck(const char *what, int cond) {
    printf("%s=%d\\n", what, cond ? 1 : 0);
    if (!cond) fail = 1;
}

static char *slurp(const char *p, size_t *out_n) {
    static char buf[4 * CFG_STORE_MAX];
    FILE *f = fopen(p, "r");
    size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
    if (f) fclose(f);
    buf[n] = 0;
    if (out_n) *out_n = n;
    return buf;
}

int main(void) {
    char line[64], val[OW_CMD_MAX];
    mkdir("/root", 0755);
    mkdir("/root/.config", 0755);

    /* ---- the R3 red->green: a >CFG_STORE_MAX user file survives a set ---- */
    FILE *f = fopen("/root/.config/openwith", "w");
    long want = 0;
    for (int i = 0; i < NKEYS; i++) {
        int n = snprintf(line, sizeof line, "key%03d\\t/bin/prog%03d\\n", i, i);
        fwrite(line, 1, (size_t)n, f);
        want += n;
    }
    fclose(f);
    ck("big-file-made", want > CFG_STORE_MAX);

    ck("set-on-big-ok", ow_set("zzz", "/bin/probe") == 0);
    size_t got;
    char *text = slurp("/root/.config/openwith", &got);
    int missing = 0, first = -1;
    for (int i = 0; i < NKEYS; i++) {
        snprintf(line, sizeof line, "key%03d\\t/bin/prog%03d\\n", i, i);
        if (!strstr(text, line)) { if (first < 0) first = i; missing++; }
    }
    printf("survivors=%d/%d first-missing=%d bytes=%d->%d\\n",
           NKEYS - missing, NKEYS, first, (int)want, (int)got);
    ck("no-override-lost", missing == 0);            /* pre-fix: ~247 lost */
    ck("new-key-appended", strstr(text, "zzz\\t/bin/probe\\n") != 0);

    /* update an existing key mid-file: replaced once, tail intact */
    ck("set-existing-ok", ow_set("key350", "/bin/changed") == 0);
    text = slurp("/root/.config/openwith", 0);
    ck("old-line-gone", strstr(text, "key350\\t/bin/prog350\\n") == 0);
    ck("new-line-in-place", strstr(text, "key350\\t/bin/changed\\n") != 0);
    ck("tail-still-there", strstr(text, "key699\\t/bin/prog699\\n") != 0 &&
                           strstr(text, "zzz\\t/bin/probe\\n") != 0);

    /* ---- cfg_load3 on the over-cap store: LOUD, valid prefix ---- */
    char store[CFG_STORE_MAX];
    errno = 0;
    int r = cfg_load3(store, sizeof store, "/root/.config/openwith",
                      "/etc/openwith", "/usr/share/openwith");
    ck("load-overflow-minus1", r == -1);
    ck("load-overflow-efbig", errno == EFBIG);
    ck("load-prefix-resolves", cfg_find(store, "key000", val, sizeof val) == 1 &&
                               strcmp(val, "/bin/prog000") == 0);
    size_t sl = strlen(store);
    ck("load-prefix-line-clean", sl > 0 && store[sl - 1] == '\\n');

    /* ---- small-store delta semantics unchanged ---- */
    f = fopen("/root/.config/screensaver", "w");
    fputs("saver\\tmarquee\\n# note\\nSAVER\\tdupe\\ntimeout\\t60", f); /* no final \\n */
    fclose(f);
    ck("small-set-ok", cfg_set("screensaver", "saver", "none") == 0);
    text = slurp("/root/.config/screensaver", 0);
    /* replace-in-place, case-insensitive dupe dropped, comment + final
       newline-less line preserved verbatim */
    ck("small-rewrite-exact",
       strcmp(text, "saver\\tnone\\n# note\\ntimeout\\t60") == 0);
    ck("small-append-ok", cfg_set("screensaver", "text", "hi") == 0);
    text = slurp("/root/.config/screensaver", 0);
    ck("small-append-separated",
       strcmp(text, "saver\\tnone\\n# note\\ntimeout\\t60\\ntext\\thi\\n") == 0);

    /* ---- errno on the failure paths ---- */
    char bigkey[CFG_STORE_MAX + 8];
    memset(bigkey, 'k', sizeof bigkey - 1);
    bigkey[sizeof bigkey - 1] = 0;
    errno = 0;
    ck("oversize-key-fails", cfg_set("openwith", bigkey, "x") == -1);
    ck("oversize-key-errno", errno == ENAMETOOLONG);

    /* an existing-but-unopenable user "file": cfg_set must fail loud and
       write NOTHING (never rename a bad snapshot over the original) */
    mkdir("/root/.config/weird", 0755);
    f = fopen("/root/.config/weird/x", "w");
    fputs("y", f);
    fclose(f);
    errno = 0;
    ck("dir-user-file-fails", cfg_set("weird", "a", "b") == -1);
    ck("dir-user-file-errno", errno != 0);
    struct stat sb;
    ck("dir-contents-survive", stat("/root/.config/weird/x", &sb) == 0);
    ck("no-tmp-left", stat("/root/.config/.weird.tmp", &sb) != 0);

    printf("done\\n");
    return fail ? 1 : 42;
}
`;

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cfgstore-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-I' + path.join(ROOT, 'os'), '-o', wasm],
    { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}
const images = new Map([['/bin/init', compile('init', INIT_C)]]);

// ---- boot with a kernel-owned BlockFS ----
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);

let out = '';
let haltResolve;
const haltPromise = new Promise((res) => { haltResolve = res; });
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
  loadImage: (p) => images.get(p) || null,
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
});
kernel.createTty({ output: () => {} });

const watchdog = setTimeout(() => {
  console.error('TIMEOUT\noutput:\n' + out);
  process.exit(1);
}, 60000);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);

  console.log(out.split('\n').map((l) => '  | ' + l).join('\n'));
  check('harness exited 42 (every in-wasm ck passed)',
    ((status >> 8) & 0xff) === 42 && (status & 0x7f) === 0, String(status));
  for (const probe of ['no-override-lost', 'new-key-appended', 'tail-still-there',
                       'load-overflow-efbig', 'small-rewrite-exact',
                       'oversize-key-errno', 'dir-user-file-fails']) {
    check(probe, out.includes(probe + '=1'));
  }
  check('harness ran to completion', out.includes('done'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\ncfgstore e2e: PASS' : `\ncfgstore e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
