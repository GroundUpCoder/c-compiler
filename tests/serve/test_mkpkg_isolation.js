// Guardrail (d) — mkpkg repo ISOLATION (todos/0388) + ADDITIVE publish (#580).
//
// `index.json` + `pool/` are one repo. Since #580 a build UPSERTS it: entries
// this invocation cannot enumerate are carried forward, and only --prune drops
// them (and their payload bytes). Before #580 every build REPLACED the repo —
// the orphan prune deleted every payload the fresh index did not name — which
// is why 41 consecutive deploys silently unpublished the -clang set, and why
// concurrent builders (eight kernel e2es used to build into the one
// dist/packages at -j2) could retarget each other's repo mid-read; the
// dangerous direction is base-vs-base, where the surviving index still LOOKS
// correct.
//
// This file is the executable form of those claims. It proves, on the REAL
// tool with synthetic definitions (no compilation, no clang sibling needed):
//
//   UNION        two differing builds into ONE out dir: the second KEEPS the
//                first's name and payload (the #580 regression guard for the
//                41-deploy episode — set A then set B publishes the union).
//   RED CONTROL  the same second build WITH --prune drops the name and
//                DELETES its payload. The destruction stays reproducible on
//                demand — without it, the union legs would pass just as well
//                against a tool that never prunes at all, and would prove
//                nothing about the instrument.
//   SERVABLE     a carried entry whose payload bytes are gone refuses loudly
//                (exit 1, naming --prune) instead of publishing a 404 row.
//   GREEN        the two differing builds into per-build out dirs over a
//                SHARED --pool: both repos stay complete and BOTH payloads
//                stay readable, while the pool is warm-cached, not rebuilt.
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
  return cp.spawnSync(process.execPath, [MKPKG, '--no-baseline', '--quiet', ...args],
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

/* ---- UNION (#580): one out dir, two differing builds — additive default ---- */
{
  const out = path.join(tmp, 'shared-outdir');
  const a = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_BOTH}`]);
  check('union: the two-package build succeeds', a.status === 0, a.stderr);
  check('union: it serves iso-alpha', serves(out, 'iso-alpha'));
  const alphaUrl = readIndex(out).packages['iso-alpha'].payload.url;

  const b = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`]);
  check('union: the one-package build succeeds', b.status === 0, b.stderr);
  // The #580 regression guard for the 41-deploy episode: publishing set A
  // then set B yields the UNION, not B alone.
  check('🔴 UNION: a differing build into the SAME out dir KEEPS the carried name',
    serves(out, 'iso-alpha'));
  check('🔴 UNION: ...including its payload bytes', fs.existsSync(path.join(out, alphaUrl)), alphaUrl);
  check('union: the build\'s own name is served too', serves(out, 'iso-common'));

  /* RED CONTROL: the destruction, on demand, via --prune. Same dir, same defs
   * — only the flag differs, so the union legs above are proven against a
   * tool whose prune instrument demonstrably still fires. */
  const c = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`, '--prune']);
  check('prune: the --prune build succeeds', c.status === 0, c.stderr);
  check('RED CONTROL (--prune): drops the carried name',
    !readIndex(out).packages['iso-alpha']);
  check('RED CONTROL (--prune): ...and DELETES its payload bytes',
    !fs.existsSync(path.join(out, alphaUrl)), alphaUrl);
  check('prune: the build\'s own name survives the prune', serves(out, 'iso-common'));
}

/* ---- SERVABLE: a carried entry with missing payload bytes refuses ---- */
{
  const out = path.join(tmp, 'missing-payload');
  mkpkg([`--out=${out}`, `--packages-dir=${DEFS_BOTH}`]);
  const alphaUrl = readIndex(out).packages['iso-alpha'].payload.url;
  fs.unlinkSync(path.join(out, alphaUrl));
  const r = mkpkg([`--out=${out}`, `--packages-dir=${DEFS_ONE}`]);
  check('servable: carrying an entry whose bytes are gone refuses (exit 1)',
    r.status === 1, `status=${r.status}`);
  check('servable: ...naming the entry and the --prune fix',
    /iso-alpha/.test(String(r.stderr)) && /--prune/.test(String(r.stderr)),
    String(r.stderr).slice(0, 300));
  check('servable: the refused run left the previous index in place (no partial write)',
    !!readIndex(out).packages['iso-alpha']);
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

/* ---- an append-only store keeps several shas per version, and still reuses ----
 * The superseded-drop is off for a shared store, so one (name, version) legally
 * accumulates payloads as its inputs change. Reuse must pick the newest rather
 * than give up — a naive "exactly one candidate" rule would silently rebuild
 * the world on every run once a second sha appeared. */
{
  const pool = path.join(tmp, 'pool-multi');
  const out = path.join(tmp, 'repo-multi');
  const defs = defsDir('multi', ['iso-common']);
  const defFile = path.join(defs, 'iso-common.json');
  const args = [`--out=${out}`, `--pool=${pool}`, `--packages-dir=${defs}`];

  mkpkg(args);
  const first = readIndex(out).packages['iso-common'].payload.url;

  // Same VERSION, different content -> a different sha, a second pool payload.
  const def = JSON.parse(fs.readFileSync(defFile, 'utf-8'));
  def.files.tool.content = '#!/bin/sh\necho iso-common v2\n';
  fs.writeFileSync(defFile, JSON.stringify(def, null, 2) + '\n');
  mkpkg(args);
  const second = readIndex(out).packages['iso-common'].payload.url;
  const pooled = fs.readdirSync(pool).filter((f) => f.startsWith('iso-common_1.0_'));
  check('a shared store keeps BOTH shas of one version (append-only)',
    pooled.length === 2, pooled.join(' '));
  check('the index advertises the NEW payload after the content change',
    second !== first, `${first} -> ${second}`);
  check('...and the new payload is readable', serves(out, 'iso-common'));

  // Inputs unchanged -> must REUSE the newest, not add a third payload.
  mkpkg(args);
  check('an unchanged rebuild REUSES the newest payload (no third sha)',
    fs.readdirSync(pool).filter((f) => f.startsWith('iso-common_1.0_')).length === 2 &&
    readIndex(out).packages['iso-common'].payload.url === second,
    fs.readdirSync(pool).join(' '));
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
