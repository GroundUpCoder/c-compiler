// Sweep membership for doom-renders.mjs (ticket #543). The driver tests the
// COMPILER-EMITTED single-file doom.html — the epic's reference graphics
// workload through the emitted-page path (BLOCK_FS backend, dataFiles
// seeding, the #542 class) — but until this wrapper it lived in NO suite:
// #542 broke every bundled asset (O_RDONLY seeding fds) and sat on main
// because only a human running the driver by hand could catch it.
//
// This file exists so the os-*.mjs discovery glob picks the driver up. It
// rebuilds doom.html when stale (a gitignored build product must never be
// the reason a suite is red — the manual driver's refuse-on-stale stance is
// #466's and stays), then runs the driver unchanged, so hand-runs and suite
// runs execute the same code. Diff-awareness needs no new rule: every doom
// input (vendor/doom/**, compiler.js, host.js) already maps to `sweep` in
// tests/run.js's RULES.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFreshDoomPage } from './lib/doom-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureFreshDoomPage();
const r = spawnSync(process.execPath, [path.join(__dirname, 'doom-renders.mjs')],
  { stdio: 'inherit' });
process.exit(r.status ?? 1);
