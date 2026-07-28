#!/usr/bin/env node
// todos/idspace.test.js — the freshness half of the cross-ref id allocator
// (todos/0360). Zero-dependency; run with:  node todos/idspace.test.js
//
// todos/queue.test.js covers the SURVEY (which ids exist, across which refs)
// through the CLI. This file covers the question 0358 only disclaimed and 0360
// measures: HOW STALE is what the survey just read?
//
// Every case builds real git repos in a temp dir — a bare `origin`, one or two
// clones, sometimes a linked worktree — so the probe runs against a real remote
// over a local path: authoritative, offline, and fast. No mocking of git.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const IDSPACE = require('./idspace.js');

let passed = 0;
const roots = [];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function writeTicket(wt, id) {
  fs.mkdirSync(path.join(wt, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'todos', `${id}-x.md`), `# ${id} — x\n\n- **Status**: open\n`);
}

function writeRegister(wt, ids) {
  fs.mkdirSync(path.join(wt, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'todos', 'LIABILITIES.md'),
    '<!-- BEGIN ENTRIES -->\n\n' +
    ids.map(n => `### L${String(n).padStart(2, '0')} — a gap\n- ticket: 0001\n`).join('\n') +
    '\n<!-- END ENTRIES -->\n');
}

function commit(wt, msg) {
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-q', '-m', msg]);
}

// A bare origin + one clone of it that has pushed a base commit carrying
// todos/<ids>. Returns { origin, lane }.
function setupClone(ids = ['0001']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idspace-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  git(root, ['init', '-q', '--bare', origin]);
  const lane = path.join(root, 'lane');
  git(root, ['clone', '-q', origin, lane]);
  git(lane, ['config', 'user.email', 't@t']);
  git(lane, ['config', 'user.name', 't']);
  for (const id of ids) writeTicket(lane, id);
  commit(lane, 'base');
  git(lane, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main']);
  return { root, origin, lane };
}

// Another clone pushes a branch. The lane's remote-tracking refs now LAG the
// remote and no local signal says so — this is the state todos/0360 is about.
function pushFromElsewhere(root, origin, branch, ticketId) {
  const other = path.join(root, `other-${branch}`);
  git(root, ['clone', '-q', origin, other]);
  git(other, ['config', 'user.email', 'o@o']);
  git(other, ['config', 'user.name', 'o']);
  if (ticketId) writeTicket(other, ticketId);
  else fs.writeFileSync(path.join(other, 'noise.txt'), branch);
  commit(other, `from ${branch}`);
  git(other, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  return other;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`);
    process.exitCode = 1;
  }
}

// ---------- the probe: proof of staleness ----------

test('RED: a remote-tracking ref set the remote contradicts reads STALE, and a fetch clears it', () => {
  const { root, origin, lane } = setupClone();
  // Green first, so the assertion below cannot pass for the trivial reason that
  // everything reads stale.
  let f = IDSPACE.freshness(lane, { noCache: true });
  assert.strictEqual(f.level, 'ok', `a just-cloned lane must read fresh: ${f.line}`);

  pushFromElsewhere(root, origin, 'lane-b', '0009');

  f = IDSPACE.freshness(lane, { noCache: true });
  assert.strictEqual(f.level, 'stale', `the lane has not fetched lane-b: ${f.line}`);
  assert.match(f.line, /STALE/);
  assert.match(f.line, /refs\/heads\/lane-b/, `the line must NAME the ref it is missing: ${f.line}`);
  assert.match(f.line, /git fetch/, 'the line must name the fix');

  // ...and the allocation carries the verdict, so a caller does not have to ask.
  const a = IDSPACE.allocate('ticket', ['0001'], { root: lane, noCache: true });
  assert.strictEqual(a.stale, true, 'allocate() must surface the verdict');
  assert.strictEqual(a.id, '0002', 'the stale bound is still returned — the CALLER decides policy');

  git(lane, ['fetch', '-q', 'origin']);
  f = IDSPACE.freshness(lane, { noCache: true });
  assert.strictEqual(f.level, 'ok', `after the fetch it must be current again: ${f.line}`);
  const b = IDSPACE.allocate('ticket', ['0001'], { root: lane, noCache: true });
  assert.strictEqual(b.stale, false);
  assert.strictEqual(b.id, '0010', `the fetched ref carries 0009: ${b.note}`);
});

test('--offline skips the probe entirely and says so, rather than reporting fresh', () => {
  const { root, origin, lane } = setupClone();
  pushFromElsewhere(root, origin, 'lane-b', '0009');

  const f = IDSPACE.freshness(lane, { offline: true, noCache: true });
  assert.strictEqual(f.probe.status, 'skipped');
  assert.notStrictEqual(f.level, 'stale', 'no probe ran, so nothing was PROVEN — refuse on proof only');
  assert.match(f.line, /SKIPPED \(--offline\)/, f.line);
  // The one thing --offline must never do is claim currency it did not check.
  assert.doesNotMatch(f.line, /would move nothing/, f.line);
});

test('a probe that cannot reach the remote degrades LOUDLY, and still allocates', () => {
  const { lane } = setupClone();
  git(lane, ['remote', 'set-url', 'origin', path.join(lane, 'no-such-repo.git')]);

  const f = IDSPACE.freshness(lane, { noCache: true });
  assert.strictEqual(f.probe.status, 'failed');
  assert.strictEqual(f.level, 'warn', 'unreachable is doubt, not proof');
  assert.match(f.line, /PROBE FAILED/, f.line);
  assert.match(f.line, /CANNOT be shown current/, `the degrade must not read like a pass: ${f.line}`);

  const a = IDSPACE.allocate('ticket', ['0001'], { root: lane, noCache: true });
  assert.strictEqual(a.stale, false, 'a network failure must not block allocation');
  assert.strictEqual(a.id, '0002');
});

test('the probe is bounded by a timeout, and the timeout reads as a failure not a pass', () => {
  // A remote that never answers, via git's ext:: transport. Without the bound
  // this case hangs forever — which is the failure mode 0360 explicitly refused
  // to trade the disclaimer for.
  const { lane } = setupClone();
  const helper = path.join(lane, 'hang.sh');
  fs.writeFileSync(helper, '#!/bin/sh\nsleep 3\n');
  fs.chmodSync(helper, 0o755);
  git(lane, ['config', 'protocol.ext.allow', 'always']);
  git(lane, ['remote', 'set-url', 'origin', `ext::${helper}`]);

  const t0 = Date.now();
  const f = IDSPACE.freshness(lane, { probeTimeoutMs: 400, noCache: true });
  const ms = Date.now() - t0;
  assert.strictEqual(f.probe.status, 'failed', `expected a timeout, got ${JSON.stringify(f.probe)}`);
  assert.match(f.probe.reason, /no answer within 400ms/, f.probe.reason);
  assert.ok(ms < 3000, `the probe must return on its own clock, took ${ms}ms`);
  assert.strictEqual(f.level, 'warn');
});

// ---------- the local clock: what --offline has left ----------

test('offline, a clone that has never fetched says so instead of reading fresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idspace-nofetch-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  git(root, ['remote', 'add', 'origin', path.join(root, 'nowhere.git')]);
  writeTicket(root, '0001');
  commit(root, 'base');

  const f = IDSPACE.freshness(root, { offline: true, noCache: true });
  assert.strictEqual(f.refreshedAt, null);
  assert.strictEqual(f.level, 'warn');
  assert.match(f.line, /NEVER fetched/, f.line);
});

test('offline, a stale FETCH_HEAD is reported by age — and a fresh one is not nagged about', () => {
  const { lane } = setupClone();
  git(lane, ['fetch', '-q', 'origin']);
  const fetchHead = path.join(lane, '.git', 'FETCH_HEAD');
  assert.ok(fs.existsSync(fetchHead), 'the fetch must have written FETCH_HEAD');

  let f = IDSPACE.freshness(lane, { offline: true, noCache: true });
  assert.strictEqual(f.level, 'ok', `a fetch seconds ago is not stale: ${f.line}`);

  // Age both signals: FETCH_HEAD and the reflogs the fetch touched, since
  // lastRefresh() maxes over all of them.
  const old = (Date.now() - 6 * 60 * 60 * 1000) / 1000;
  const age = (p) => { try { fs.utimesSync(p, old, old); } catch { /* absent */ } };
  age(fetchHead);
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else age(p);
    }
  })(path.join(lane, '.git', 'logs', 'refs', 'remotes'));

  f = IDSPACE.freshness(lane, { offline: true, noCache: true });
  assert.strictEqual(f.level, 'warn', `6h without a fetch must warn offline: ${f.line}`);
  assert.match(f.line, /last refreshed 6h ago/, f.line);
  assert.match(f.line, /lower bound/, f.line);
});

test('a fetch made from ANOTHER worktree counts — FETCH_HEAD is per-worktree', () => {
  // The false-alarm trap: FETCH_HEAD lives in the worktree's private git dir
  // while the remote-tracking refs it updates are shared, so reading only this
  // worktree's copy reports "never fetched" in every fresh worktree.
  const { lane } = setupClone();
  git(lane, ['fetch', '-q', 'origin']);
  const wt = path.join(path.dirname(lane), 'wt');
  git(lane, ['worktree', 'add', '-q', '-b', 'side', wt]);
  assert.ok(!fs.existsSync(path.join(lane, '.git', 'worktrees', 'wt', 'FETCH_HEAD')),
    'the linked worktree must have no FETCH_HEAD of its own — otherwise this case proves nothing');

  const f = IDSPACE.freshness(wt, { offline: true, noCache: true });
  assert.notStrictEqual(f.refreshedAt, null, `the sibling's fetch must count: ${f.line}`);
  assert.strictEqual(f.level, 'ok', f.line);
});

test('offline, committing since the last fetch is itself reported', () => {
  const { lane } = setupClone();
  git(lane, ['fetch', '-q', 'origin']);
  const old = (Date.now() - 10 * 60 * 1000) / 1000;   // inside the age threshold
  fs.utimesSync(path.join(lane, '.git', 'FETCH_HEAD'), old, old);
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else fs.utimesSync(p, old, old);
    }
  })(path.join(lane, '.git', 'logs', 'refs', 'remotes'));

  writeTicket(lane, '0002');
  commit(lane, 'my own work');

  const f = IDSPACE.freshness(lane, { offline: true, noCache: true });
  assert.strictEqual(f.workedSince, true);
  assert.strictEqual(f.level, 'warn', `worked since the last look: ${f.line}`);
  assert.match(f.line, /COMMITTED since then/, f.line);
});

// ---------- ids on no ref at all ----------

test('RED: an id in a SIBLING WORKTREE\'s uncommitted tree is taken — the L47 incident', () => {
  // 2026-07-28, literally: the main tree was mid-merge with L47/L48 written in
  // an UNCOMMITTED register while a worktree allocated L47 off the refs. Both
  // were correct. Neither could see the other.
  const { lane } = setupClone();
  writeRegister(lane, [46]);
  commit(lane, 'register at L46');
  const merging = path.join(path.dirname(lane), 'merging');
  git(lane, ['worktree', 'add', '-q', '-b', 'merge-lane', merging]);
  writeRegister(merging, [46, 47]);            // uncommitted, on no ref anywhere

  const a = IDSPACE.allocate('liability', [46], { root: lane, offline: true, noCache: true });
  assert.strictEqual(a.id, 'L48', `L47 is held in ${merging} (note: ${a.note})`);
  assert.match(a.from, /merging \(uncommitted\)$/, `the allocation must SAY where L47 lives: ${a.from}`);
  assert.ok(a.worktrees >= 1, 'the sibling worktree must be counted in the survey');
  assert.match(a.note, /sibling worktree\(s\)/, a.note);
});

test('a sibling worktree\'s uncommitted TICKET file is taken too', () => {
  const { lane } = setupClone();
  const wt = path.join(path.dirname(lane), 'wt');
  git(lane, ['worktree', 'add', '-q', '-b', 'side', wt]);
  writeTicket(wt, '0009');                      // uncommitted

  const a = IDSPACE.allocate('ticket', ['0001'], { root: lane, offline: true, noCache: true });
  assert.strictEqual(a.id, '0010', a.note);
  assert.match(a.from, /wt \(uncommitted\)$/, a.from);
});

test('a COMMITTED id keeps its ref label — the worktree scan does not shadow the refs', () => {
  const { lane } = setupClone();
  const wt = path.join(path.dirname(lane), 'wt');
  git(lane, ['worktree', 'add', '-q', '-b', 'side', wt]);
  writeTicket(wt, '0009');
  git(wt, ['config', 'user.email', 't@t']);
  git(wt, ['config', 'user.name', 't']);
  commit(wt, 'side work');

  const a = IDSPACE.allocate('ticket', ['0001'], { root: lane, offline: true, noCache: true });
  assert.strictEqual(a.id, '0010');
  assert.strictEqual(a.from, 'refs/heads/side', `refs are surveyed first: ${a.from}`);
});

test('a pruned worktree entry is skipped rather than throwing', () => {
  const { lane } = setupClone();
  const wt = path.join(path.dirname(lane), 'gone');
  git(lane, ['worktree', 'add', '-q', '-b', 'side', wt]);
  writeTicket(wt, '0009');
  fs.rmSync(wt, { recursive: true, force: true });   // administratively removed, not pruned

  const a = IDSPACE.allocate('ticket', ['0001'], { root: lane, offline: true, noCache: true });
  assert.strictEqual(a.id, '0002', `0009 vanished with its worktree: ${a.note}`);
});

// ---------- the no-remote and cache cases ----------

test('a repo with no remote is not "stale" — there is nothing to be stale about', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idspace-noremote-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  writeTicket(root, '0001');
  commit(root, 'base');

  const f = IDSPACE.freshness(root, { noCache: true });
  assert.strictEqual(f.probe.status, 'none');
  assert.strictEqual(f.level, 'ok');
  assert.match(f.line, /no remote is configured/, f.line);
});

test('the verdict is computed ONCE per process: next-id allocates twice, probes once', () => {
  const { lane } = setupClone();
  const a = IDSPACE.freshness(lane, {});
  const b = IDSPACE.freshness(lane, {});
  assert.strictEqual(a, b, 'the second allocation must reuse the first verdict, not re-probe');
});

process.on('exit', () => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.stdout.write(`\nidspace.test.js: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
});
