#!/usr/bin/env node
'use strict';
// Per-test-file peak-RSS sampler (#576 A4) — the instrument behind the
// kernel suite's HEAVY_GB/LIGHT_GB weights (tests/kernel/run.js). The
// weighted pool is only as safe as its weights are honest, and the old
// uniform 4 GB/job figure predates the prebaked fixture (todos/0082), so
// re-measure here whenever the boot path's memory profile might have moved:
//
//   node tests/lib/rss-sample.js [--out=FILE] [--interval=MS] -- CMD ARGS...
//   e.g. node tests/lib/rss-sample.js --out=build/rss.json -- \
//          node tests/kernel/run.js --filter=term_e2e,sameboy,pipes
//
// While CMD runs, `ps -axo pid,ppid,rss,command` is sampled (default every
// 500ms); every process whose command names a tests/*/test_*.js file roots a
// tree, descendants attach by ppid, and the tree's summed RSS is tracked to
// its peak. Sampling UNDERSTATES a true peak (spikes between samples are
// missed) and macOS compresses idle pages under pressure, so: measure on an
// idle box and pick weights with headroom above the printed peaks, never at
// them. Exit code is the child's.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  process.stderr.write('usage: node tests/lib/rss-sample.js [--out=FILE] [--interval=MS] -- CMD ARGS...\n');
  process.exit(2);
}
let outPath = null, intervalMs = 500;
for (const a of argv.slice(0, sep)) {
  if (a.startsWith('--out=')) outPath = a.slice(6);
  else if (a.startsWith('--interval=')) intervalMs = parseInt(a.slice(11), 10) || 500;
  else { process.stderr.write(`unknown arg: ${a}\n`); process.exit(2); }
}
const cmd = argv.slice(sep + 1);

const TEST_RE = /tests\/[a-z0-9_-]+\/(test_[A-Za-z0-9_.-]+\.js)/;
const peaks = new Map();   // "file#rootPid" -> { file, rootPid, peakKb, samples }
let peakTotalKb = 0;       // summed RSS across ALL tracked trees at one instant

function sample() {
  let out;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) { return; }
  const procs = new Map();          // pid -> { ppid, rss, cmd }
  const kids = new Map();           // ppid -> [pid]
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], rss = +m[3];
    procs.set(pid, { ppid, rss, cmd: m[4] });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let totalKb = 0;
  for (const [pid, p] of procs) {
    const tm = p.cmd.match(TEST_RE);
    if (!tm) continue;
    // Root = a test-file process whose PARENT is not itself a test-file
    // process (the runner or a shell), so nested helpers don't double-root.
    const par = procs.get(p.ppid);
    if (par && TEST_RE.test(par.cmd)) continue;
    let sumKb = 0;
    const stack = [pid];
    while (stack.length) {
      const q = stack.pop();
      sumKb += (procs.get(q) || { rss: 0 }).rss;
      for (const c of kids.get(q) || []) stack.push(c);
    }
    totalKb += sumKb;
    const key = tm[1] + '#' + pid;
    const rec = peaks.get(key) || { file: tm[1], rootPid: pid, peakKb: 0, samples: 0 };
    rec.peakKb = Math.max(rec.peakKb, sumKb);
    rec.samples++;
    peaks.set(key, rec);
  }
  peakTotalKb = Math.max(peakTotalKb, totalKb);
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
const timer = setInterval(sample, intervalMs);
child.on('exit', (code, signal) => {
  clearInterval(timer);
  sample();
  const rows = [...peaks.values()].sort((a, b) => b.peakKb - a.peakKb);
  const gb = (kb) => (kb / 1024 / 1024).toFixed(2);
  process.stderr.write('\n[rss-sample] per-test-tree peak RSS (sampled every ' +
    intervalMs + 'ms — an under-estimate; pick weights with headroom):\n');
  for (const r of rows) {
    process.stderr.write(`  ${gb(r.peakKb).padStart(6)} GB  ${r.file}  (pid ${r.rootPid}, ${r.samples} samples)\n`);
  }
  process.stderr.write(`  ${gb(peakTotalKb).padStart(6)} GB  <all tracked trees at one instant>\n`);
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({
      intervalMs, peakTotalKb,
      trees: rows.map(r => ({ file: r.file, rootPid: r.rootPid, peakKb: r.peakKb, samples: r.samples })),
    }, null, 2) + '\n');
    process.stderr.write(`[rss-sample] wrote ${outPath}\n`);
  }
  process.exit(signal ? 128 + 15 : (code == null ? 1 : code));
});
