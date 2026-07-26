#!/usr/bin/env node
// todos/liabilities.test.js — tests for the liability register's validator
// (todos/0286). Zero-dependency; run with:  node todos/liabilities.test.js
//
// Each case builds a throwaway tree (a register, a fake cited source file, and
// a fake ticket state) and calls the real check(). The point of the suite is
// the RED cases: a checker that cannot be shown failing on a stale entry is
// prose with an exit code.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const LIB = require('./liabilities.js');

let passed = 0;
let root = null;

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

// Build a temp repo root containing `files` (relPath -> contents) and a
// register made of `entries` (raw text blocks), then run check() against it
// with the given ticket state.
function run(entries, opts = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-'));
  const files = opts.files || { 'src/thing.c': 'int x;\n/* gap: not done here, 0281 */\nint y;\n' };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const registerPath = path.join(root, 'REG.md');
  const body = opts.rawRegister !== undefined ? opts.rawRegister
    : `prose\n\n<!-- BEGIN ENTRIES -->\n\n${entries.join('\n\n')}\n\n<!-- END ENTRIES -->\n`;
  fs.writeFileSync(registerPath, body);
  const tickets = {
    open: new Map(Object.entries(opts.open || { '0300': '0300-x.md' })),
    done: new Map(Object.entries(opts.done || { '0281': '0281-y.md' })),
  };
  return LIB.check({ registerPath, repoRoot: root, tickets });
}

const OK_ENTRY = [
  '### L01 — a gap',
  '- ticket: 0300',
  '- file: src/thing.c',
  '- anchor: /* gap: not done here, 0281 */',
  '- defers-to: 0281',
  '- expired: 0281',
].join('\n');

function messages(res) { return res.errors.join('\n'); }

// ---------- the happy path ----------

test('a well-formed entry with a pinned expired deferral passes', () => {
  const res = run([OK_ENTRY]);
  assert.deepStrictEqual(res.errors, [], messages(res));
  assert.strictEqual(res.pinned.length, 1);
  assert.strictEqual(res.pinned[0].expired, '0281');
});

test('an anchor resolves to a live file:line', () => {
  const res = run([OK_ENTRY]);
  assert.strictEqual(res.entries[0].at, 'src/thing.c:2');
});

// ---------- RED: the ticket that funds the entry ----------

test('RED: an entry whose ticket is in done/ fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0281\n- file: src/thing.c\n- anchor: int x;']);
  assert.match(messages(res), /ticket 0281 is CLOSED/);
});

test('RED: an entry whose ticket does not exist fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 9999\n- file: src/thing.c\n- anchor: int x;']);
  assert.match(messages(res), /ticket 9999 has no todos\/9999-\*\.md file/);
});

test('RED: an entry citing two tickets fails (one entry, one funding item)', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300, 0281\n- file: src/thing.c\n- anchor: int x;']);
  assert.match(messages(res), /cites 2 tickets/);
});

// ---------- RED: the deferral that outlived its premise ----------

test('RED: an unpinned deferral to a CLOSED item fails (the 0291/0300 shape)', () => {
  const res = run([[
    '### L01 — a gap',
    '- ticket: 0300',
    '- file: src/thing.c',
    '- anchor: /* gap: not done here, 0281 */',
    '- defers-to: 0281',
  ].join('\n')]);
  assert.match(messages(res), /DEFERRAL OUTLIVED ITS PREMISE/);
  assert.match(messages(res), /0281, which is CLOSED/);
});

test('RED: a pin whose target is OPEN again fails (the xpass case)', () => {
  const res = run([OK_ENTRY], { open: { '0300': 'a.md', '0281': 'b.md' }, done: {} });
  assert.match(messages(res), /pin no longer applies/);
});

test('RED: an expired id that is not in defers-to fails', () => {
  const res = run([[
    '### L01 — a gap',
    '- ticket: 0300',
    '- file: src/thing.c',
    '- anchor: int x;',
    '- expired: 0281',
  ].join('\n')]);
  assert.match(messages(res), /expired: 0281 is not in defers-to/);
});

test('RED: a deferral target that is not a todo at all fails', () => {
  const res = run([[
    '### L01 — a gap',
    '- ticket: 0300',
    '- file: src/thing.c',
    '- anchor: int x;',
    '- defers-to: 9999',
  ].join('\n')]);
  assert.match(messages(res), /defers-to 9999 has no todos/);
});

// ---------- RED: the anchor ----------

test('RED: an anchor that is no longer in the file fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/thing.c\n- anchor: int gone;']);
  assert.match(messages(res), /anchor not found in src\/thing\.c/);
});

test('RED: an anchor matching two lines fails as ambiguous', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/dup.c\n- anchor: same line'],
    { files: { 'src/dup.c': 'same line\nsame line\n' } });
  assert.match(messages(res), /matches 2 lines/);
});

test('RED: a cited file that does not exist fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/nope.c\n- anchor: int x;']);
  assert.match(messages(res), /src\/nope\.c does not exist/);
});

test('RED: a ticket id in the anchor that the entry does not classify fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/thing.c\n- anchor: /* gap: not done here, 0281 */']);
  assert.match(messages(res), /anchor mentions todo 0281 but the entry does not classify it/);
});

test('provenance classifies a historical id in the anchor', () => {
  const res = run([[
    '### L01 — a gap',
    '- ticket: 0300',
    '- file: src/thing.c',
    '- anchor: /* gap: not done here, 0281 */',
    '- provenance: 0281',
  ].join('\n')]);
  assert.deepStrictEqual(res.errors, [], messages(res));
});

test('a 4-digit number that is not a ticket needs no classification', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/n.c\n- anchor: char buf[4096];'],
    { files: { 'src/n.c': 'char buf[4096];\n' } });
  assert.deepStrictEqual(res.errors, [], messages(res));
});

// ---------- RED: the register itself cannot go quiet ----------

test('RED: an empty register fails instead of passing vacuously', () => {
  const res = run([], { rawRegister: 'prose\n<!-- BEGIN ENTRIES -->\n\n<!-- END ENTRIES -->\n' });
  assert.match(messages(res), /no entries — an empty register passes vacuously/);
});

test('RED: a register with no entry markers fails', () => {
  const res = run([], { rawRegister: 'just prose, no markers\n' });
  assert.match(messages(res), /missing the .*BEGIN ENTRIES/);
});

test('RED: a missing register file fails', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-'));
  const res = LIB.check({ registerPath: path.join(root, 'nope.md'), repoRoot: root,
    tickets: { open: new Map(), done: new Map() } });
  assert.match(messages(res), /cannot read/);
});

test('RED: an unparsable line inside the markers fails instead of being skipped', () => {
  const res = run([], { rawRegister:
    '<!-- BEGIN ENTRIES -->\n### L01 — a gap\n- ticket: 0300\nstray prose\n<!-- END ENTRIES -->\n' });
  assert.match(messages(res), /not an entry heading/);
});

test('RED: an unknown field fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/thing.c\n- anchor: int x;\n- owner: nobody']);
  assert.match(messages(res), /unknown field "owner"/);
});

test('RED: a missing required field fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- file: src/thing.c']);
  assert.match(messages(res), /missing the required field "anchor"/);
});

test('RED: a repeated field fails', () => {
  const res = run(['### L01 — a gap\n- ticket: 0300\n- ticket: 0300\n- file: src/thing.c\n- anchor: int x;']);
  assert.match(messages(res), /repeats the field "ticket"/);
});

test('RED: a duplicate entry id fails', () => {
  const e = '### L01 — a gap\n- ticket: 0300\n- file: src/thing.c\n- anchor: int x;';
  const res = run([e, e]);
  assert.match(messages(res), /duplicate entry id L01/);
});

test('RED: a field before any heading fails', () => {
  const res = run([], { rawRegister:
    '<!-- BEGIN ENTRIES -->\n- ticket: 0300\n<!-- END ENTRIES -->\n' });
  assert.match(messages(res), /before any/);
});

// ---------- the real register ----------

test('the checked-in register passes its own check', () => {
  const res = LIB.check();
  assert.deepStrictEqual(res.errors, [], res.errors.join('\n'));
  assert.ok(res.entries.length >= 20, `expected a seeded register, got ${res.entries.length} entries`);
});

test('the register still carries the two findings that motivated it (0291, 0300)', () => {
  const res = LIB.check();
  for (const ticket of ['0291', '0300']) {
    const own = res.entries.filter(e => e.ticket === ticket);
    assert.ok(own.length, `no register entry cites todos/${ticket}`);
    // Each must be the shape the checker exists to catch: a gap comment
    // deferring to an item that is now closed, acknowledged by a pin. Drop the
    // pin and the check goes red naming this entry — that is the demonstration.
    const stale = own.filter(e => (e.expired || []).length);
    assert.ok(stale.length, `todos/${ticket}'s entry no longer records an expired deferral`);
  }
  assert.ok(res.pinned.some(p => p.ticket === '0291'), '0291 does not fire as a pinned expired deferral');
  assert.ok(res.pinned.some(p => p.ticket === '0300'), '0300 does not fire as a pinned expired deferral');
});

test('unpinning the real entries turns the real register RED', () => {
  // The RED half of the demonstration, run against the CHECKED-IN register:
  // strip every `- expired:` line and the same file must fail, naming the
  // deferral-outlived-its-premise shape for 0291 and 0300.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-'));
  const registerPath = path.join(root, 'REG.md');
  const real = fs.readFileSync(path.join(__dirname, 'LIABILITIES.md'), 'utf8');
  fs.writeFileSync(registerPath, real.split('\n').filter(l => !/^- expired:/.test(l)).join('\n'));
  const res = LIB.check({ registerPath });
  const msg = messages(res);
  assert.match(msg, /DEFERRAL OUTLIVED ITS PREMISE/);
  assert.match(msg, /ticket 0291/);
  assert.match(msg, /ticket 0300/);
  assert.strictEqual(res.pinned.length, 0);
});

test('citedFiles exposes the register\'s files to the diff planner', () => {
  const cited = LIB.citedFiles();
  assert.ok(cited.ok, cited.error);
  assert.ok(cited.files.includes('os/wm.c'), 'os/wm.c should be cited');
  assert.ok(cited.files.includes('todos/WIN32.md'), 'todos/WIN32.md should be cited');
});

process.stdout.write(`\nliabilities.js: ${passed} passed\n`);
