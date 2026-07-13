// idlemeter.mjs — measure browser-tab CPU cost of an idle gucOS desktop
// (todos/IDLE-POWER.md "Baseline" stage; re-run after Stage 3 and Stage 4).
//
// Boots os.html in the sweep's WebGPU-flagged Chromium, settles on VT2, and
// samples the WHOLE Chromium process tree's cumulative CPU time (`ps
// cputime` delta / wall clock — an interval measure, not ps's decaying
// %cpu) for two scenarios:
//   A. idle desktop (wm + taskbar only, nothing else running)
//   B. 4 settled windows (winbox, winbox fixed, term, fileman)
// Per-process breakdown is classified by Chromium --type= (browser / gpu /
// renderer / utility); the renderer bucket is where the kernel worker +
// app workers live, so it's the number IDLE-POWER stages should move.
//
// Usage: node tools/idlemeter.mjs [--seconds=20] [--settle=6]
// Record results in a committed dev log (logs/YYYY-MM-DD/...) per the
// baseline staging note.
import { execFileSync } from 'node:child_process';
import { openOsSession } from '../tests/browser/lib/os-harness.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const SECONDS = arg('seconds', 20);
const SETTLE = arg('settle', 6);
const PORT = 3247;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "MM:SS.cc" or "HH:MM:SS.cc" → seconds.
function parseCputime(s) {
  const parts = s.split(':').map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

// One ps snapshot → { pid: { ppid, cpu, command } }.
function psSnapshot() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,cputime=,command='], { encoding: 'utf8' });
  const procs = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs[m[1]] = { ppid: m[2], cpu: parseCputime(m[3]), command: m[4] };
  }
  return procs;
}

// The Chromium tree rooted at this node process's chromium child (Playwright
// spawns the browser directly; helpers are the browser process's children).
function chromiumTree(procs) {
  const kids = {};
  for (const [pid, p] of Object.entries(procs)) (kids[p.ppid] ||= []).push(pid);
  const roots = (kids[String(process.pid)] || []).filter(pid => /chrom/i.test(procs[pid].command));
  const tree = [];
  const walk = pid => { tree.push(pid); for (const c of kids[pid] || []) walk(c); };
  roots.forEach(walk);
  return tree;
}

function classify(command) {
  const m = command.match(/--type=(\S+)/);
  if (!m) return 'browser';
  if (m[1] === 'gpu-process') return 'gpu';
  if (m[1] === 'renderer') return 'renderer';
  return 'utility';
}

// Sample the tree's cputime twice, `seconds` apart; report delta/wall per
// class. Processes that die mid-interval contribute their t0 reading as a
// floor (undercount, never fabrication); new ones contribute cpu-since-start.
async function measure(label, seconds) {
  const t0 = psSnapshot();
  const wall0 = Date.now();
  await sleep(seconds * 1000);
  const t1 = psSnapshot();
  const wall = (Date.now() - wall0) / 1000;
  const byClass = { browser: 0, gpu: 0, renderer: 0, utility: 0 };
  let total = 0;
  for (const pid of chromiumTree(t1)) {
    const d = t1[pid].cpu - (t0[pid] ? t0[pid].cpu : 0);
    byClass[classify(t1[pid].command)] += d;
    total += d;
  }
  const pct = s => (100 * s / wall).toFixed(1).padStart(5) + '%';
  console.log(`\n${label} (${wall.toFixed(1)}s wall):`);
  console.log(`  total    ${pct(total)}`);
  for (const [k, v] of Object.entries(byClass)) console.log(`  ${k.padEnd(8)} ${pct(v)}`);
  return { label, wall, total: 100 * total / wall, byClass };
}

const session = await openOsSession({ port: PORT, serverTries: 600, promptNeedle: /~ #/ });
const { page, setVt, waitScreen, waitPixel, close } = session;
try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  await waitPixel(400, SH - 14, [192, 192, 192], 60000);   // taskbar strip up

  await sleep(SETTLE * 1000);                              // boot churn settle
  const idle = await measure('A. idle desktop', SECONDS);

  // Scenario B: 4 windows — two winbox flavors, a term (hush prompt), a
  // fileman. Typed on VT1; pixels settle on VT2.
  await setVt(1);
  await page.keyboard.type('winbox & winbox fixed & term & fileman &\r');
  await setVt(2);
  await sleep(SETTLE * 1000);                              // launch churn settle
  const windows = await measure('B. 4 settled windows', SECONDS);

  console.log('\nJSON: ' + JSON.stringify({ seconds: SECONDS, idle, windows }));
} finally {
  await close();
}
