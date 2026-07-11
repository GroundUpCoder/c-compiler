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
const { execFileSync } = require('child_process');

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
  return todos;
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
  writeItem(todos, '0002', 'b', { done: true, extraHeader: '- **Depends**: —' });
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

process.stdout.write(`\nqueue.js: ${passed} passed\n`);
