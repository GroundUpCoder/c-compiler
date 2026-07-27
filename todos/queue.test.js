#!/usr/bin/env node
// todos/queue.test.js — self-contained tests for the queue.js manifest CLI.
// Zero-dependency; run with:  node todos/queue.test.js
//
// Each case builds a throwaway todos/ tree in a temp dir, copies queue.js into
// it (the CLI resolves paths from __dirname, so a copy retargets it cleanly),
// and drives it as a real subprocess — exercising the actual validator + writer.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const REAL_QUEUE_JS = path.join(__dirname, 'queue.js');
let passed = 0;
let root;

function setup(queue) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cli-'));
  const todos = path.join(root, 'todos');
  fs.mkdirSync(path.join(todos, 'done'), { recursive: true });
  // A git repo so `queue.js done` can `git mv`.
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fs.copyFileSync(REAL_QUEUE_JS, path.join(todos, 'queue.js'));
  // queue.js validates the liability register alongside the manifest, so its
  // module has to be here too. These temp trees carry no LIABILITIES.md, which
  // is the not-applicable case — todos/liabilities.test.js is where the
  // register's own behaviour (including a missing one) is tested.
  fs.copyFileSync(path.join(__dirname, 'liabilities.js'), path.join(todos, 'liabilities.js'));
  // The cross-ref id allocator (todos/0358) — `add next` goes through it.
  fs.copyFileSync(path.join(__dirname, 'idspace.js'), path.join(todos, 'idspace.js'));
  return todos;
}

// git inside a temp tree, for the two-lane allocation cases below.
function git(todos, args) {
  return execFileSync('git', args, { cwd: path.dirname(todos), encoding: 'utf8' }).trim();
}

function commit(todos, msg) {
  git(todos, ['add', '-A']);
  git(todos, ['commit', '-q', '-m', msg]);
  return git(todos, ['rev-parse', 'HEAD']);
}

function writeItem(todos, id, slug, opts = {}) {
  const dir = opts.done ? path.join(todos, 'done') : todos;
  // Note: no `- **Depends**:` line — deps live only in queue.json, and the
  // check lint rejects the structured line in open items.
  const extra = opts.extraHeader ? `${opts.extraHeader}\n` : '';
  fs.writeFileSync(path.join(dir, `${id}-${slug}.md`),
    `# ${id} — ${slug}\n\n- **Status**: ${opts.status || 'open'}\n${extra}\n## Goal\n`);
}

function writeManifest(todos, queue) {
  fs.writeFileSync(path.join(todos, 'queue.json'),
    JSON.stringify({ version: 1, queue }, null, 2) + '\n');
}

// Run queue.js in the temp repo; returns {code, stdout, stderr}.
function run(todos, args) {
  try {
    const stdout = execFileSync('node', [path.join(todos, 'queue.js'), ...args],
      { cwd: path.dirname(todos), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

function readManifest(todos) {
  return JSON.parse(fs.readFileSync(path.join(todos, 'queue.json'), 'utf8'));
}

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n      ${e.message}\n`);
    process.exit(1);
  } finally {
    if (root) { fs.rmSync(root, { recursive: true, force: true }); root = null; }
  }
}

// --- check: happy path + the four core invariants ---

test('check passes on a consistent tree', () => {
  const todos = setup([{ id: '0001' }, { id: '0002', blockedBy: ['0001'] }]);
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001' }, { id: '0002', blockedBy: ['0001'] }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /check OK/);
});

test('check fails when an open file is unlisted, and --fix appends it', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001' }]); // 0002 missing
  let r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /0002.*not listed/s);
  r = run(todos, ['check', '--fix']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001', '0002']);
});

// --- Status-line drift (todos/0353) ---
// Nothing used to read the `- **Status**:` line except the `deferred` test
// below, so it drifted both ways: 35 closed tickets still said "open", and one
// open ticket at rank 1 advertised a round its own body recorded as landed.

test('check fails on a done/ ticket whose Status line still says open', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'shipped', { done: true, status: 'open (P1)' });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /done\/0002-shipped\.md is closed but its Status line still reads "open \(P1\)"/);
});

test('check tolerates non-"open" Status lines in done/', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  // "reopened" and a line merely MENTIONING open must not trip the leading-
  // token test — a checker that guesses is worse than no checker.
  writeItem(todos, '0002', 'b', { done: true, status: 'done' });
  writeItem(todos, '0003', 'c', { done: true, status: 'reopened 2026-01-01, then done' });
  writeItem(todos, '0004', 'd', { done: true, status: 'closed — was open until 2026-01-01' });
  writeManifest(todos, [{ id: '0001' }]);
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('check --fix rewrites a closed ticket\'s open Status line, keeping the tail', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'shipped', { done: true, status: 'open (user-requested 2026-07-21)' });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check', '--fix']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /rewrote "open" -> "done" on 1 closed ticket/);
  assert.match(r.stdout, /todos\/done\/0002-shipped\.md/);
  const body = fs.readFileSync(path.join(todos, 'done', '0002-shipped.md'), 'utf8');
  // The parenthetical is the author's text, not the fixer's to edit.
  assert.match(body, /^- \*\*Status\*\*: done \(user-requested 2026-07-21\)$/m);
  assert.strictEqual(run(todos, ['check']).code, 0, 'green after --fix');
});

test('check fails when an open Status line claims a round the body records DONE', () => {
  const todos = setup();
  // The 0117 shape verbatim: line 3 said R2 was remaining while §R2 said DONE.
  writeItem(todos, '0001', 'a', {
    status: 'open — R1 landed; R2 is the remaining work',
    extraHeader: '\n## R1 — LANDED 2026-07-27\n\n## R2 — DONE 2026-07-28\n',
  });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /Status line says "R2 is the remaining work".*R2 — DONE\/LANDED.*not auto-fixable/s);
  // Judgement call which side is stale, so --fix must NOT silently pick one.
  const r2 = run(todos, ['check', '--fix']);
  assert.strictEqual(r2.code, 1, 'the contradiction is deliberately not auto-fixed');
});

test('check does not read a remaining-clause as belonging to another round', () => {
  const todos = setup();
  // "R1 done, R2 remaining" must not read as "R1 remaining" — the remaining
  // word has to sit in the SAME clause as the round it is claimed of.
  writeItem(todos, '0001', 'a', {
    status: 'open — R1 done, R2 remaining',
    extraHeader: '\n## R1 — DONE 2026-07-27\n',
  });
  // A body heading with no matching claim on the line is likewise fine.
  writeItem(todos, '0002', 'b', {
    status: 'open — **R1 LANDED 2026-07-27; R2 LANDED 2026-07-28**',
    extraHeader: '\n## R1 — LANDED 2026-07-27\n\n## R2 — DONE 2026-07-28\n',
  });
  writeManifest(todos, [{ id: '0001' }, { id: '0002' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 0, r.stderr);
});

test('the "un-deferred" footgun: still classified deferred, and now rejected', () => {
  // statusOf() substring-tests the FIRST Status line for "deferred", so a
  // NEGATED deferral silently re-defers the ticket (documented in 0126). That
  // classification is load-bearing for every other line and is left exactly as
  // it was — pinned here — while check rejects the ambiguous phrasing so the
  // trap can no longer be sprung silently.
  const todos = setup();
  writeItem(todos, '0001', 'a', { status: 'un-deferred 2026-07-28 — ready to go' });
  writeManifest(todos, [{ id: '0001' }]);
  const list = run(todos, ['list']);
  assert.strictEqual(list.code, 0, list.stderr);
  assert.match(list.stdout, /0001\s+deferred/, 'unchanged: "un-deferred" still reads as deferred');
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /still classifies the item as DEFERRED/);

  // The plain word keeps working, both ways.
  writeItem(todos, '0001', 'a', { status: 'deferred — waiting on 0099' });
  assert.match(run(todos, ['list']).stdout, /0001\s+deferred/);
  assert.strictEqual(run(todos, ['check']).code, 0);
  writeItem(todos, '0001', 'a', { status: 'open' });
  assert.match(run(todos, ['list']).stdout, /0001\s+ready/);
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('check flags a queued id whose file is missing', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }, { id: '0009' }]); // 0009 has no file
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /0009.*no todos/s);
});

test('check flags a dep on a nonexistent todo and a self-cycle', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001', blockedBy: ['0099'] }]);
  assert.match(run(todos, ['check']).stderr, /blockedBy "0099" — no such todo/);

  writeManifest(todos, [{ id: '0001', blockedBy: ['0001'] }]);
  assert.match(run(todos, ['check']).stderr, /references itself/);
});

test('check detects a dependency cycle', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001', blockedBy: ['0002'] }, { id: '0002', blockedBy: ['0001'] }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /cycle in blockedBy/);
});

test('check rejects a structured Depends: line in an open item (done/ exempt)', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a', { extraHeader: '- **Depends**: 0002 (rationale)' });
  writeItem(todos, '0002', 'b', { done: true, status: 'done', extraHeader: '- **Depends**: —' });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /0001-a\.md carries a structured Depends: line/);
  assert.doesNotMatch(r.stderr, /0002-b\.md/); // frozen history is exempt
});

test('check rejects a malformed manifest loudly', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  fs.writeFileSync(path.join(todos, 'queue.json'), '{ not json');
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
});

// --- add ---

test('add next scaffolds a file and appends to the queue', () => {
  const todos = setup([]);
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['add', 'next', '--slug', 'shiny-thing']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(todos, '0002-shiny-thing.md')), 'scaffold file exists');
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001', '0002']);
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('add honors --pos and --blocked-by', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['add', '0005', '--slug', 'mid', '--pos', '1', '--blocked-by', '0001']);
  assert.strictEqual(r.code, 0, r.stderr);
  const q = readManifest(todos).queue;
  assert.deepStrictEqual(q.map(e => e.id), ['0005', '0001']);
  assert.deepStrictEqual(q[0].blockedBy, ['0001']);
});

test('add rolls back the scaffold when the result would not validate', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['add', '0007', '--slug', 'bad', '--blocked-by', '9999']);
  assert.strictEqual(r.code, 1);
  assert.ok(!fs.existsSync(path.join(todos, '0007-bad.md')), 'scaffold rolled back');
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001']); // unchanged
});

test('add --difficulty-triage scaffolds a curation item at pos 1', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['add', 'next', '--difficulty-triage', '--pos', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  const file = path.join(todos, '0002-difficulty-triage.md');
  assert.ok(fs.existsSync(file), 'triage scaffold exists');
  assert.match(fs.readFileSync(file, 'utf8'), /set-difficulty/);
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0002', '0001']); // front
  assert.strictEqual(run(todos, ['check']).code, 0);
});

// --- priority (P0..P3, default P1 with the field omitted) ---

test('add --priority sets the field; P1 and absent are omitted', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  let r = run(todos, ['add', '0002', '--slug', 'urgent', '--priority', '0']);
  assert.strictEqual(r.code, 0, r.stderr);
  r = run(todos, ['add', '0003', '--slug', 'normal', '--priority', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  const q = readManifest(todos).queue;
  assert.strictEqual(q.find(e => e.id === '0002').priority, 0);
  assert.ok(!('priority' in q.find(e => e.id === '0003')), 'P1 omits the field');
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('add rejects an invalid --priority loudly, writing nothing', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  for (const bad of ['4', '-1', 'x', '1.5']) {
    const r = run(todos, ['add', '0002', '--slug', 'nope', '--priority', bad]);
    assert.strictEqual(r.code, 1, `--priority ${bad} must fail`);
    assert.match(r.stderr, /priority must be an integer 0\.\.3/);
  }
  assert.ok(!fs.existsSync(path.join(todos, '0002-nope.md')), 'no scaffold written');
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001']); // unchanged
});

test('set-priority sets, clears at 1, and errors on unknown id / bad value', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  assert.strictEqual(run(todos, ['set-priority', '0001', '3']).code, 0);
  assert.strictEqual(readManifest(todos).queue[0].priority, 3);
  assert.strictEqual(run(todos, ['set-priority', '0001', '1']).code, 0); // back to default
  assert.ok(!('priority' in readManifest(todos).queue[0]), 'P1 removes the field');
  let r = run(todos, ['set-priority', '0009', '0']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /"0009" is not in the queue/);
  r = run(todos, ['set-priority', '0001', '7']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /priority must be an integer 0\.\.3/);
  assert.ok(!('priority' in readManifest(todos).queue[0]), 'failed set writes nothing');
});

test('list shows the EFFECTIVE order (priority buckets, array order within)', () => {
  const todos = setup();
  ['0001', '0002', '0003', '0004'].forEach(id => writeItem(todos, id, id));
  // Array order 1,2,3,4; priorities P2,P1(absent),P0,P1(absent).
  writeManifest(todos, [
    { id: '0001', priority: 2 }, { id: '0002' }, { id: '0003', priority: 0 }, { id: '0004' },
  ]);
  const r = run(todos, ['list']);
  assert.strictEqual(r.code, 0, r.stderr);
  const ids = [...r.stdout.matchAll(/\b(\d{4})\b/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, ['0003', '0002', '0004', '0001'], 'P0 first, P1s in array order, P2 last');
  assert.match(r.stdout, /0003  P0  ready/);
  assert.match(r.stdout, /0001  P2  ready/);
  assert.match(r.stdout, /0002  ready/); // default P1: no marker
  // The file's array order is NOT rewritten by the read-time sort.
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001', '0002', '0003', '0004']);
});

test('check validates the priority field (integer 0..3 only)', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001', priority: 2 }]);
  assert.strictEqual(run(todos, ['check']).code, 0, 'priority 2 is valid');
  for (const bad of [4, -1, '2', 1.5]) {
    writeManifest(todos, [{ id: '0001', priority: bad }]);
    const r = run(todos, ['check']);
    assert.strictEqual(r.code, 1, `priority ${JSON.stringify(bad)} must fail`);
    assert.match(r.stderr, /"priority" for "0001" must be an integer 0\.\.3/);
  }
});

// --- difficulty (light/medium/heavy, optional; absent = untagged) ---

test('add --difficulty sets the field; absent is omitted', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  let r = run(todos, ['add', '0002', '--slug', 'big', '--difficulty', 'heavy']);
  assert.strictEqual(r.code, 0, r.stderr);
  r = run(todos, ['add', '0003', '--slug', 'small']); // no flag → untagged
  assert.strictEqual(r.code, 0, r.stderr);
  const q = readManifest(todos).queue;
  assert.strictEqual(q.find(e => e.id === '0002').difficulty, 'heavy');
  assert.ok(!('difficulty' in q.find(e => e.id === '0003')), 'untagged omits the field');
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('add rejects an invalid --difficulty loudly, writing nothing', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  for (const bad of ['hard', 'xl', 'tiny']) {
    const r = run(todos, ['add', '0002', '--slug', 'nope', '--difficulty', bad]);
    assert.strictEqual(r.code, 1, `--difficulty ${bad} must fail`);
    assert.match(r.stderr, /difficulty must be one of light\/medium\/heavy/);
  }
  assert.ok(!fs.existsSync(path.join(todos, '0002-nope.md')), 'no scaffold written');
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0001']); // unchanged
});

test('--difficulty normalizes case/whitespace (the manifest is always lowercase)', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  assert.strictEqual(run(todos, ['add', '0002', '--slug', 'ok', '--difficulty', 'Heavy']).code, 0);
  assert.strictEqual(readManifest(todos).queue.find(e => e.id === '0002').difficulty, 'heavy');
  assert.strictEqual(run(todos, ['set-difficulty', '0001', '  LIGHT ']).code, 0);
  assert.strictEqual(readManifest(todos).queue[0].difficulty, 'light');
});

test('set-difficulty sets, clears with none, and errors on unknown id / bad value', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  assert.strictEqual(run(todos, ['set-difficulty', '0001', 'medium']).code, 0);
  assert.strictEqual(readManifest(todos).queue[0].difficulty, 'medium');
  assert.strictEqual(run(todos, ['set-difficulty', '0001', 'none']).code, 0); // clear
  assert.ok(!('difficulty' in readManifest(todos).queue[0]), 'none removes the field');
  let r = run(todos, ['set-difficulty', '0009', 'light']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /"0009" is not in the queue/);
  run(todos, ['set-difficulty', '0001', 'heavy']);
  r = run(todos, ['set-difficulty', '0001', 'bogus']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /difficulty must be one of light\/medium\/heavy/);
  assert.strictEqual(readManifest(todos).queue[0].difficulty, 'heavy', 'failed set writes nothing');
});

test('list shows the difficulty marker; untagged stays unmarked', () => {
  const todos = setup();
  ['0001', '0002'].forEach(id => writeItem(todos, id, id));
  writeManifest(todos, [{ id: '0001', difficulty: 'heavy' }, { id: '0002' }]);
  const r = run(todos, ['list']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /0001  \[heavy\]  ready/);
  assert.match(r.stdout, /0002  ready/); // untagged: no marker
});

test('check validates the difficulty field (known tags only)', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001', difficulty: 'light' }]);
  assert.strictEqual(run(todos, ['check']).code, 0, 'light is valid');
  for (const bad of ['hard', 3, '', 'HEAVY']) {
    writeManifest(todos, [{ id: '0001', difficulty: bad }]);
    const r = run(todos, ['check']);
    assert.strictEqual(r.code, 1, `difficulty ${JSON.stringify(bad)} must fail`);
    assert.match(r.stderr, /"difficulty" for "0001" must be one of light\/medium\/heavy/);
  }
});

// --- reorder / block / done ---

test('reorder --before moves an item', () => {
  const todos = setup();
  ['0001', '0002', '0003'].forEach(id => writeItem(todos, id, id));
  writeManifest(todos, [{ id: '0001' }, { id: '0002' }, { id: '0003' }]);
  const r = run(todos, ['reorder', '0003', '--before', '0001']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0003', '0001', '0002']);
});

test('block sets and clears hard/soft deps', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001' }, { id: '0002' }]);
  assert.strictEqual(run(todos, ['block', '0002', '--hard', '0001', '--soft', '0001']).code, 0);
  let e = readManifest(todos).queue.find(x => x.id === '0002');
  assert.deepStrictEqual(e.blockedBy, ['0001']);
  assert.deepStrictEqual(e.after, ['0001']);
  assert.strictEqual(run(todos, ['block', '0002', '--hard', '']).code, 0); // clear hard
  e = readManifest(todos).queue.find(x => x.id === '0002');
  assert.strictEqual(e.blockedBy, undefined);
  assert.deepStrictEqual(e.after, ['0001']);
});

test('done git-mvs the file and drops it from the queue', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001' }, { id: '0002' }]);
  execFileSync('git', ['add', '-A'], { cwd: path.dirname(todos) });
  const r = run(todos, ['done', '0001']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(todos, '0001-a.md')), 'moved out of open');
  assert.ok(fs.existsSync(path.join(todos, 'done', '0001-a.md')), 'moved into done/');
  assert.deepStrictEqual(readManifest(todos).queue.map(e => e.id), ['0002']);
  assert.strictEqual(run(todos, ['check']).code, 0);
});

test('done rewrites the closed ticket\'s Status line and re-stages it', () => {
  // Otherwise every close would manufacture the drift 0353 exists to stop —
  // and `git mv` would have staged the pre-rewrite blob.
  const todos = setup();
  writeItem(todos, '0001', 'a', { status: 'open (P2) — one round left' });
  writeManifest(todos, [{ id: '0001' }]);
  execFileSync('git', ['add', '-A'], { cwd: path.dirname(todos) });
  const r = run(todos, ['done', '0001']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Status line: open → done/);
  assert.match(fs.readFileSync(path.join(todos, 'done', '0001-a.md'), 'utf8'),
    /^- \*\*Status\*\*: done \(P2\) — one round left$/m);
  const staged = execFileSync('git', ['show', ':todos/done/0001-a.md'],
    { cwd: path.dirname(todos), encoding: 'utf8' });
  assert.match(staged, /Status\*\*: done/, 'the rewrite is in the index, not just the worktree');
});

// --- usage: --help, unknown flags, EPIPE (todos/0099) ---

test('--help prints usage and exits 0 on every command, writing nothing', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const before = fs.readFileSync(path.join(todos, 'queue.json'), 'utf8');
  for (const args of [[], ['-h'], ['--help'], ['add', '--help'], ['add', 'next', '-h'],
                      ['list', '--help'], ['done', '--help'], ['check', '-h']]) {
    const r = run(todos, args);
    assert.strictEqual(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /ordering-manifest CLI/, `${args.join(' ')} prints usage`);
  }
  assert.strictEqual(fs.readFileSync(path.join(todos, 'queue.json'), 'utf8'), before, 'manifest untouched');
  assert.deepStrictEqual(fs.readdirSync(todos).filter(f => /^\d{4}-/.test(f)),
    ['0001-a.md'], 'no scaffold written');
});

test('an unknown --flag is a usage error (exit 2), writing nothing', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const before = fs.readFileSync(path.join(todos, 'queue.json'), 'utf8');
  for (const args of [['add', 'next', '--slug', 'x', '--bogus-flag'],
                      ['add', 'next', '--sug', 'typo'],
                      ['list', '--bogus'], ['check', '--fixx'],
                      ['reorder', '0001', '--befor', '0001'],
                      ['done', '0001', '--force'],
                      ['block', '0001', '--hrd', '0002'],
                      ['set-priority', '0001', '2', '--now']]) {
    const r = run(todos, args);
    assert.strictEqual(r.code, 2, `${args.join(' ')} must exit 2 (got ${r.code})`);
    assert.match(r.stderr, /unknown flag "--/, args.join(' '));
  }
  assert.strictEqual(fs.readFileSync(path.join(todos, 'queue.json'), 'utf8'), before, 'manifest untouched');
  assert.deepStrictEqual(fs.readdirSync(todos).filter(f => /^\d{4}-/.test(f)),
    ['0001-a.md'], 'no scaffold written, nothing moved');
});

test('list survives the consumer closing the pipe early (EPIPE)', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  // The output must overflow the OS pipe buffer (64KB) or every write lands
  // before `head` exits and EPIPE never fires. `list` doesn't validate, so a
  // big manifest without files (rows render "MISSING FILE") keeps this cheap.
  writeManifest(todos, [{ id: '0001' },
    ...Array.from({ length: 8000 }, (_, i) => ({ id: String(i + 2).padStart(4, '0') }))]);
  // stderr is captured OUTSIDE the pipeline — the pre-fix crash trace lands
  // there (piping it into head would truncate the trace and hide the bug).
  const r = spawnSync('sh', ['-c', `node ${path.join(todos, 'queue.js')} list | head -3`],
    { cwd: path.dirname(todos), encoding: 'utf8' });
  assert.strictEqual(r.stderr, '', 'no crash trace on early pipe close');
  assert.match(r.stdout, /Order of attack/, 'still printed the head of the list');
});

test('list reports ready / blocked / after state', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'b');
  writeManifest(todos, [{ id: '0001', after: ['0002'] }, { id: '0002', blockedBy: ['0001'] }]);
  const r = run(todos, ['list']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /0001\s+ready\s+\(after ▸ 0002\)/);
  assert.match(r.stdout, /0002\s+blocked ⛓ 0001/);
});

// --- cross-ref id allocation (todos/0358) ---
//
// The bug these pin: `add next` derived the next id from the WORKING TREE, so
// two lanes branching from a common base both saw the same maximum and both
// took the same id. 0354 was handed out twice that way, and the register's L44
// twice for the same reason. Against the pre-fix allocator the first case here
// returns 0002 for both lanes — that is the red.

test('RED: two lanes off a common base get DISTINCT ids', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const base = commit(todos, 'base');

  // Lane A branches, files 0002, commits — and does NOT push anywhere lane B
  // can see except as an ordinary ref, which is exactly the real situation.
  git(todos, ['checkout', '-q', '-b', 'lane-a']);
  let r = run(todos, ['add', 'next', '--slug', 'lane-a-item']);
  assert.strictEqual(r.code, 0, r.stderr);
  const idA = /added (\d{4})/.exec(r.stdout)[1];
  assert.strictEqual(idA, '0002', r.stdout);
  commit(todos, 'lane a');

  // Lane B branches from the SAME base. Its working tree knows only 0001.
  git(todos, ['checkout', '-q', '-B', 'lane-b', base]);
  assert.ok(!fs.existsSync(path.join(todos, `${idA}-lane-a-item.md`)),
    'lane B must not see lane A\'s file in its working tree — otherwise this case proves nothing');
  r = run(todos, ['add', 'next', '--slug', 'lane-b-item']);
  assert.strictEqual(r.code, 0, r.stderr);
  const idB = /added (\d{4})/.exec(r.stdout)[1];

  assert.notStrictEqual(idB, idA,
    `both lanes allocated ${idA} — this is the 0354 collision (stdout: ${r.stdout})`);
  assert.strictEqual(idB, '0003', r.stdout);
  // The derivation must be VISIBLE: a lane cannot tell a stale ref set from a
  // fresh one unless the tool says what it surveyed.
  assert.match(r.stdout, /derived across \d+ ref\(s\)/);
});

test('add next sees an id that exists ONLY on a remote-tracking ref', () => {
  // The origin/* half of the same bug: an id pushed by a lane that has since
  // been deleted locally still consumes its number.
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  const base = commit(todos, 'base');
  git(todos, ['checkout', '-q', '-b', 'tmp']);
  writeItem(todos, '0009', 'far-ahead');
  commit(todos, 'far ahead');
  // Re-file that commit as a remote-tracking ref, then drop the local branch.
  git(todos, ['update-ref', 'refs/remotes/origin/lane-x', 'HEAD']);
  git(todos, ['checkout', '-q', '-B', 'work', base]);
  git(todos, ['branch', '-q', '-D', 'tmp']);

  const r = run(todos, ['add', 'next', '--slug', 'mine']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /added 0010/, `must clear the remote-only 0009 (stdout: ${r.stdout})`);
  assert.match(r.stdout, /highest existing: 0009 on refs\/remotes\/origin\/lane-x/);
});

test('add next REFUSES when it cannot see any refs, and --local-ids opts out', () => {
  // todos/0358 item 4. Silently returning the working-tree bound is precisely
  // the pre-fix behaviour under a new name, so the allocator must say it is
  // blind rather than guess. A non-repo is the detectable case.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-norepo-'));
  const todos = path.join(root, 'todos');
  fs.mkdirSync(path.join(todos, 'done'), { recursive: true });
  for (const f of ['queue.js', 'liabilities.js', 'idspace.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(todos, f));
  }
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);

  let r = run(todos, ['add', 'next', '--slug', 'x']);
  assert.strictEqual(r.code, 1, `must refuse, got ${r.code}: ${r.stdout}`);
  assert.match(r.stderr, /Refusing to allocate a ticket id from the working tree alone/);
  assert.match(r.stderr, /--local/, 'the refusal must name the opt-out');
  assert.deepStrictEqual(fs.readdirSync(todos).filter(f => /^\d{4}-/.test(f)), ['0001-a.md'],
    'nothing scaffolded on refusal');

  // The deliberate opt-out proceeds — and labels the id as a lower bound.
  r = run(todos, ['add', 'next', '--slug', 'x', '--local-ids']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /WORKING TREE ONLY \(--local\)/);
  assert.match(r.stdout, /added 0002/);
});

test('next-id reports both id spaces without writing anything', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeManifest(todos, [{ id: '0001' }]);
  fs.writeFileSync(path.join(todos, 'LIABILITIES.md'),
    '<!-- BEGIN ENTRIES -->\n\n### L03 — a gap\n- ticket: 0001\n\n<!-- END ENTRIES -->\n');
  commit(todos, 'base');
  const before = fs.readdirSync(todos).sort();

  const r = run(todos, ['next-id']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /^0002\s/m, r.stdout);
  assert.match(r.stdout, /^L04\s/m, `the register's space must be allocated too: ${r.stdout}`);
  assert.deepStrictEqual(fs.readdirSync(todos).sort(), before, 'next-id writes nothing');
});

// --- one id, one file (todos/0358) ---

test('RED: two files sharing an id fail check instead of one vanishing', () => {
  // What the collision looks like AFTER it lands: the merge brings both lanes'
  // files in. Pre-fix, scanDir's Map kept one and the other simply stopped
  // existing for every validator — `check` printed "check OK".
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0001', 'other-lanes-version');
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1, `duplicate id must fail check (stdout: ${r.stdout})`);
  assert.match(r.stderr, /id "0001" names 2 files in todos\/ \(0001-a\.md, 0001-other-lanes-version\.md\)/);
  assert.match(r.stderr, /next-id/, 'the error must point at the allocator');
});

test('RED: two files sharing an id in done/ fail too', () => {
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'x', { done: true, status: 'done' });
  writeItem(todos, '0002', 'y', { done: true, status: 'done' });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 1, `stdout: ${r.stdout}`);
  assert.match(r.stderr, /id "0002" names 2 files in todos\/done\//);
});

test('a -design.md companion beside its ticket is not a duplicate', () => {
  // todos/done/0275 is this shape: the committed design doc sits beside the
  // implementation ticket. It is ONE id with a companion, not two tickets.
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'thing', { done: true, status: 'done' });
  writeItem(todos, '0002', 'thing-design', { done: true, status: 'done' });
  writeManifest(todos, [{ id: '0001' }]);
  const r = run(todos, ['check']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /check OK/);
});

test('a lone -design.md IS the ticket, and still collides with a second file', () => {
  // todos/done/0007-wm-compositor-design.md is the sole 0007 file — a suffix-
  // only rule would have demoted it to a companion of a ticket that does not
  // exist, and (worse) let `0354-x-design.md` shadow a real collision.
  const todos = setup();
  writeItem(todos, '0001', 'a');
  writeItem(todos, '0002', 'thing-design', { done: true, status: 'done' });
  writeManifest(todos, [{ id: '0001' }]);
  let r = run(todos, ['check']);
  assert.strictEqual(r.code, 0, r.stderr);

  writeItem(todos, '0002', 'other-design', { done: true, status: 'done' });
  r = run(todos, ['check']);
  assert.strictEqual(r.code, 1, `two lone design docs on one id must still fail (stdout: ${r.stdout})`);
  assert.match(r.stderr, /id "0002" names 2 files in todos\/done\//);
});

process.stdout.write(`\nqueue.js: ${passed} passed\n`);
