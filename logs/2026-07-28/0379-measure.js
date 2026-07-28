#!/usr/bin/env node
// 0379 measurement driver: per-command wall times inside a gucOS headless boot.
// Streams boot.js stdout and timestamps @@MARK lines as they arrive.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const { ensureMinimalImage, startServer } = require(path.join(ROOT, 'tests/kernel/lib/gucman.js'));
const { freshImage } = require(path.join(ROOT, 'tests/kernel/lib/drive.js'));

const K = Number(process.env.REPS || 5);

function timed(name, cmd, reps = K) {
  const lines = [];
  for (let i = 0; i < reps; i++) {
    lines.push(`echo @@MARK ${name}.${i}.a`);
    lines.push(cmd);
    lines.push(`echo @@MARK ${name}.${i}.b`);
  }
  return lines;
}

function runBoot(image, script, label) {
  return new Promise((resolve, reject) => {
    const marks = [];   // {name, t_ms}
    const child = cp.spawn('node', [path.join(ROOT, 'os/boot.js'), '--image=' + image, '--quiet', '--packages=none'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let buf = '';
    const t0 = process.hrtime.bigint();
    child.stdout.on('data', (d) => {
      const now = Number(process.hrtime.bigint() - t0) / 1e6;
      const s = String(d);
      out += s;
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        const m = /@@MARK (\S+)/.exec(line);
        if (m) marks.push({ name: m[1], t: now });
      }
    });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err, marks }));
    child.stdin.write(script.join('\n') + '\nexit\n');
    child.stdin.end();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 900000).unref();
  });
}

function report(marks) {
  // group name.<i>.a/b pairs
  const byTest = {};
  const map = new Map(marks.map((m) => [m.name, m.t]));
  for (const m of marks) {
    const mm = /^(.+)\.(\d+)\.a$/.exec(m.name);
    if (!mm) continue;
    const end = map.get(`${mm[1]}.${mm[2]}.b`);
    if (end === undefined) continue;
    (byTest[mm[1]] = byTest[mm[1]] || []).push(end - m.t);
  }
  for (const [name, xs] of Object.entries(byTest)) {
    const s = xs.slice().sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`  ${name.padEnd(28)} n=${xs.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)}ms mean=${mean.toFixed(0)} [${s[0].toFixed(0)}..${s[s.length - 1].toFixed(0)}]  all=[${xs.map((x) => x.toFixed(0)).join(',')}]`);
  }
  return byTest;
}

async function main() {
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-0379-');
  fs.copyFileSync(MIN, image);
  const port = await startServer(path.join(ROOT, 'dist', 'packages'));
  console.log(`repo :${port}, image ${image}`);

  const PY = '/opt/python-clang/bin/python-clang.wasm';

  // ---- boot 1: install, then timed runs (cold-cache first reps) ----
  const script = [
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'echo @@MARK inst.0.a',
    'gucman install python-clang >/dev/null 2>&1; echo RC=$?',
    'echo @@MARK inst.0.b',
    // spawn-chain floor
    ...timed('noop_builtin', ':'),
    ...timed('true_applet', 'true'),
    ...timed('sh_c_colon', 'sh -c :'),
    ...timed('realpath_spawn', 'realpath /bin/sh >/dev/null'),
    // the python chain, decomposed — NB first pyv_wasm rep is the cold one
    ...timed('pyv_wasm_direct', `${PY} --version >/dev/null 2>&1`),
    ...timed('pyv_launcher', 'python-clang --version >/dev/null 2>&1'),
    ...timed('pyv_dispatcher', 'python --version >/dev/null 2>&1'),
    // full init + imports: first rep after cache wipe = cold pyc
    'rm -rf /var/cache/python-clang',
    ...timed('pass_cold_then_warm', `${PY} -c pass >/dev/null 2>&1`),
    ...timed('import_json_re', `${PY} -c "import json, re" >/dev/null 2>&1`, 3),
    // importtime tables, warm + cold
    `${PY} -X importtime -c pass 2> /root/it-warm.txt`,
    'rm -rf /var/cache/python-clang',
    `${PY} -X importtime -c pass 2> /root/it-cold.txt`,
    'echo @@IT-COLD; cat /root/it-cold.txt; echo @@IT-COLD-END',
    'echo @@IT-WARM; cat /root/it-warm.txt; echo @@IT-WARM-END',
    // strace RPC censuses
    `strace -o /root/sv.txt ${PY} --version >/dev/null 2>&1`,
    `strace -o /root/sp.txt ${PY} -c pass >/dev/null 2>&1`,
    'echo @@SV; wc -l /root/sv.txt; echo @@SP; wc -l /root/sp.txt',
    'echo @@SVDUMP; cat /root/sv.txt; echo @@SVDUMP-END',
    'echo @@MARK done.0.a', 'echo @@MARK done.0.b',
  ];
  console.log('== boot 1 (install + cold) ==');
  const r1 = await runBoot(image, script, 'boot1');
  report(r1.marks);
  fs.writeFileSync(path.join(__dirname, 'boot1.out.txt'), r1.out);
  fs.writeFileSync(path.join(__dirname, 'boot1.err.txt'), r1.err);
  if (!/RC=0/.test(r1.out)) { console.error('INSTALL FAILED — see boot1.out.txt'); process.exit(1); }

  // ---- boot 2: same image — pyc persistence across boots + warm timings ----
  const script2 = [
    'echo PYCS=$(find /var/cache/python-clang -name "*.pyc" 2>/dev/null | wc -l)',
    ...timed('pyv_wasm_direct', `${PY} --version >/dev/null 2>&1`),
    ...timed('pass_warm_boot2', `${PY} -c pass >/dev/null 2>&1`),
    'echo @@MARK done.0.a', 'echo @@MARK done.0.b',
  ];
  console.log('== boot 2 (persistence) ==');
  const r2 = await runBoot(image, script2, 'boot2');
  report(r2.marks);
  const pycs = /PYCS=(\d+)/.exec(r2.out);
  console.log('  pyc files surviving reboot: ' + (pycs ? pycs[1] : '??'));
  fs.writeFileSync(path.join(__dirname, 'boot2.out.txt'), r2.out);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
