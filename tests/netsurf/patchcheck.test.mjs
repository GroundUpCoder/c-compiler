#!/usr/bin/env node
// Tests for vendor/netsurf/patchcheck.mjs (todos/0423).
//
// Two halves:
//  - unit: parseDiff + reverseApply driven over REAL `diff -urN` output
//    (generated here, never hand-typed), covering the shapes the record can
//    take — edits, creations, deletions, missing-EOL, multi-hunk, and the
//    reframing-annihilation property the whole design rests on.
//  - end-to-end: a scratch git repo with a miniature vendor/netsurf layout,
//    driven through the CLI (--repo). This is where the acceptance proofs
//    live as permanent regression guards: the injected one-character drift
//    and the deliberately constructed bad commit both FAIL, and their
//    corrected twins PASS.
//
// Two pins against the real repo's history sit at the end: the 0422 closing
// commit (correct by hand-verification) passes, and the 0407 drift commit —
// the incident this ticket exists because of — fails.
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDiff, reverseApply, clipPair } from '../../vendor/netsurf/patchcheck.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..', '..');
const PATCHCHECK = path.join(REPO, 'vendor', 'netsurf', 'patchcheck.mjs');

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '') + '\n');
  if (!ok) failures++;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
}

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'patchcheck-test-'));

// ---------- helpers ----------

function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

// Real `diff -urN a b` from a scratch dir — the exact format update.sh applies.
let diffN = 0;
function makeDiff(pristineFiles, patchedFiles, flags = ['-urN']) {
  const d = path.join(W, `diffwork-${diffN++}`);
  fs.mkdirSync(path.join(d, 'a'), { recursive: true });
  fs.mkdirSync(path.join(d, 'b'), { recursive: true });
  writeTree(path.join(d, 'a'), pristineFiles);
  writeTree(path.join(d, 'b'), patchedFiles);
  const r = run('diff', flags.concat(['a', 'b']), { cwd: d });
  if (r.status !== 0 && r.status !== 1) throw new Error(`diff failed: ${r.stderr}`);
  return r.stdout;
}

const LINES = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';

// ---------- unit: reverseApply over real diff output ----------

{
  // Mid-file edit, two hunks far apart.
  const pristine = LINES(60, 'p');
  const patched = pristine.split('\n').map((l, i) => (i === 4 ? l + ' EDITED' : l)).join('\n')
    .replace('p line 50', 'p line 50 ALSO\nan added line');
  const sec = parseDiff(makeDiff({ 'f.c': pristine }, { 'f.c': patched }), 't1').get('f.c');
  const r = reverseApply(sec, patched);
  check('unit: two-hunk edit reverse-applies to pristine', r.ok && r.pristine === pristine, r.err);

  // Tamper INSIDE a hunk's territory → frame failure, named line.
  const tampered = patched.replace('p line 5 EDITED', 'p line 5 EDITTED');
  const r2 = reverseApply(sec, tampered);
  check('unit: in-hunk tamper is a frame failure', !r2.ok && /context mismatch/.test(r2.err), r2.err);

  // Tamper OUTSIDE every hunk → frame still holds, residual differs
  // (the manifest/differential layers own this class).
  const outside = patched.replace('p line 30', 'p line 30 DRIFT');
  const r3 = reverseApply(sec, outside);
  check('unit: out-of-hunk drift keeps the frame but changes the residual',
        r3.ok && r3.pristine !== pristine, r3.err);

  // Reframing annihilation: -U1 and -U8 give different diff TEXT, same residual.
  const secU1 = parseDiff(makeDiff({ 'f.c': pristine }, { 'f.c': patched }, ['-rN', '-U1']), 't1u1').get('f.c');
  const secU8 = parseDiff(makeDiff({ 'f.c': pristine }, { 'f.c': patched }, ['-rN', '-U8']), 't1u8').get('f.c');
  check('unit: reframed sections have different text', secU1.text !== secU8.text);
  const p1 = reverseApply(secU1, patched), p8 = reverseApply(secU8, patched);
  check('unit: reframed sections reduce to the same pristine',
        p1.ok && p8.ok && p1.pristine === pristine && p8.pristine === pristine,
        p1.err || p8.err);
}

{
  // Creation (-N: file only in b) and deletion (file only in a).
  const text = makeDiff({ 'gone.c': LINES(3, 'g') }, { 'new.c': LINES(4, 'n') });
  const secs = parseDiff(text, 't2');
  const rNew = reverseApply(secs.get('new.c'), LINES(4, 'n'));
  check('unit: creation section reduces the file to absent', rNew.ok && rNew.pristine === null, rNew.err);
  const rNewBad = reverseApply(secs.get('new.c'), LINES(4, 'n').replace('n line 2', 'n line 2x'));
  check('unit: creation section rejects tampered content', !rNewBad.ok);
  const rGone = reverseApply(secs.get('gone.c'), null);
  check('unit: deletion section resurrects the pristine bytes', rGone.ok && rGone.pristine === LINES(3, 'g'), rGone.err);
  const rGoneBad = reverseApply(secs.get('gone.c'), 'still here\n');
  check('unit: deletion section rejects a still-present file', !rGoneBad.ok);
}

{
  // Missing trailing newline, both directions.
  const prisNoEol = 'a\nb\nc';   // pristine lacks EOL
  const patched = 'a\nb\nc\nd\n';
  const sec = parseDiff(makeDiff({ 'f.c': prisNoEol }, { 'f.c': patched }), 't3').get('f.c');
  const r = reverseApply(sec, patched);
  check('unit: pristine-side missing EOL round-trips', r.ok && r.pristine === prisNoEol, r.err);

  const pris2 = 'a\nb\nc\n';
  const patched2 = 'a\nb\nc\nd';  // patched lacks EOL
  const sec2 = parseDiff(makeDiff({ 'f.c': pris2 }, { 'f.c': patched2 }), 't3b').get('f.c');
  const r2 = reverseApply(sec2, patched2);
  check('unit: patched-side missing EOL round-trips', r2.ok && r2.pristine === pris2, r2.err);
  const r2wrong = reverseApply(sec2, patched2 + '\n');
  check('unit: EOL drift at a covered EOF is a frame failure', !r2wrong.ok, r2wrong && r2wrong.err);
}

// ---------- unit: clipPair (todos/0436) ----------

{
  // Near-start difference in short lines: shown whole, no ellipsis, col named.
  const p1 = clipPair('int a = 1;', 'int a = 2;');
  check('unit: clipPair shows short near-start pairs whole',
        p1.a === 'int a = 1;' && p1.b === 'int a = 2;' && p1.col === 9, JSON.stringify(p1));

  // Difference at column 0.
  const p2 = clipPair('Xbc', 'abc');
  check('unit: clipPair handles a column-0 difference',
        p2.col === 1 && p2.a === 'Xbc' && p2.b === 'abc', JSON.stringify(p2));

  const base = 'x'.repeat(150);

  // Deep difference mid-line: window opens before it, both cuts marked, and
  // the two clipped strings DIFFER (the whole point of the ticket).
  const p3 = clipPair(base.slice(0, 70) + 'A' + base.slice(71), base);
  check('unit: clipPair keeps a mid-line difference visible',
        p3.col === 71 && p3.a !== p3.b && p3.a.startsWith('…') && p3.a.endsWith('…') && p3.a.includes('A'),
        JSON.stringify(p3));

  // Difference at the very end: the window is pulled left to stay full and
  // reaches the end (no trailing ellipsis).
  const p4 = clipPair(base.slice(0, 149) + 'Z', base);
  check('unit: clipPair reaches an end-of-line difference',
        p4.col === 150 && p4.a !== p4.b && p4.a.startsWith('…') && p4.a.endsWith('Z'), JSON.stringify(p4));

  // One line a prefix of the other: col is one past the shorter line's end.
  const p5 = clipPair('abc', 'abcdef');
  check('unit: clipPair anchors a prefix pair past the shorter end',
        p5.col === 4 && p5.a === 'abc' && p5.b === 'abcdef', JSON.stringify(p5));

  // Length drift at the end of a LONG line stays visible too.
  const p6 = clipPair(base, base + 'tail');
  check('unit: clipPair shows length drift at the end of a long line',
        p6.col === 151 && p6.a !== p6.b && p6.b.endsWith('tail'), JSON.stringify(p6));

  // Equal inputs (the caller never passes them): whole-window clip of the
  // common end, col = length + 1.
  const p7 = clipPair('same', 'same');
  check('unit: clipPair reports col past the end for equal inputs',
        p7.col === 5 && p7.a === p7.b, JSON.stringify(p7));
}

{
  // ⭐ todos/0436 acceptance as a regression guard: a tamper DEEP in a long
  // line must render two DIFFERENT quoted strings and name the column. The
  // old head-anchored clip printed two identical 57-char prefixes here.
  const long = 'bool content_key_release(struct hlcache_handle *h, uint32_t key)';
  const pristine = ['top', long, 'middle', 'bottom'].join('\n') + '\n';
  const patched = pristine.replace('middle', 'middle EDITED');
  const sec = parseDiff(makeDiff({ 'f.c': pristine }, { 'f.c': patched }), 't0436').get('f.c');
  const tampered = patched.replace('uint32_t key', 'uint32_tX key');
  const r = reverseApply(sec, tampered);
  const m = r.ok ? null :
    /context mismatch at line 2 column 60: the tree has "(.*)", the record expects "(.*)"$/.exec(r.err);
  check('unit: deep-line mismatch names the column and shows the drift',
        !!m && m[1] !== m[2] && m[1].includes('uint32_tX') && m[2].includes('uint32_t k'), r.err);
}

// ---------- end-to-end: scratch repo through the CLI ----------

// Miniature vendor/netsurf: component `alpha` (patched, has a .diff),
// component `beta` (pristine, no .diff).
const ALPHA_PRISTINE = {
  'src/main.c': LINES(40, 'main'),
  'src/util.c': LINES(30, 'util'),
  'include/api.h': LINES(10, 'api'),
};
const ALPHA_PATCHED = {
  'src/main.c': ALPHA_PRISTINE['src/main.c'].replace('main line 20', 'main line 20 /* wasm fix */'),
  'src/util.c': ALPHA_PRISTINE['src/util.c'],
  'include/api.h': ALPHA_PRISTINE['include/api.h'].replace('api line 3', 'api line 3 patched'),
};
const BETA_FILES = { 'src/beta.c': LINES(12, 'beta') };

const R = path.join(W, 'repo');
const NS = path.join(R, 'vendor', 'netsurf');
fs.mkdirSync(path.join(NS, 'patches'), { recursive: true });
writeTree(path.join(NS, 'alpha'), ALPHA_PATCHED);
writeTree(path.join(NS, 'alpha'), { 'lib.json': '{"name":"alpha"}\n' });
writeTree(path.join(NS, 'beta'), BETA_FILES);
fs.writeFileSync(path.join(NS, 'UPSTREAM.json'), JSON.stringify({
  components: {
    alpha: { url: 'https://example.invalid/alpha', rev: 'aaaa1111' },
    beta: { url: 'https://example.invalid/beta', rev: 'bbbb2222' },
  },
}, null, 1) + '\n');
fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'), makeDiff(ALPHA_PRISTINE, ALPHA_PATCHED));

function gitR(...args) {
  const r = run('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', ...args], { cwd: R });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}
function pc(...args) {
  return run(process.execPath, [PATCHCHECK, '--repo', R, ...args]);
}
function restore() { gitR('checkout', '--', '.'); gitR('clean', '-fdq'); }
// reset --hard leaves a formerly-committed new file behind as untracked;
// every rewind cleans too, so scenarios stay independent.
function rewind(n) { gitR('reset', '-q', '--hard', `HEAD~${n}`); gitR('clean', '-fdq'); }

gitR('init', '-q');
gitR('add', '-A');
gitR('commit', '-qm', 'good base (pre-manifest)');

// Manifest bootstrap: standing check without one fails; --write-manifest heals.
{
  const r = pc();
  check('e2e: missing manifest fails loud', r.status === 1 && /pristine\.json: missing/.test(r.stdout), r.stdout.trim());
  const w = pc('--write-manifest');
  check('e2e: --write-manifest writes 2 hashes (util.c is unpatched)', w.status === 0 && /wrote 2 residual hash/.test(w.stdout), w.stdout.trim());
  gitR('add', '-A'); gitR('commit', '-qm', 'manifest');
  const r2 = pc();
  check('e2e: clean tree passes (2 checks, 0 failures)', r2.status === 0 && /2 file check\(s\), 0 failure/.test(r2.stdout), r2.stdout.trim());
}

// ⭐ Acceptance proof 1 (offline layer): injected ONE-CHARACTER drift, outside
// every hunk, in a patched file — the class `--check` also catches upstream.
{
  const p = path.join(NS, 'alpha', 'src', 'main.c');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('main line 35', 'main line 3X'));
  const r = pc();
  check('e2e: injected one-char drift (worktree) FAILS the standing check',
        r.status === 1 && /pristine residual .*does not match the recorded/.test(r.stdout), r.stdout.trim());
  check('e2e: ...and the dirty-tree differential names it too',
        /residual differs between HEAD and worktree/.test(r.stdout), r.stdout.trim());
  restore();
}

// ⭐ Acceptance proof 2: the deliberately constructed BAD COMMIT — edits a
// patched file, never touches the .diff. The exact 0407 shape.
{
  const p = path.join(NS, 'alpha', 'src', 'main.c');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('main line 35', 'main line 35 SHIPPED FIX'));
  gitR('add', '-A'); gitR('commit', '-qm', 'BAD: fix without patch record');
  const r = pc('--commit', 'HEAD');
  check('e2e: bad commit (file edited, .diff untouched) FAILS --commit',
        r.status === 1 && /not fully mirrored in the patch record/.test(r.stdout), r.stdout.trim());

  // The corrected twin: same tree change WITH the regenerated record.
  const fixedPatched = { ...ALPHA_PATCHED, 'src/main.c': fs.readFileSync(p, 'utf8') };
  fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'), makeDiff(ALPHA_PRISTINE, fixedPatched));
  gitR('add', '-A'); gitR('commit', '-qm', 'GOOD: record caught up');
  const r2 = pc('--commit', 'HEAD');
  check('e2e: catch-up commit still fails differentially (its PARENT was drifted)',
        r2.status === 1, r2.stdout.trim());
  const rAgainst = pc('--against', 'HEAD~2');
  check('e2e: worktree vs the pre-drift base passes (edit + record together)',
        rAgainst.status === 0, rAgainst.stdout.trim());
  rewind(2); // back to the good base
}

// A GOOD commit: edit + regenerated section in ONE commit passes --commit.
{
  const newPatched = {
    ...ALPHA_PATCHED,
    'src/util.c': ALPHA_PATCHED['src/util.c'].replace('util line 7', 'util line 7 /* new fix */'),
  };
  writeTree(path.join(NS, 'alpha'), newPatched);
  fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'), makeDiff(ALPHA_PRISTINE, newPatched));
  gitR('add', '-A'); gitR('commit', '-qm', 'good: edit + record together');
  const r = pc('--commit', 'HEAD');
  check('e2e: good commit (edit + record in one commit) passes', r.status === 0, r.stdout.trim());
  check('e2e: good commit checked exactly the changed file', /1 file check\(s\)/.test(r.stdout), r.stdout.trim());
  rewind(1);
}

// Reframe-only commit: rewrite the .diff with different context width, no
// tree change → different text, identical residuals → PASS.
{
  fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'),
                   makeDiff(ALPHA_PRISTINE, ALPHA_PATCHED, ['-rN', '-U6']));
  gitR('add', '-A'); gitR('commit', '-qm', 'reframe only');
  const r = pc('--commit', 'HEAD');
  check('e2e: reframe-only .diff rewrite passes (framing is annihilated)',
        r.status === 0 && /file check\(s\), 0 failure/.test(r.stdout), r.stdout.trim());
  const r2 = pc();
  check('e2e: reframe keeps the standing manifest green', r2.status === 0, r2.stdout.trim());
  rewind(1);
}

// A file APPEARS in a component with no creating section → the next
// update.sh run would destroy it → FAIL. With a creation section → PASS.
{
  fs.writeFileSync(path.join(NS, 'alpha', 'src', 'extra.c'), LINES(5, 'extra'));
  gitR('add', '-A'); gitR('commit', '-qm', 'BAD: unrecorded new file');
  const r = pc('--commit', 'HEAD');
  check('e2e: unrecorded new file fails (update.sh would destroy it)',
        r.status === 1 && /no patch section creates/.test(r.stdout), r.stdout.trim());
  rewind(1);

  const withExtra = { ...ALPHA_PATCHED, 'src/extra.c': LINES(5, 'extra') };
  writeTree(path.join(NS, 'alpha'), { 'src/extra.c': LINES(5, 'extra') });
  fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'), makeDiff(ALPHA_PRISTINE, withExtra));
  gitR('add', '-A'); gitR('commit', '-qm', 'good: new file with creation section');
  const r2 = pc('--commit', 'HEAD');
  check('e2e: new file WITH a creation section passes', r2.status === 0, r2.stdout.trim());
  rewind(1);
}

// A pristine-derived file DISAPPEARS without a deletion section → update.sh
// would resurrect it → FAIL. With a deletion section → PASS.
{
  fs.rmSync(path.join(NS, 'alpha', 'src', 'util.c'));
  gitR('add', '-A'); gitR('commit', '-qm', 'BAD: unrecorded deletion');
  const r = pc('--commit', 'HEAD');
  check('e2e: unrecorded deletion fails (update.sh would resurrect it)',
        r.status === 1 && /without a deletion section/.test(r.stdout), r.stdout.trim());
  rewind(1);

  const without = { ...ALPHA_PATCHED };
  delete without['src/util.c'];
  fs.rmSync(path.join(NS, 'alpha', 'src', 'util.c'));
  fs.writeFileSync(path.join(NS, 'patches', 'alpha.diff'), makeDiff(ALPHA_PRISTINE, without));
  gitR('add', '-A'); gitR('commit', '-qm', 'good: deletion recorded');
  const r2 = pc('--commit', 'HEAD');
  check('e2e: recorded deletion passes', r2.status === 0, r2.stdout.trim());
  rewind(1);
}

// beta gains its FIRST section: edit + new patches/beta.diff in one commit.
// The differential passes; the standing manifest demands its new entry.
{
  const betaPatched = { 'src/beta.c': BETA_FILES['src/beta.c'].replace('beta line 5', 'beta line 5 patched') };
  writeTree(path.join(NS, 'beta'), betaPatched);
  fs.writeFileSync(path.join(NS, 'patches', 'beta.diff'), makeDiff(BETA_FILES, betaPatched));
  gitR('add', '-A'); gitR('commit', '-qm', 'good: first section for beta');
  const r = pc('--commit', 'HEAD');
  check('e2e: a component\'s FIRST section passes differentially', r.status === 0, r.stdout.trim());
  const r2 = pc();
  check('e2e: ...but the standing check demands its manifest entry',
        r2.status === 1 && /no entry in patches\/pristine\.json/.test(r2.stdout), r2.stdout.trim());
  const w = pc('--write-manifest');
  gitR('add', '-A'); gitR('commit', '-qm', 'manifest for beta');
  const r3 = pc();
  check('e2e: --write-manifest heals it (3 checks, 0 failures)',
        w.status === 0 && r3.status === 0 && /3 file check\(s\), 0 failure/.test(r3.stdout), r3.stdout.trim());
  rewind(2);
}

// --staged: the bad edit staged but uncommitted is caught pre-commit.
{
  const p = path.join(NS, 'alpha', 'include', 'api.h');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('api line 8', 'api line 8 staged-drift'));
  gitR('add', '-A');
  const r = pc('--staged');
  check('e2e: --staged catches a staged unmirrored edit', r.status === 1 && /index/.test(r.stdout), r.stdout.trim());
  restore();
}

// UPSTREAM pin change: the differential SKIPS the component with a note
// (update.sh --check owns pin transitions) — no false failure.
{
  const up = JSON.parse(fs.readFileSync(path.join(NS, 'UPSTREAM.json'), 'utf8'));
  up.components.alpha.rev = 'aaaa9999';
  fs.writeFileSync(path.join(NS, 'UPSTREAM.json'), JSON.stringify(up, null, 1) + '\n');
  const p = path.join(NS, 'alpha', 'src', 'main.c');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'new upstream tail\n');
  gitR('add', '-A'); gitR('commit', '-qm', 'pin bump + new base');
  const r = pc('--commit', 'HEAD');
  check('e2e: pin change skips the component with a note',
        r.status === 0 && /pin changed .*differential skipped/.test(r.stdout), r.stdout.trim());
  rewind(1);
}

// lib.json is preserved by update.sh's install — edits to it are exempt.
{
  fs.writeFileSync(path.join(NS, 'alpha', 'lib.json'), '{"name":"alpha","v":2}\n');
  gitR('add', '-A'); gitR('commit', '-qm', 'lib.json only');
  const r = pc('--commit', 'HEAD');
  check('e2e: a lib.json-only change is exempt', r.status === 0 && /0 file check\(s\)/.test(r.stdout), r.stdout.trim());
  rewind(1);
}

// A patches/*.diff naming no component can never be applied by update.sh.
{
  fs.writeFileSync(path.join(NS, 'patches', 'gamma.diff'), makeDiff({ 'x.c': 'a\n' }, { 'x.c': 'b\n' }));
  const r = pc();
  check('e2e: an orphan patches/gamma.diff fails loud',
        r.status === 1 && /names no component/.test(r.stdout), r.stdout.trim());
  restore();
}

// ---------- pins against the real repo's history ----------

function haveCommit(sha) {
  return run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO }).status === 0;
}
{
  // cb4178b6: the 0422 closing netsurf commit — hand-verified correct on
  // 2026-07-30 (3 files, heavy .diff reframing annihilated).
  if (haveCommit('cb4178b6')) {
    const r = run(process.execPath, [PATCHCHECK, '--repo', REPO, '--commit', 'cb4178b6']);
    check('history pin: 0422\'s netsurf commit passes (3 files)',
          r.status === 0 && /3 file check\(s\), 0 failure/.test(r.stdout), r.stdout.trim());
  } else check('history pin: 0422 commit present (skip: shallow clone?)', true);

  // 1a0909c4: a 0407 drift commit — landed netsurf sources, never touched
  // patches/. The incident that motivated todos/0423.
  if (haveCommit('1a0909c4')) {
    const r = run(process.execPath, [PATCHCHECK, '--repo', REPO, '--commit', '1a0909c4']);
    check('history pin: 0407\'s drift commit fails', r.status === 1, String(r.status));
  } else check('history pin: 0407 commit present (skip: shallow clone?)', true);
}

fs.rmSync(W, { recursive: true, force: true });
process.stdout.write(`\npatchcheck tests: ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
