#!/usr/bin/env node
// bench-2x2: the ONE statistics implementation. Every cell's raw samples go
// through this, so "p99" means the same thing in every row of the table.
//
//   node analyze.js <label> < samples.txt
//   node analyze.js --hist <label> < samples.txt     (adds the jitter histogram)
'use strict';

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  // Nearest-rank: the smallest value at or below which at least p% of samples
  // fall. Chosen over interpolation because a max/p99 for frame pacing should
  // be an OBSERVED sample, not a synthetic value between two observations.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function stats(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const varc = s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n > 1 ? n - 1 : 1);
  return {
    n,
    min: s[0], p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99), max: s[n - 1],
    mean, sd: Math.sqrt(varc), sorted: s,
  };
}

function fmtNs(v) {
  if (!isFinite(v)) return 'n/a';
  if (v >= 1e6) return (v / 1e6).toFixed(3) + ' ms';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' us';
  return v.toFixed(0) + ' ns';
}

function histogram(st, buckets) {
  // Log-spaced buckets: frame-time jitter spans orders of magnitude (a clean
  // frame is ~us, a stop-the-world pause is ~ms). Linear buckets would put
  // 99% of samples in bucket 0 and show nothing.
  const lo = Math.max(1, st.min), hi = st.max;
  const lgLo = Math.log10(lo), lgHi = Math.log10(hi <= lo ? lo * 10 : hi);
  const edges = [];
  for (let i = 0; i <= buckets; i++) edges.push(Math.pow(10, lgLo + (lgHi - lgLo) * (i / buckets)));
  const counts = new Array(buckets).fill(0);
  for (const v of st.sorted) {
    let b = Math.floor(((Math.log10(Math.max(v, 1)) - lgLo) / (lgHi - lgLo)) * buckets);
    if (b < 0) b = 0; if (b >= buckets) b = buckets - 1;
    counts[b]++;
  }
  return { edges, counts };
}

const args = process.argv.slice(2);
const wantHist = args[0] === '--hist';
const label = (wantHist ? args[1] : args[0]) || 'unnamed';

let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  const xs = buf.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
  if (!xs.length) { console.error('analyze: NO SAMPLES on stdin for ' + label); process.exit(3); }
  const st = stats(xs);

  console.log('== ' + label + ' ==');
  console.log('  n=' + st.n
    + '  p50=' + fmtNs(st.p50)
    + '  p90=' + fmtNs(st.p90)
    + '  p99=' + fmtNs(st.p99)
    + '  max=' + fmtNs(st.max)
    + '  (sd=' + fmtNs(st.sd) + ')');

  if (wantHist) {
    const h = histogram(st, 18);
    const peak = Math.max(...h.counts);
    console.log('  jitter histogram (log-spaced):');
    for (let i = 0; i < h.counts.length; i++) {
      if (h.counts[i] === 0 && i > 0 && i < h.counts.length - 1
          && h.counts[i - 1] === 0 && h.counts[i + 1] === 0) continue;
      const bar = '#'.repeat(Math.round((h.counts[i] / peak) * 44));
      console.log('    ' + fmtNs(h.edges[i]).padStart(9)
        + ' .. ' + fmtNs(h.edges[i + 1]).padStart(9)
        + ' | ' + String(h.counts[i]).padStart(5) + ' ' + bar);
    }
  }

  if (process.env.BENCH_JSON) {
    const out = { label, n: st.n, min: st.min, p50: st.p50, p90: st.p90, p99: st.p99, max: st.max, mean: st.mean, sd: st.sd };
    require('fs').appendFileSync(process.env.BENCH_JSON, JSON.stringify(out) + '\n');
  }
});
