'use strict';
// tests/lib/host-health.js — host-condition sampling for the gate (#725).
//
// WHY THIS EXISTS. On 2026-08-20 the authoritative gate ran on a memory-
// starved host and reported unrelated product suites as hard tree failures
// (ticket #725's Evidence section): three full gates produced crossed,
// non-reproducible failure sets while ~102 MB sat free, 854 MB swap was in
// use, and a cold bake ran 3.6x slow. Nothing recorded the host's condition,
// so the reds could only be attributed by rerunning everything.
//
// 🔴 THE CALIBRATION TRAP, measured before this module was written (#725
// comment, 2026-08-25): a HEALTHY idle Mac shows 74 MB free / 846 MB swap /
// 2.3 GB compressor — indistinguishable from the incident's "starved"
// numbers on two of three axes. macOS deliberately runs near-zero "free";
// reclaimable memory hides in inactive/speculative/purgeable pages (5.3 GB
// on the healthy box at measurement time). So raw free/swap/compressor are
// EVIDENCE fields, never verdicts. The discriminating instruments are the
// platform's own:
//   - kern.memorystatus_vm_pressure_level — macOS's pressure verdict:
//     1 normal / 2 warn / 4 critical (the jetsam input);
//   - kern.memorystatus_level — system-wide free percentage (68 healthy);
//   - computed available = free + inactive + speculative + purgeable pages
//     (a hard-floor backstop only).
// Do not re-derive thresholds from the incident's raw numbers — they
// describe a starved box but do not discriminate one.
//
// WHAT THIS MODULE DOES (stage A of #725): sample(), the pure parsers under
// it, and suspectFromSamples() — the labelling rule that marks a FAILING
// gate row as host-suspect when the boundary samples show degradation.
// 🔴 A label is all it ever is: suspectFromSamples never touches a row's
// status, never suppresses a row, and never feeds a retry. An attributed
// flake must never become an automatic pass — a red LABELLED with evidence
// beats a red forgiven.
//
// Consumers: tests/run.js records a sample per suite row (before/after) and
// at run start/end in build/test-run/summary.json, so a red can be told from
// host exhaustion without reconstructing Activity Monitor state after the
// fact.
//
// Portability: the instruments are darwin-only. Elsewhere sample() degrades
// to os.freemem()/loadavg with `measured: false` — an honest "unmeasured",
// never a fabricated "healthy".
//
// Test seam: CC_HOST_HEALTH_FAKE=<path to a JSON sample> makes sample()
// return that object (tagged fake: true) instead of measuring. Tests only;
// it is what lets a refusal control run on a healthy box.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// Suspect thresholds. Pressure level 2 is macOS's own "warn"; the
// memorystatus percentage backstop (<= 15%) is the neighborhood where jetsam
// starts acting. These gate a LABEL here (and stage B's warn tier), not a
// refusal.
const SUSPECT_PRESSURE = 2;
const SUSPECT_FREE_PCT = 15;

// ---------------------------------------------------------------- parsers
// Pure, so the host suite can pin them on canned text (the same design as
// harness-leaks.js's classifyTempDir/parsePs).

// `vm_stat` output → page size + the page counts this module reads. A label
// the kernel stops printing parses to null rather than 0 — a missing
// instrument must degrade to "unmeasured", not to "zero pages".
function parseVmStat(text) {
  const ps = /page size of (\d+) bytes/.exec(String(text));
  const page = (label) => {
    const r = new RegExp('^"?' + label + '"?:\\s+(\\d+)\\.', 'm').exec(String(text));
    return r ? +r[1] : null;
  };
  return {
    pageSize: ps ? +ps[1] : null,
    free: page('Pages free'),
    active: page('Pages active'),
    inactive: page('Pages inactive'),
    speculative: page('Pages speculative'),
    wired: page('Pages wired down'),
    purgeable: page('Pages purgeable'),
    compressor: page('Pages occupied by compressor'),
  };
}

// `sysctl -n vm.swapusage` → used bytes. Format:
//   "total = 2048.00M  used = 846.12M  free = 1201.88M  (encrypted)"
function parseSwapUsage(text) {
  const m = /used\s*=\s*([\d.]+)([KMG])/.exec(String(text));
  if (!m) return null;
  return +m[1] * { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 }[m[2]];
}

// Reclaimable-inclusive available bytes — the backstop figure. free alone
// understates by GBs on a healthy Mac (the calibration trap above).
// 🔴 EVERY summed field must be genuinely present or the answer is null
// (#725 counter-pass): the first landing coerced missing reclaimable fields
// to 0, so a truncated vm_stat read produced a confident WRONG number — and
// the error's direction (available looks smaller) points straight at stage
// B's refusal floor. A partial read must degrade to "unmeasured", never to
// "nearly out of memory".
function availableBytes(vm) {
  if (!vm || vm.pageSize == null || vm.free == null || vm.inactive == null ||
      vm.speculative == null || vm.purgeable == null) return null;
  return (vm.free + vm.inactive + vm.speculative + vm.purgeable) * vm.pageSize;
}

// ---------------------------------------------------------------- sampling

const gb = (b) => (b == null ? null : +(b / 2 ** 30).toFixed(2));

function runQuiet(cmd, args) {
  try {
    // A wedged sysctl on a dying box must not hang the sampler — the gate
    // would then be blocked by the very condition it is trying to record.
    return execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; }
}

// One host-condition sample. Cheap (~20ms on darwin: two sysctls + vm_stat),
// so the dispatcher can afford one per suite row boundary.
// {
//   t, fake?, measured,            // measured=false ⇒ verdict fields are null
//   pressure,                      // 1 | 2 | 4 | null  (the OS's own verdict)
//   memFreePct,                    // kern.memorystatus_level | null
//   availGb, freeGb, swapUsedGb, compressorGb,   // evidence fields
//   load1, totalGb
// }
function sample() {
  if (process.env.CC_HOST_HEALTH_FAKE) {
    try {
      const fake = JSON.parse(fs.readFileSync(process.env.CC_HOST_HEALTH_FAKE, 'utf8'));
      return { t: new Date().toISOString(), fake: true, ...fake };
    } catch (e) {
      // A named-but-unreadable fake is a broken TEST setup — fail loud, do
      // not silently fall through to real measurement under a control that
      // believes it injected a starved host.
      throw new Error(`CC_HOST_HEALTH_FAKE=${process.env.CC_HOST_HEALTH_FAKE} unreadable: ${e.message}`);
    }
  }
  const base = {
    t: new Date().toISOString(),
    load1: +os.loadavg()[0].toFixed(2),
    totalGb: gb(os.totalmem()),
  };
  if (process.platform !== 'darwin') {
    return { ...base, measured: false, pressure: null, memFreePct: null,
             availGb: null, freeGb: gb(os.freemem()), swapUsedGb: null, compressorGb: null };
  }
  const pressureTxt = runQuiet('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
  const levelTxt = runQuiet('sysctl', ['-n', 'kern.memorystatus_level']);
  const vm = parseVmStat(runQuiet('vm_stat', []) || '');
  const swapUsed = parseSwapUsage(runQuiet('sysctl', ['-n', 'vm.swapusage']) || '');
  const pressure = pressureTxt != null && /^\d+$/.test(pressureTxt.trim()) ? +pressureTxt.trim() : null;
  const memFreePct = levelTxt != null && /^\d+$/.test(levelTxt.trim()) ? +levelTxt.trim() : null;
  const avail = availableBytes(vm);
  return {
    ...base,
    // Every instrument dead ⇒ unmeasured; a PARTIAL read still counts as
    // measured (the fields that answered are real).
    measured: pressure != null || memFreePct != null || avail != null,
    pressure,
    memFreePct,
    availGb: gb(avail),
    freeGb: vm.free != null && vm.pageSize != null ? gb(vm.free * vm.pageSize) : null,
    swapUsedGb: gb(swapUsed),
    compressorGb: vm.compressor != null && vm.pageSize != null ? gb(vm.compressor * vm.pageSize) : null,
  };
}

// ------------------------------------------------------------- labelling

// For a FAILING row: do the boundary samples show a degraded host? Returns
// { why: [...] } naming each firing instrument, or null. Callers attach this
// as `hostSuspect` on the row — a label carrying evidence, NEVER a status
// change (see the header; that property is pinned by the host suite).
function suspectFromSamples(before, after) {
  const why = [];
  for (const [name, s] of [['before', before], ['after', after]]) {
    if (!s || s.measured === false) continue;
    if (s.pressure != null && s.pressure >= SUSPECT_PRESSURE) {
      why.push(`${name}: memory pressure level ${s.pressure} (OS verdict; 2=warn, 4=critical)`);
    } else if (s.memFreePct != null && s.memFreePct <= SUSPECT_FREE_PCT) {
      why.push(`${name}: memorystatus level ${s.memFreePct}% free (jetsam territory)`);
    }
  }
  return why.length ? { why } : null;
}

module.exports = {
  sample, suspectFromSamples,
  parseVmStat, parseSwapUsage, availableBytes,
  SUSPECT_PRESSURE, SUSPECT_FREE_PCT,
};
