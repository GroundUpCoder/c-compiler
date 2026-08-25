// #725: the host-health sampler (tests/lib/host-health.js) — the instrument
// the gate uses to record host condition per suite row, and the labelling
// rule that marks a failing row host-suspect.
//
// What is pinned here, and why each matters:
//   - the parsers, on canned REAL output (captured 2026-08-25) — a silent
//     parse regression would make every sample read "unmeasured" and the
//     telemetry would go quietly blind;
//   - a missing vm_stat label parses to null, never 0 — an absent instrument
//     must degrade to "unmeasured", not to "zero pages free";
//   - the calibration trap: the HEALTHY box's own numbers (74 MB free,
//     846 MB swap) must NOT label a row suspect — raw free/swap are not
//     verdicts (#725 comment, 2026-08-25);
//   - suspectFromSamples fires on the OS pressure verdict (2/4) and the
//     memorystatus backstop — the guard-can-fire direction — and stays quiet
//     on healthy/unmeasured samples — the guard-stays-quiet direction;
//   - 🔴 suspectFromSamples returns a LABEL only; it has no status field and
//     nothing here may ever soften a red (jku condition 3 on #725);
//   - the CC_HOST_HEALTH_FAKE seam: a readable fake is returned verbatim
//     (tagged fake:true), an unreadable one THROWS — a refusal control that
//     silently measured the real (healthy) host would be testing nothing;
//   - sample() integration on darwin: measured:true with in-range fields.
//
// Run: node tests/host/test_host_health.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HH = require('../lib/host-health.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

// ---- canned real output (this host, 2026-08-25) -------------------------

const VM_STAT_REAL = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4753.
Pages active:                                 338667.
Pages inactive:                               345335.
Pages speculative:                              7127.
Pages throttled:                                   0.
Pages wired down:                             166491.
Pages purgeable:                                6001.
"Translation faults":                    66413944411.
Pages copy-on-write:                      1027190982.
Pages zero filled:                       50825808407.
Pages reactivated:                        3245038436.
Pages purged:                              110179686.
File-backed pages:                            324694.
Anonymous pages:                              366435.
Pages stored in compressor:                   718484.
Pages occupied by compressor:                 151917.
Swapins:                                    59896511.
Swapouts:                                   61943934.
`;

// ---- parsers ------------------------------------------------------------

{
  const vm = HH.parseVmStat(VM_STAT_REAL);
  check('parseVmStat: page size', vm.pageSize === 16384, vm.pageSize);
  check('parseVmStat: free', vm.free === 4753, vm.free);
  check('parseVmStat: inactive', vm.inactive === 345335, vm.inactive);
  check('parseVmStat: speculative', vm.speculative === 7127, vm.speculative);
  check('parseVmStat: purgeable', vm.purgeable === 6001, vm.purgeable);
  check('parseVmStat: compressor OCCUPIED (not stored)', vm.compressor === 151917, vm.compressor);

  // available = (free + inactive + speculative + purgeable) * pageSize —
  // the reclaimable-inclusive figure; free alone would say 74 MB on a box
  // with 5.7 GB actually available.
  const avail = HH.availableBytes(vm);
  const expect = (4753 + 345335 + 7127 + 6001) * 16384;
  check('availableBytes: reclaimable-inclusive', avail === expect, { avail, expect });
  check('availableBytes: ~5.55 GB on the canned healthy box',
    Math.abs(avail / 2 ** 30 - 5.55) < 0.05, avail / 2 ** 30);

  // A label the kernel stops printing → null, never 0.
  const noFree = HH.parseVmStat(VM_STAT_REAL.replace(/^Pages free:.*\n/m, ''));
  check('parseVmStat: missing label parses to null, not 0', noFree.free === null, noFree.free);
  check('availableBytes: null on a missing pillar (unmeasured, not zero)',
    HH.availableBytes(noFree) === null);
  // #725 counter-pass: EVERY summed pillar is required, not just free. The
  // first landing coerced a missing inactive/speculative/purgeable to 0, so
  // the reviewer's truncated vm_stat (page size + free only) yielded a
  // confident 1.6 MB — "nearly out of memory" — instead of "unmeasured".
  // That error's direction aims at stage B's refusal floor: a truncated read
  // on a healthy box would refuse the gate.
  check('availableBytes: reviewer\'s truncated input (free only) → null, never 1.6 MB',
    HH.availableBytes(HH.parseVmStat(
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                     100.\n')) === null);
  for (const pillar of ['Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const cut = HH.parseVmStat(VM_STAT_REAL.replace(new RegExp('^' + pillar + ':.*\\n', 'm'), ''));
    check(`availableBytes: null when ${pillar} is absent`, HH.availableBytes(cut) === null);
  }

  check('parseSwapUsage: real format',
    HH.parseSwapUsage('vm.swapusage: total = 2048.00M  used = 846.12M  free = 1201.88M  (encrypted)')
      === 846.12 * 2 ** 20);
  check('parseSwapUsage: G suffix', HH.parseSwapUsage('used = 1.50G') === 1.5 * 2 ** 30);
  check('parseSwapUsage: garbage → null', HH.parseSwapUsage('nonsense') === null);
}

// ---- suspectFromSamples -------------------------------------------------

const healthy = { measured: true, pressure: 1, memFreePct: 68, availGb: 5.6,
                  freeGb: 0.07, swapUsedGb: 0.83, compressorGb: 2.3 };
const warn = { ...healthy, pressure: 2 };
const critical = { ...healthy, pressure: 4, memFreePct: 4 };
const lowPct = { ...healthy, pressure: 1, memFreePct: 12 };

{
  // Quiet direction: the CALIBRATION TRAP leg. This healthy sample carries
  // the incident-lookalike raw numbers (70 MB free, 830 MB swap, 2.3 GB
  // compressor) — labelling on those would mark every row on every healthy
  // Mac suspect, and the label would be noise within a week.
  check('healthy/healthy (incident-lookalike raw numbers) → NO suspect',
    HH.suspectFromSamples(healthy, healthy) === null);
  check('unmeasured samples → NO suspect (no fabricated verdict)',
    HH.suspectFromSamples({ measured: false }, { measured: false }) === null);
  check('missing samples → NO suspect',
    HH.suspectFromSamples(null, undefined) === null);

  // Fire direction: the OS's own verdict.
  const w = HH.suspectFromSamples(healthy, warn);
  check('pressure 2 after → suspect', !!w, w);
  check('…naming the instrument and the boundary',
    !!w && w.why.length === 1 && /after: memory pressure level 2/.test(w.why[0]), w && w.why);
  const c = HH.suspectFromSamples(critical, healthy);
  check('pressure 4 before → suspect naming level 4',
    !!c && /before: memory pressure level 4/.test(c.why[0]), c && c.why);
  const p = HH.suspectFromSamples(healthy, lowPct);
  check('memorystatus 12% (pressure normal) → suspect via the backstop',
    !!p && /after: memorystatus level 12% free/.test(p.why[0]), p && p.why);
  const both = HH.suspectFromSamples(warn, critical);
  check('degraded at both boundaries → both named', !!both && both.why.length === 2, both && both.why);

  // 🔴 The never-a-pass property, pinned structurally: the label is
  // evidence-only — it must not carry anything a reader could mistake for a
  // verdict or a directive (no status, no pass, no skip, no retry).
  const keys = Object.keys(w);
  check('label carries ONLY evidence (why), no verdict/directive fields',
    keys.length === 1 && keys[0] === 'why', keys);
}

// ---- the CC_HOST_HEALTH_FAKE seam --------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fake-'));
  const fakePath = path.join(dir, 'sample.json');
  fs.writeFileSync(fakePath, JSON.stringify(critical));
  // Child probes so the env var never leaks into THIS process's later legs.
  const probe = (env) => cp.spawnSync(process.execPath, ['-e', `
    const HH = require(${JSON.stringify(require.resolve('../lib/host-health.js'))});
    try { const s = HH.sample(); console.log(JSON.stringify(s)); }
    catch (e) { console.log('THREW: ' + e.message); }
  `], { encoding: 'utf8', env: { ...process.env, ...env } });

  const r1 = probe({ CC_HOST_HEALTH_FAKE: fakePath });
  let s1 = null;
  try { s1 = JSON.parse(r1.stdout); } catch {}
  check('fake seam: injected sample returned verbatim',
    !!s1 && s1.pressure === 4 && s1.memFreePct === 4, r1.stdout.trim().slice(0, 120));
  check('fake seam: tagged fake:true (a control run is never mistakable for a measurement)',
    !!s1 && s1.fake === true);

  const r2 = probe({ CC_HOST_HEALTH_FAKE: path.join(dir, 'no-such.json') });
  check('fake seam: unreadable fake THROWS (never silently measures the real host under a control)',
    /^THREW: CC_HOST_HEALTH_FAKE=/.test(r2.stdout), r2.stdout.trim().slice(0, 120));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- sample() integration ----------------------------------------------

{
  const s = HH.sample();
  check('sample: has a timestamp', typeof s.t === 'string' && !Number.isNaN(Date.parse(s.t)));
  check('sample: totalGb plausible', s.totalGb > 1 && s.totalGb < 4096, s.totalGb);
  if (process.platform === 'darwin') {
    check('sample(darwin): measured', s.measured === true, s);
    check('sample(darwin): pressure is an OS level', [1, 2, 4].includes(s.pressure), s.pressure);
    check('sample(darwin): memFreePct in range', s.memFreePct >= 0 && s.memFreePct <= 100, s.memFreePct);
    check('sample(darwin): availGb positive', s.availGb > 0, s.availGb);
  } else {
    check('sample(non-darwin): honest measured:false', s.measured === false, s);
    check('sample(non-darwin): no fabricated verdict fields',
      s.pressure === null && s.memFreePct === null && s.availGb === null, s);
  }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
