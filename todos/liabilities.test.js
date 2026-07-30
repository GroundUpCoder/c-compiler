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
  // cc ticket liveness is injected the same way the legacy file state is —
  // `cc: { states: {'#12': 'open'}, verified: true }` — so no test touches
  // cc-meta. Omitted → an UNVERIFIED scan (the offline shape).
  const cc = opts.cc
    ? { states: new Map(Object.entries(opts.cc.states || {})), verified: opts.cc.verified !== false, note: opts.cc.note || null }
    : { states: new Map(), verified: false, note: '#N liveness UNVERIFIED (test default)' };
  return LIB.check({ registerPath, repoRoot: root, tickets, cc });
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

// ---------- cc ticket refs (#N — the live dialect since the 2026-07-30 cutover) ----------

test('a #N funding ticket that is open in cc passes', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { states: { '#12': 'open' } } });
  assert.deepStrictEqual(res.errors, [], messages(res));
  assert.strictEqual(res.ccNote, null);
});

test('a #N funding ticket that is in_progress in cc is live too', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { states: { '#12': 'in_progress' } } });
  assert.deepStrictEqual(res.errors, [], messages(res));
});

test('RED: a #N funding ticket that is done in cc fails as CLOSED', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { states: { '#12': 'done' } } });
  assert.match(messages(res), /cc ticket #12 is CLOSED/);
});

test('RED: a #N funding ticket that is dropped in cc fails as CLOSED', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { states: { '#12': 'dropped' } } });
  assert.match(messages(res), /cc ticket #12 is CLOSED/);
});

test('RED: a #N funding ticket unknown to cc fails as missing', () => {
  const res = run(['### L01 — a gap\n- ticket: #999\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { states: {} } });
  assert.match(messages(res), /cc ticket #999 does not exist/);
});

test('an unverified cc scan never fails a #N entry, and says so via ccNote', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/thing.c\n- anchor: int x;'],
    { cc: { verified: false, note: '#N liveness UNVERIFIED (cc-meta not on PATH)' } });
  assert.deepStrictEqual(res.errors, [], messages(res));
  assert.match(res.ccNote, /UNVERIFIED/);
});

test('an all-legacy register never consults cc (no ccNote even when unverified)', () => {
  const res = run([OK_ENTRY]);   // run()'s default cc is an unverified scan
  assert.deepStrictEqual(res.errors, [], messages(res));
  assert.strictEqual(res.ccNote, null);
});

test('RED: an unpinned deferral to a CLOSED #N fails; pinning it passes', () => {
  const entry = (extra) => [
    '### L01 — a gap',
    '- ticket: #12',
    '- file: src/thing.c',
    '- anchor: int x;',
    '- defers-to: #7',
    ...extra,
  ].join('\n');
  const cc = { cc: { states: { '#12': 'open', '#7': 'done' } } };
  assert.match(messages(run([entry([])], cc)), /DEFERRAL OUTLIVED ITS PREMISE/);
  const pinnedRes = run([entry(['- expired: #7'])], cc);
  assert.deepStrictEqual(pinnedRes.errors, [], messages(pinnedRes));
  assert.strictEqual(pinnedRes.pinned[0].expired, '#7');
});

test('RED: a #N in the anchor that the entry does not classify fails', () => {
  const res = run(['### L01 — a gap\n- ticket: #12\n- file: src/cc.c\n- anchor: /* deferred to #7 */'],
    { files: { 'src/cc.c': '/* deferred to #7 */\n' }, cc: { states: { '#12': 'open', '#7': 'open' } } });
  assert.match(messages(res), /anchor mentions ticket #7 but the entry does not classify it/);
});

test('RED: a ref that is neither #N nor a 4-digit id fails the field check', () => {
  const res = run(['### L01 — a gap\n- ticket: banana\n- file: src/thing.c\n- anchor: int x;']);
  assert.match(messages(res), /not a ticket ref/);
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
  assert.match(messages(res), /anchor mentions ticket 0281 but the entry does not classify it/);
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
  // offline: this suite stays hermetic — the ONLINE #N-liveness pass over the
  // real register is the `liabilities-check` case of tests/todos/run.js.
  const res = LIB.check({ offline: true });
  assert.deepStrictEqual(res.errors, [], res.errors.join('\n'));
  assert.ok(res.entries.length >= 20, `expected a seeded register, got ${res.entries.length} entries`);
});

test('the register still carries the two findings that motivated it (L10, L20)', () => {
  // The 0286-era motivating findings (todos/0291 and todos/0300) live on as
  // entries L10 and L20; their funding refs became cc tickets at the
  // 2026-07-30 cutover, but the demonstration is unchanged. offline: the
  // demonstrated shape (a pinned expired deferral to an ARCHIVED target) is
  // judged from todos/done/, so no cc probe is needed.
  const res = LIB.check({ offline: true });
  for (const id of ['L10', 'L20']) {
    const own = res.entries.filter(e => e.id === id);
    assert.ok(own.length, `register entry ${id} is gone`);
    // Each must be the shape the checker exists to catch: a gap comment
    // deferring to an item that is now closed, acknowledged by a pin. Drop the
    // pin and the check goes red naming this entry — that is the demonstration.
    const stale = own.filter(e => (e.expired || []).length);
    assert.ok(stale.length, `${id}'s entry no longer records an expired deferral`);
  }
  assert.ok(res.pinned.some(p => p.id === 'L10'), 'L10 does not fire as a pinned expired deferral');
  assert.ok(res.pinned.some(p => p.id === 'L20'), 'L20 does not fire as a pinned expired deferral');
});

test('unpinning the real entries turns the real register RED', () => {
  // The RED half of the demonstration, run against the CHECKED-IN register:
  // strip every `- expired:` line and the same file must fail, naming the
  // deferral-outlived-its-premise shape for L10 and L20 (né 0291/0300).
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-'));
  const registerPath = path.join(root, 'REG.md');
  const real = fs.readFileSync(path.join(__dirname, 'LIABILITIES.md'), 'utf8');
  fs.writeFileSync(registerPath, real.split('\n').filter(l => !/^- expired:/.test(l)).join('\n'));
  const res = LIB.check({ registerPath, offline: true });
  const msg = messages(res);
  assert.match(msg, /DEFERRAL OUTLIVED ITS PREMISE/);
  assert.match(msg, /\(L10\)/);
  assert.match(msg, /\(L20\)/);
  assert.strictEqual(res.pinned.length, 0);
});

test('citedFiles exposes the register\'s files to the diff planner', () => {
  const cited = LIB.citedFiles();
  assert.ok(cited.ok, cited.error);
  assert.ok(cited.files.includes('os/wm.c'), 'os/wm.c should be cited');
  assert.ok(cited.files.includes('todos/WIN32.md'), 'todos/WIN32.md should be cited');
});

// ---------- cross-ref Lnn allocation (todos/0358) ----------
//
// The register had NO allocator: entries were numbered by eye off whatever ref
// the lane happened to be on, which is how 0318 and 0338 wrote two different
// L44 entries. `duplicate entry id` above is the check that catches it once
// both are in ONE file — i.e. after the merge. This is what stops the merge
// needing to renumber in the first place.

const { execFileSync } = require('child_process');

function REG(entries) {
  return `prose\n\n<!-- BEGIN ENTRIES -->\n\n${entries.join('\n\n')}\n\n<!-- END ENTRIES -->\n`;
}

// A throwaway repo with liabilities.js + idspace.js retargeted into it, so the
// CLI's REPO_ROOT is the temp tree. Returns { root, todos, git }.
function repo() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-refs-'));
  const todos = path.join(root, 'todos');
  fs.mkdirSync(todos, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  for (const f of ['liabilities.js', 'idspace.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(todos, f));
  }
  return { root, todos, git };
}

function nextId(root, todos, args = []) {
  return execFileSync('node', [path.join(todos, 'liabilities.js'), 'next-id', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

test('RED: two lanes off a common base get DISTINCT liability ids', () => {
  const { root: r, todos, git } = repo();
  const reg = path.join(todos, 'LIABILITIES.md');
  fs.writeFileSync(reg, REG(['### L01 — first\n- ticket: 0001']));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'lane-a');
  const a = nextId(r, todos);
  assert.match(a, /^L02\s/, a);
  fs.writeFileSync(reg, REG(['### L01 — first\n- ticket: 0001', '### L02 — lane a\n- ticket: 0001']));
  git('add', '-A'); git('commit', '-q', '-m', 'lane a');

  // Lane B branches from the same base: its register still ends at L01.
  git('checkout', '-q', '-B', 'lane-b', base);
  assert.ok(!/L02/.test(fs.readFileSync(reg, 'utf8')),
    'lane B must not see lane A\'s entry on disk — otherwise this case proves nothing');
  const b = nextId(r, todos);
  assert.ok(!/^L02\s/.test(b), `both lanes allocated L02 — this is the L44 collision (${b})`);
  assert.match(b, /^L03\s/, b);
  assert.match(b, /derived across \d+ ref\(s\)/, 'the derivation must be visible');
});

test('the liability allocator REFUSES outside a repo, and --local opts out', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'liab-norepo-'));
  const todos = path.join(root, 'todos');
  fs.mkdirSync(todos, { recursive: true });
  for (const f of ['liabilities.js', 'idspace.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(todos, f));
  }
  fs.writeFileSync(path.join(todos, 'LIABILITIES.md'), REG(['### L07 — g\n- ticket: 0001']));

  let failed = null;
  try { nextId(root, todos); } catch (e) { failed = e; }
  assert.ok(failed, 'must refuse outside a repo instead of guessing from the file');
  assert.match(failed.stderr.toString(), /Refusing to allocate a liability id from the working tree alone/);
  assert.match(nextId(root, todos, ['--local']), /^L08\s+liability id L08 — WORKING TREE ONLY/);
});

process.stdout.write(`\nliabilities.js: ${passed} passed\n`);
