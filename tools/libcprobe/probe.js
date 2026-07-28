#!/usr/bin/env node
// libcprobe — compile-probe the builtin libc surface for named symbols.
//
// todos/0382 plan step 1 and todos/0325's re-measurement both need the same
// thing: an answer to "is symbol X present in compiler.js's builtin headers?"
// that can be re-run later. Grepping compiler.js answers a different question
// (is the string there) — this compiles a real TU per probe, so a symbol that
// is declared but unreachable from its documented header still reads ABSENT.
//
// 🔴 CONTROLS ARE LOAD-BEARING (0382 lesson (AZ)). A sweep whose entire output
// is "not found" cannot distinguish a real absence from a broken harness, so
// every run carries both:
//   - POSITIVE controls — symbols we certainly have. If one reads ABSENT the
//     harness is broken and the whole run is void.
//   - NEGATIVE controls — symbols that certainly do not exist. If one reads
//     PRESENT the probe is not actually compiling anything.
// Either control failing exits 2 (void), distinct from exit 1 (gaps found).
//
// Usage:
//   node tools/libcprobe/probe.js            # full table
//   node tools/libcprobe/probe.js --filter=S # substring filter on probe name
//   node tools/libcprobe/probe.js --verbose  # print each failure's diagnostics

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'tests/lib/tree-guard.js'))
  .assertSameTree(__dirname, { label: 'tools/libcprobe/probe.js' });
const compiler = require(path.join(ROOT, 'compiler.js'));

// ---------------------------------------------------------------------------
// The probe table.
//
// `use` is a fragment placed inside main(). It must both NAME the symbol and
// USE it in a way a declaration alone satisfies — taking the address is the
// strongest form (it also proves the symbol is a real function and not a
// function-like macro, which is exactly what todos/0325 Group D needs of the
// long-double entry points).
// ---------------------------------------------------------------------------
const PROBES = [
  // ---- positive controls: certainly present ----
  { name: 'CONTROL+ strlen', ctl: 'pos', hdr: ['string.h'], use: 'void *p = (void *)&strlen; use(p);' },
  { name: 'CONTROL+ printf', ctl: 'pos', hdr: ['stdio.h'], use: 'void *p = (void *)&printf; use(p);' },
  { name: 'CONTROL+ gmtime', ctl: 'pos', hdr: ['time.h'], use: 'void *p = (void *)&gmtime; use(p);' },

  // ---- negative controls: certainly absent ----
  { name: 'CONTROL- nosuchfunc', ctl: 'neg', hdr: ['stdio.h'], use: 'void *p = (void *)&__libcprobe_nosuchfunc; use(p);' },
  { name: 'CONTROL- nosuchtype', ctl: 'neg', hdr: ['sys/types.h'], use: '__libcprobe_nosuchtype_t v = 0; use(&v);' },

  // ---- todos/0382 group 1-2: absent outright (hard blockers) ----
  { name: '0382/1 umask', t: '0382', hdr: ['sys/stat.h'], use: 'mode_t m = umask(022); use(&m);' },
  { name: '0382/2 id_t', t: '0382', hdr: ['sys/types.h'], use: 'id_t v = 0; use(&v);' },

  // ---- todos/0382 group 3: mis-headered ----
  // The gap is NOT "strcasecmp is missing" — it is in <strings.h> already.
  // It is that <string.h> alone does not reach it, which is what glibc/musl
  // (and therefore portable code like libzip) rely on.
  { name: '0382/3 strcasecmp via string.h', t: '0382', hdr: ['string.h'], use: 'int r = strcasecmp("a", "A"); use(&r);' },
  { name: '0382/3 strncasecmp via string.h', t: '0382', hdr: ['string.h'], use: 'int r = strncasecmp("a", "A", 1); use(&r);' },
  // Found BY this probe's own positive control (todos/0389): <fcntl.h> declares
  // open() but does not pull the TU that defines it, so the POSIX-correct
  // include set links only by accident of some other header being included too.
  { name: '0382/3b open via fcntl.h', t: '0382', hdr: ['fcntl.h'], use: 'void *p = (void *)&open; use(p);' },

  // ---- todos/0382 group 4-9 / todos/0325 Group B overlap ----
  { name: '0382/4 gmtime_r', t: '0382+0325A', hdr: ['time.h'], use: 'void *p = (void *)&gmtime_r; use(p);' },
  { name: '0382/5 timegm', t: '0382+0325B', hdr: ['time.h'], use: 'void *p = (void *)&timegm; use(p);' },
  { name: '0382/6 tzset', t: '0382+0325A', hdr: ['time.h'], use: 'void *p = (void *)&tzset; use(p);' },
  { name: '0382/7 fstatat', t: '0382+0325B', hdr: ['sys/stat.h'], use: 'void *p = (void *)&fstatat; use(p);' },
  { name: '0382/8 openat', t: '0382+0325B', hdr: ['fcntl.h'], use: 'void *p = (void *)&openat; use(p);' },
  { name: '0382/9 mkfifo', t: '0382', hdr: ['sys/stat.h'], use: 'void *p = (void *)&mkfifo; use(p);' },
  // Also named in the 0350 harness README's gap list.
  { name: '0382/rd ctime_r', t: '0382', hdr: ['time.h'], use: 'void *p = (void *)&ctime_r; use(p);' },
  { name: '0382/rd asctime_r', t: '0382', hdr: ['time.h'], use: 'void *p = (void *)&asctime_r; use(p);' },

  // ---- todos/0325 Group A: no configure escape ----
  { name: '0325A fma', t: '0325A', hdr: ['math.h'], use: 'void *p = (void *)&fma; use(p);' },
  { name: '0325A clock_getres', t: '0325A', hdr: ['time.h'], use: 'void *p = (void *)&clock_getres; use(p);' },
  { name: '0325A wcstol', t: '0325A', hdr: ['wchar.h'], use: 'void *p = (void *)&wcstol; use(p);' },
  { name: '0325A isascii', t: '0325A', hdr: ['ctype.h'], use: 'int r = isascii(65); use(&r);' },
  { name: '0325A clockid_t via sys/types.h', t: '0325A', hdr: ['sys/types.h'], use: 'clockid_t c = 0; use(&c);' },
  { name: '0325A struct timespec via sys/types.h', t: '0325A', hdr: ['sys/types.h'], use: 'struct timespec ts; ts.tv_sec = 0; use(&ts);' },

  // ---- todos/0325 Group B ----
  { name: '0325B tm_zone', t: '0325B', hdr: ['time.h'], use: 'struct tm t; t.tm_zone = "UTC"; use(&t);' },
  { name: '0325B explicit_bzero', t: '0325B', hdr: ['string.h'], use: 'void *p = (void *)&explicit_bzero; use(p);' },
  { name: '0325B memrchr', t: '0325B', hdr: ['string.h'], use: 'void *p = (void *)&memrchr; use(p);' },
  { name: '0325B strsignal', t: '0325B', hdr: ['string.h'], use: 'void *p = (void *)&strsignal; use(p);' },
  { name: '0325B getentropy', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&getentropy; use(p);' },
  { name: '0325B truncate', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&truncate; use(p);' },
  { name: '0325B confstr', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&confstr; use(p);' },
  { name: '0325B pathconf', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&pathconf; use(p);' },
  { name: '0325B fpathconf', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&fpathconf; use(p);' },
  { name: '0325B posix_fadvise', t: '0325B', hdr: ['fcntl.h'], use: 'void *p = (void *)&posix_fadvise; use(p);' },
  { name: '0325B posix_fallocate', t: '0325B', hdr: ['fcntl.h'], use: 'void *p = (void *)&posix_fallocate; use(p);' },
  { name: '0325B clock_nanosleep', t: '0325B', hdr: ['time.h'], use: 'void *p = (void *)&clock_nanosleep; use(p);' },
  { name: '0325B TIMER_ABSTIME', t: '0325B', hdr: ['time.h'], use: 'int v = TIMER_ABSTIME; use(&v);' },
  { name: '0325B wcsftime', t: '0325B', hdr: ['wchar.h'], use: 'void *p = (void *)&wcsftime; use(p);' },
  { name: '0325B faccessat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&faccessat; use(p);' },
  { name: '0325B linkat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&linkat; use(p);' },
  { name: '0325B mkdirat', t: '0325B', hdr: ['sys/stat.h'], use: 'void *p = (void *)&mkdirat; use(p);' },
  { name: '0325B renameat', t: '0325B', hdr: ['stdio.h'], use: 'void *p = (void *)&renameat; use(p);' },
  { name: '0325B unlinkat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&unlinkat; use(p);' },
  { name: '0325B readlinkat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&readlinkat; use(p);' },
  { name: '0325B symlinkat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&symlinkat; use(p);' },
  { name: '0325B futimesat', t: '0325B', hdr: ['sys/time.h'], use: 'void *p = (void *)&futimesat; use(p);' },
  { name: '0325B fchmodat', t: '0325B', hdr: ['sys/stat.h'], use: 'void *p = (void *)&fchmodat; use(p);' },
  { name: '0325B fchownat', t: '0325B', hdr: ['unistd.h'], use: 'void *p = (void *)&fchownat; use(p);' },
  { name: '0325B AT_EACCESS', t: '0325B', hdr: ['fcntl.h'], use: 'int v = AT_EACCESS; use(&v);' },
  { name: '0325B AT_REMOVEDIR', t: '0325B', hdr: ['fcntl.h'], use: 'int v = AT_REMOVEDIR; use(&v);' },
  { name: '0325B AT_SYMLINK_FOLLOW', t: '0325B', hdr: ['fcntl.h'], use: 'int v = AT_SYMLINK_FOLLOW; use(&v);' },
  { name: '0325B RTLD_NODELETE', t: '0325B', hdr: ['dlfcn.h'], use: 'int v = RTLD_NODELETE; use(&v);' },
  { name: '0325B RTLD_NOLOAD', t: '0325B', hdr: ['dlfcn.h'], use: 'int v = RTLD_NOLOAD; use(&v);' },
];

// ---------------------------------------------------------------------------

// Three verdicts, because the two tickets describe two distinct failure shapes
// and collapsing them hides one:
//   'absent'    — the declaration is not reachable from the named header. The
//                 build stops at the front end. This is 0382's blocker shape.
//   'decl-only' — it parses but does not LINK from that header alone: the
//                 header declares the symbol without pulling the libc TU that
//                 defines it. Portable code that includes only the POSIX-
//                 mandated header still fails, just later and with a worse
//                 message.
//   'present'   — parses and links from the named header alone.
function compileProbe(p) {
  const src =
    p.hdr.map((h) => `#include <${h}>`).join('\n') +
    `\nstatic void use(const void *x) { (void)x; }\n` +
    `int main(void) { ${p.use} return 0; }\n`;

  const file = path.join(os.tmpdir(), `libcprobe_${process.pid}_${Math.abs(hash(p.name))}.c`);
  fs.writeFileSync(file, src);
  const diags = [];
  try {
    const pp = compiler.createDefaultPPRegistry();
    pp.fileReader = (fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch { return null; } };
    const compilerOptions = {
      debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
      allowKnRDefinitions: false, allowImplicitFunctionDecl: false,
      allowUndefined: false, gcSections: false, gcNoExportRoots: false,
      noUndefined: false, requireSources: [], backend: 'default',
    };
    const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };
    const writeErr = (s) => diags.push(String(s));
    let units;
    try {
      units = compiler.parseAllUnits(fs, pp, [file], { warningFlags, compilerOptions, writeErr });
    } catch (e) {
      diags.push(`${(e && e.message) || e}\n`);
      return { verdict: 'absent', diags };
    }
    if (diags.length) return { verdict: 'absent', diags };
    const link = compiler.linkTranslationUnits(units, compilerOptions);
    if (link.errors.length) {
      for (const e of link.errors) diags.push(`link: ${e.message}\n`);
      return { verdict: 'decl-only', diags };
    }
    compiler.generateCode(units, 'probe.wasm', { compilerOptions, warningFlags, writeErr });
    return { verdict: diags.length === 0 ? 'present' : 'decl-only', diags };
  } catch (e) {
    diags.push(`${(e && e.message) || e}\n`);
    return { verdict: 'absent', diags };
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function main() {
  const argv = process.argv.slice(2);
  const filter = (argv.find((a) => a.startsWith('--filter=')) || '').slice(9);
  const verbose = argv.includes('--verbose');

  const probes = PROBES.filter((p) => !filter || p.name.includes(filter));
  const ctlBroken = [];
  const gaps = [];
  const present = [];

  const MARK = { present: 'PRESENT  ', 'decl-only': 'DECL-ONLY', absent: 'ABSENT   ' };
  for (const p of probes) {
    const r = compileProbe(p);
    process.stdout.write(`  ${MARK[r.verdict]}  ${p.name}\n`);
    if (verbose && r.verdict !== 'present') {
      for (const d of r.diags) process.stdout.write(`               | ${String(d).trimEnd()}\n`);
    }

    // A positive control must reach the verdict its `want` says. Most want
    // 'present'; the ones pinning a known header/TU split want 'decl-only'.
    const want = p.want || 'present';
    if (p.ctl === 'pos' && r.verdict !== want) {
      ctlBroken.push(`${p.name} read ${r.verdict}, expected ${want} (harness broken — every negative in this run is void)`);
    }
    if (p.ctl === 'neg' && r.verdict !== 'absent') {
      ctlBroken.push(`${p.name} read ${r.verdict} (harness is not actually compiling)`);
    }
    if (!p.ctl) ((r.verdict === 'present') ? present : gaps).push({ p, verdict: r.verdict });
  }

  process.stdout.write(`\n${present.length} present, ${gaps.length} gaps, ` +
    `${probes.filter((p) => p.ctl).length} controls\n`);

  if (ctlBroken.length) {
    process.stdout.write('\nCONTROL FAILURE — this run proves nothing:\n');
    for (const m of ctlBroken) process.stdout.write(`  ${m}\n`);
    process.exit(2);
  }
  process.stdout.write('controls OK (positives compiled, negatives did not)\n');
  if (gaps.length) {
    process.stdout.write('\ngaps:\n');
    for (const g of gaps) process.stdout.write(`  ${g.verdict.padEnd(9)} [${g.p.t}] ${g.p.name}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { PROBES, compileProbe };
