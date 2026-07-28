// Guardrail (d) — mkpkg repo ISOLATION (todos/0388).
//
// `index.json` + `pool/` are one repo and a build REPLACES it: the orphan prune
// deletes every payload the fresh index does not name. Sequentially that is the
// accepted clang/base thrash. Concurrently — eight kernel e2es used to build
// into the one dist/packages at -j2 — it is a race that retargets another
// builder's repo mid-read, and the dangerous direction is base-vs-base, where
// the surviving index still LOOKS correct.
//
// This file is the executable form of that claim. It proves, on the REAL tool
// with synthetic definitions (no compilation, no clang sibling needed):
//
//   RED CONTROL  two differing builds into ONE out dir: the second DELETES the
//                first's payload and drops its name. This is the bug, still
//                reproducible on demand — without it, the green leg below
//                would pass just as well against a tool that never prunes at
//                all, and would prove nothing.
//   GREEN        the same two builds into per-build out dirs over a SHARED
//                --pool: both repos stay complete and BOTH payloads stay
//                readable, while the pool is warm-cached rather than rebuilt.
//   SHARED POOL  the shared store is never deleted from (append-only), and the
//                per-repo pool/ is a hardlinked view, not a byte copy.
//   LOCK         two concurrent builds of one out dir refuse loudly (exit 1)
//                instead of interleaving; a lock whose holder is dead is
//                stolen, so a killed build never wedges the tree.
//
// Run: node tests/serve/test_mkpkg_isolation.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = path.join(ROOT, 'tools', 'mkpkg.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-iso-'));

// Two definition sets that differ in membership — the shape of the base-vs-
// superset split, without needing the clang sibling. `content` entries compile
// nothing, so a whole build is milliseconds.
function defsDir(name, pkgNames) {
  const d = path.join(tmp, 'defs-' + name);
  fs.mkdirSync(d, { recursive: true });
  for (const p of pkgNames) {
    fs.writeFileSync(path.join(d, p + '.json'), JSON.stringify({
      name: p, version: '1.0', summary: 'isolation fixture ' + p,
      files: { tool: { content: `#!/bin/sh\necho ${p}\n`, mode: 0o755 } },
      bin: { [p]: 'tool' },
    }, null, 2) + '\n');
  }
  return d;
}
const DEFS_BOTH = defsDir('both', ['iso-alpha', 'iso-common']);
const DEFS_ONE = defsDir('one', ['iso-common']);

function mkpkg(args, opts) {
  return cp.spawnSync(process.execPath, [MKPKG, '--quiet', ...args],
    Object.assign({ encoding: 'utf-8', timeout: 120000 }, opts || {}));
}
function readIndex(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'));
}
// "Is this repo intact?" — the name is indexed AND its payload bytes are
// actually readable at the url the index advertises. Checking only the index
// would miss the prune, which is the half that bit us.
function serves(dir, name) {
  let idx;
  try { idx = readIndex(dir); } catch (e) { return false; }
  const entry = idx.packages[name];
  if (!entry) return false;
  return fs.existsSync(path.join(dir, entry.payload.url));
}

/* ---- RED CONTROL: one out dir, two differing builds ---- */
{
  const out = path.join(tmp, 'shared-outdir');
  const a = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_BOTH}`]);
  check('control: the two-package build succeeds', a.status === 0, a.stderr);
  check('control: it serves iso-alpha', serves(out, 'iso-alpha'));
  const alphaUrl = readIndex(out).packages['iso-alpha'].payload.url;

  const b = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`]);
  check('control: the one-package build succeeds', b.status === 0, b.stderr);
  // THE BUG, on demand: same dir, so the second build owns it and prunes.
  check('RED CONTROL: a differing build into the SAME out dir drops the name',
    !readIndex(out).packages['iso-alpha']);
  check('RED CONTROL: ...and DELETES its payload bytes',
    !fs.existsSync(path.join(out, alphaUrl)), alphaUrl);
}

/* ---- GREEN: per-build out dirs over one shared pool ---- */
{
  const pool = path.join(tmp, 'pool');
  const outA = path.join(tmp, 'repo-a');
  const outB = path.join(tmp, 'repo-b');

  const a = mkpkg([`--out=${outA}`, `--pool=${pool}`, `--packages-dir=${DEFS_BOTH}`]);
  check('isolated: the two-package repo builds', a.status === 0, a.stderr);
  check('isolated: repo A serves iso-alpha', serves(outA, 'iso-alpha'));

  const b = mkpkg([`--out=${outB}`, `--pool=${pool}`, `--packages-dir=${DEFS_ONE}`]);
  check('isolated: the one-package repo builds', b.status === 0, b.stderr);
  check('isolated: repo B serves iso-common', serves(outB, 'iso-common'));
  check('isolated: repo B correctly does NOT list iso-alpha',
    !readIndex(outB).packages['iso-alpha']);

  // The actual regression guard: B's build must not have touched A.
  check('🔴 repo A STILL serves iso-alpha after B built (index + payload bytes)',
    serves(outA, 'iso-alpha'));
  check('🔴 repo A still serves iso-common too', serves(outA, 'iso-common'));

  // The shared store is append-only — B may not delete what A indexed.
  const alphaFile = path.basename(readIndex(outA).packages['iso-alpha'].payload.url);
  check('the shared pool store keeps iso-alpha (append-only, never pruned by a partial build)',
    fs.existsSync(path.join(pool, alphaFile)));

  // A view, not a copy: same inode as the store entry.
  const vs = fs.statSync(path.join(outA, 'pool', alphaFile));
  const ss = fs.statSync(path.join(pool, alphaFile));
  check('the per-repo pool/ is a HARDLINKED view of the store, not a byte copy',
    vs.ino === ss.ino && vs.dev === ss.dev, `view ino=${vs.ino} store ino=${ss.ino}`);

  // Reuse is what buys the isolation its speed: B shares A's warm payload.
  const commonA = readIndex(outA).packages['iso-common'].payload.sha256;
  const commonB = readIndex(outB).packages['iso-common'].payload.sha256;
  check('both repos reference the SAME content-addressed payload (warm cache shared)',
    commonA === commonB, `${commonA.slice(0, 16)} vs ${commonB.slice(0, 16)}`);
}

/* ---- LOCK: concurrent builds of one out dir refuse, stale locks self-heal ---- */
{
  const out = path.join(tmp, 'locked');
  fs.mkdirSync(out, { recursive: true });
  const lock = path.join(out, '.mkpkg-lock');

  // A LIVE holder — this process, which is certainly alive.
  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid, host: os.hostname(), argv: ['--out=' + out], at: new Date().toISOString() }));
  const held = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`]);
  check('a build into a dir another LIVE build owns exits 1', held.status === 1, `status=${held.status}`);
  check('...and names the holder and the --out/--pool fix',
    /another build already owns/.test(String(held.stderr)) &&
    /--pool=/.test(String(held.stderr)), String(held.stderr).slice(0, 400));
  check('...and does not clobber the lock it refused', fs.existsSync(lock));
  fs.unlinkSync(lock);

  // A STALE holder: a pid that cannot be running. Killed builds must not wedge
  // the tree — the lock is stolen, not obeyed.
  let deadPid = 999999;
  for (; deadPid > 2; deadPid--) {
    try { process.kill(deadPid, 0); } catch (e) { if (e.code === 'ESRCH') break; }
  }
  fs.writeFileSync(lock, JSON.stringify({
    pid: deadPid, host: os.hostname(), argv: ['--out=' + out], at: new Date().toISOString() }));
  const stolen = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`]);
  check(`a STALE lock (dead pid ${deadPid}) is stolen, not obeyed`, stolen.status === 0, stolen.stderr);
  check('...and the build completes normally', serves(out, 'iso-common'));
  check('the lock is released when the build exits', !fs.existsSync(lock));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILURE(S)` : 'All mkpkg isolation checks passed');
process.exit(failures ? 1 : 0);
