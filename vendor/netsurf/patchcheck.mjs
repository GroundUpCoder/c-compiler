#!/usr/bin/env node
// patchcheck.mjs — offline verifier for the patches/ record (todos/0423).
//
// The invariant update.sh's header states — "running it against the pinned
// revisions must reproduce the committed trees byte-identically" — decomposes
// into a network half and an offline half. The network half (fetch pristine,
// regenerate, re-apply) is `update.sh --check`, run on its cadence (see
// README.md "Updating"). THIS file is the offline half, cheap enough for the
// ordinary gate: it proves the committed (tree, diff) pair is self-consistent
// by INVERSION, not by proxy.
//
//   pristine(F) = reverse_apply(section-for-F in patches/<c>.diff, committed F)
//
// Three layers, all built on that one operation:
//
//  1. FRAME (standing): every section of every patches/<c>.diff must
//     reverse-apply against the current tree EXACTLY — right context at the
//     right line numbers, zero fuzz, zero offset. A fuzzy apply means the
//     record no longer frames its own tree; that is drift, not a pass.
//  2. MANIFEST (standing): the sha256 of every pristine residual must match
//     patches/pristine.json. A hand-edit to a patched file that dodges every
//     hunk's context passes FRAME but changes the residual; this catches it
//     at any later time, not just in the commit window.
//  3. DIFFERENTIAL (per change): for every component file changed between two
//     refs — worktree vs HEAD, index vs HEAD (--staged), or a commit vs its
//     first parent (--commit) — the residual must be byte-identical on both
//     sides. Hunk reframing (different diff heuristic, shifted offsets)
//     changes the diff TEXT but not what it reduces to, so it passes; a
//     missing or wrong hunk leaves new code behind in the residual, so it
//     fails. This also covers files NO section owns (a hand-added or
//     hand-edited pristine file, which the next update.sh run would silently
//     destroy) — their residual is the file itself.
//
//  The differential is relative (it trusts the older ref); the manifest is
//  absolute but records what --write-manifest saw. `update.sh --check`
//  closes the loop against real upstream on its cadence.
//
// Usage:
//   node vendor/netsurf/patchcheck.mjs                 # FRAME + MANIFEST (+ DIFFERENTIAL vs HEAD when dirty)
//   node vendor/netsurf/patchcheck.mjs --staged        # + DIFFERENTIAL index-vs-HEAD (pre-commit hook)
//   node vendor/netsurf/patchcheck.mjs --commit SHA    # DIFFERENTIAL SHA^ → SHA
//   node vendor/netsurf/patchcheck.mjs --against REF   # DIFFERENTIAL REF → worktree
//   node vendor/netsurf/patchcheck.mjs --write-manifest  # regenerate patches/pristine.json (see below)
//   node vendor/netsurf/patchcheck.mjs --repo DIR      # operate on another checkout/scratch repo (tests)
//
// --write-manifest is for INTENTIONAL residual changes only: an UPSTREAM.json
// bump, a generator/relativize change re-run through update.sh, or a file
// gaining/losing its first section. It records what the current tree+diff
// reduce to — verify the change is the one you meant before committing it.
//
// A component whose UPSTREAM.json pin differs between the two differential
// refs is SKIPPED with a note: pin transitions legitimately change every
// residual in the component, and update.sh --check owns that case.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // vendor/netsurf
const VENDOR_PREFIX = 'vendor/netsurf/'; // repo-relative prefix of HERE
const MANIFEST_NAME = 'pristine.json';
// The tree under check. Defaults to the repo this file sits in; --repo DIR
// retargets everything (file reads, git, the manifest) at another checkout —
// how the tests drive scratch repos.
let REPO_ROOT = path.resolve(HERE, '..', '..');
let repoOverridden = false;

// ---------- unified-diff section parsing ----------

// Split one `diff -urN a/X b/X` stream into per-file sections.
// Returns Map<path, {path, text, hunks}> where `text` is the section's HUNK
// text — the `diff`/`---`/`+++` header lines are excluded on purpose, so a
// regeneration that only re-stamps the header timestamps does not read as a
// changed section.
export function parseDiff(text, label) {
  const sections = new Map();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('--- ')) { i++; continue; }
    const oldPath = stripName(lines[i], '--- ', label);
    if (!lines[i + 1] || !lines[i + 1].startsWith('+++ ')) {
      throw new Error(`${label}: malformed section at line ${i + 1}: '---' without '+++'`);
    }
    const newPath = stripName(lines[i + 1], '+++ ', label);
    if (oldPath !== newPath) {
      throw new Error(`${label}: rename section (${oldPath} → ${newPath}) — the record is content-only (diff -urN), renames are not representable`);
    }
    i += 2;
    const hunksStart = i;
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!m) throw new Error(`${label}: ${newPath}: bad hunk header '${lines[i]}'`);
      const h = {
        oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
        body: [],
      };
      i++;
      let oldSeen = 0, newSeen = 0;
      while (i < lines.length && (oldSeen < h.oldCount || newSeen < h.newCount)) {
        const l = lines[i];
        const tag = l[0] === undefined ? ' ' : l[0]; // an empty line is empty context
        if (tag === ' ' || l === '') { oldSeen++; newSeen++; }
        else if (tag === '-') oldSeen++;
        else if (tag === '+') newSeen++;
        else throw new Error(`${label}: ${newPath}: unexpected line inside hunk: '${l}'`);
        h.body.push({ tag: l === '' ? ' ' : tag, text: l === '' ? '' : l.slice(1) });
        i++;
        // "\ No newline at end of file" annotates the line just pushed.
        if (i < lines.length && lines[i].startsWith('\\')) {
          h.body[h.body.length - 1].noEol = true;
          i++;
        }
      }
      if (oldSeen !== h.oldCount || newSeen !== h.newCount) {
        throw new Error(`${label}: ${newPath}: truncated hunk @@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@ (saw ${oldSeen}/${newSeen})`);
      }
      hunks.push(h);
    }
    if (!hunks.length) throw new Error(`${label}: ${newPath}: section has no hunks`);
    sections.set(newPath, { path: newPath, hunks, text: lines.slice(hunksStart, i).join('\n') });
  }
  return sections;
}

function stripName(line, prefix, label) {
  let name = line.slice(prefix.length);
  const tab = name.indexOf('\t');
  if (tab !== -1) name = name.slice(0, tab);
  if (name === '/dev/null') return null; // not produced by diff -urN, but harmless to accept
  const m = /^[ab]\//.exec(name);
  if (!m) throw new Error(`${label}: unexpected file name '${name}' (no a/ or b/ prefix)`);
  return name.slice(2);
}

// ---------- strict reverse apply ----------

// content: string | null (null = file absent). Returns
//   { ok:true, pristine: string|null }  — pristine null = the section CREATES the file
//   { ok:false, err }                   — any inexactness: wrong context, wrong
//                                         line numbers, wrong EOL. No fuzz, no offsets.
export function reverseApply(section, content) {
  const fail = (err) => ({ ok: false, err });
  const h0 = section.hunks[0];
  const creates = h0.oldStart === 0 && h0.oldCount === 0; // diff -urN new file
  const deletes = h0.newStart === 0 && h0.newCount === 0; // diff -urN deleted file
  if (creates || deletes) {
    if (section.hunks.length !== 1) return fail('whole-file section with more than one hunk');
  }
  if (deletes) {
    if (content !== null) return fail('the record deletes this file, but it exists in the tree');
    const lines = h0.body.map(b => b.text);
    const noEol = h0.body.length && h0.body[h0.body.length - 1].noEol;
    return { ok: true, pristine: joinLines(lines, !noEol) };
  }
  if (content === null) return fail('the record patches this file, but it is absent from the tree');
  const input = splitLines(content);
  if (creates) {
    const want = h0.body.map(b => b.text);
    const noEol = h0.body.length && h0.body[h0.body.length - 1].noEol;
    if (input.lines.length !== want.length) {
      return fail(`the record creates this file with ${want.length} line(s), the tree has ${input.lines.length}`);
    }
    for (let k = 0; k < want.length; k++) {
      if (input.lines[k] !== want[k]) return fail(`created-file content mismatch at line ${k + 1}`);
    }
    if (input.eol !== !noEol) return fail('created-file mismatch: trailing-newline state differs');
    return { ok: true, pristine: null };
  }

  const out = [];
  let cursor = 0;            // 0-based index into input.lines, next line to copy
  let pristineEol = input.eol; // corrected below if the last hunk reaches EOF
  for (const [hi, h] of section.hunks.entries()) {
    const where = `hunk #${hi + 1} @@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
    // The NEW side is our input. newCount==0 ⇒ newStart names the line BEFORE
    // the (reverse-)insertion point; otherwise it is the 1-based first line.
    const hunkAt = h.newCount === 0 ? h.newStart : h.newStart - 1;
    if (hunkAt < cursor) return fail(`${where}: overlaps the previous hunk`);
    if (hunkAt > input.lines.length) return fail(`${where}: starts past the end of the file (${input.lines.length} lines)`);
    for (; cursor < hunkAt; cursor++) out.push(input.lines[cursor]);
    let oldNoEol = false, newNoEol = false;
    for (const b of h.body) {
      if (b.tag === ' ' || b.tag === '+') {
        if (cursor >= input.lines.length) return fail(`${where}: runs past the end of the file`);
        if (input.lines[cursor] !== b.text) {
          return fail(`${where}: context mismatch at line ${cursor + 1}: the tree has ${JSON.stringify(clip(input.lines[cursor]))}, the record expects ${JSON.stringify(clip(b.text))}`);
        }
        cursor++;
      }
      if (b.tag === ' ' || b.tag === '-') out.push(b.text);
      if (b.noEol) {
        if (b.tag === ' ' || b.tag === '+') newNoEol = true;
        if (b.tag === ' ' || b.tag === '-') oldNoEol = true;
      }
    }
    if (cursor === input.lines.length) {
      // The hunk reaches EOF: the record states the new side's EOL exactly.
      if (input.eol !== !newNoEol) {
        return fail(`${where}: trailing-newline mismatch (tree ${input.eol ? 'has' : 'lacks'} one, the record says otherwise)`);
      }
      pristineEol = !oldNoEol;
    } else if (newNoEol || oldNoEol) {
      return fail(`${where}: 'No newline at end of file' inside a hunk that does not reach the end of the file`);
    }
  }
  for (; cursor < input.lines.length; cursor++) out.push(input.lines[cursor]);
  return { ok: true, pristine: joinLines(out, pristineEol) };
}

function splitLines(s) {
  if (s === '') return { lines: [], eol: true };
  const lines = s.split('\n');
  let eol = false;
  if (lines[lines.length - 1] === '') { lines.pop(); eol = true; }
  return { lines, eol };
}
function joinLines(lines, eol) {
  if (!lines.length) return '';
  return lines.join('\n') + (eol ? '\n' : '');
}
function clip(s) { return s.length > 60 ? s.slice(0, 57) + '…' : s; }

export function sha256(s) {
  return s === null ? 'absent' : crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------- tree/ref access ----------

const WORKTREE = Symbol('worktree');
const INDEX = Symbol('index');

function refLabel(ref) { return ref === WORKTREE ? 'worktree' : ref === INDEX ? 'index' : ref; }

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  return r;
}

// Read a repo-relative path at a ref; null = absent.
function readAt(ref, relPath) {
  if (ref === WORKTREE) {
    const p = path.join(REPO_ROOT, relPath);
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  }
  const spec = ref === INDEX ? `:${relPath}` : `${ref}:${relPath}`;
  const r = git(['show', spec]);
  if (r.status === 0) return r.stdout;
  const msg = r.stderr || '';
  if (/does not exist|exists on disk, but not in|not in the index|bad revision|invalid object name.*:/.test(msg) ||
      /fatal: path/.test(msg)) return null;
  throw new Error(`git show ${spec} failed: ${msg.trim()}`);
}

function componentsAt(ref) {
  const raw = readAt(ref, VENDOR_PREFIX + 'UPSTREAM.json');
  if (raw === null) throw new Error(`UPSTREAM.json is absent at ${refLabel(ref)}`);
  return JSON.parse(raw).components;
}

function sectionsAt(ref, comp) {
  const raw = readAt(ref, `${VENDOR_PREFIX}patches/${comp}.diff`);
  if (raw === null) return new Map();
  return parseDiff(raw, `patches/${comp}.diff@${refLabel(ref)}`);
}

// ---------- the three layers ----------

class Report {
  constructor() { this.failures = []; this.notes = []; this.checked = 0; }
  fail(msg) { this.failures.push(msg); process.stdout.write(`patchcheck: FAIL ${msg}\n`); }
  note(msg) { this.notes.push(msg); process.stdout.write(`patchcheck: note ${msg}\n`); }
}

// FRAME + MANIFEST over the working tree.
function checkStanding(rep) {
  const comps = componentsAt(WORKTREE);
  const vendorDir = path.join(REPO_ROOT, VENDOR_PREFIX);
  // Every patches/*.diff must name a component update.sh will apply.
  for (const f of fs.readdirSync(path.join(vendorDir, 'patches'))) {
    if (!f.endsWith('.diff')) continue;
    const c = f.slice(0, -'.diff'.length);
    if (!comps[c]) rep.fail(`patches/${f} names no component in UPSTREAM.json — update.sh will never apply it`);
  }
  const manifestPath = path.join(vendorDir, 'patches', MANIFEST_NAME);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { rep.fail(`patches/${MANIFEST_NAME}: ${e.code === 'ENOENT' ? 'missing' : e.message} — regenerate with --write-manifest after verifying the tree`); }

  const residuals = {}; // comp -> { path -> sha }
  for (const comp of Object.keys(comps)) {
    let sections;
    try { sections = sectionsAt(WORKTREE, comp); }
    catch (e) { rep.fail(e.message); continue; }
    residuals[comp] = {};
    for (const [file, section] of sections) {
      rep.checked++;
      const content = readAt(WORKTREE, `${VENDOR_PREFIX}${comp}/${file}`);
      const r = reverseApply(section, content);
      if (!r.ok) { rep.fail(`${comp}/${file}: patches/${comp}.diff does not frame the tree: ${r.err}`); continue; }
      residuals[comp][file] = sha256(r.pristine);
    }
  }
  if (manifest) {
    for (const comp of Object.keys(comps)) {
      const want = (manifest.components || {})[comp] || {};
      const got = residuals[comp] || {};
      for (const file of Object.keys(want)) {
        if (!(file in got)) rep.fail(`${comp}/${file}: in patches/${MANIFEST_NAME} but patches/${comp}.diff has no section for it`);
        else if (want[file] !== got[file]) rep.fail(`${comp}/${file}: pristine residual ${got[file].slice(0, 12)}… does not match the recorded ${String(want[file]).slice(0, 12)}… — a patched file changed without its patch record (or the record changed what it reduces to); if intentional, regenerate with --write-manifest`);
      }
      for (const file of Object.keys(got)) {
        if (!(file in want)) rep.fail(`${comp}/${file}: has a patch section but no entry in patches/${MANIFEST_NAME} — regenerate with --write-manifest`);
      }
    }
    for (const comp of Object.keys(manifest.components || {})) {
      if (!comps[comp]) rep.fail(`patches/${MANIFEST_NAME} names unknown component '${comp}'`);
    }
  }
  return residuals;
}

function writeManifest() {
  const rep = new Report();
  const comps = componentsAt(WORKTREE);
  const out = { components: {} };
  let n = 0;
  for (const comp of Object.keys(comps)) {
    const sections = sectionsAt(WORKTREE, comp);
    if (!sections.size) continue;
    out.components[comp] = {};
    for (const [file, section] of [...sections].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      const content = readAt(WORKTREE, `${VENDOR_PREFIX}${comp}/${file}`);
      const r = reverseApply(section, content);
      if (!r.ok) { rep.fail(`${comp}/${file}: ${r.err} — fix the record first; refusing to write a manifest over a diff that does not apply`); continue; }
      out.components[comp][file] = sha256(r.pristine);
      n++;
    }
  }
  if (rep.failures.length) return 1;
  out.comment = 'sha256 of reverse_apply(patches/<c>.diff section, committed file) for every patched file — the pristine content each section claims to sit on ("absent" = the section creates the file). Checked offline by patchcheck.mjs on every gate run; validated against real upstream by update.sh --check on its cadence (README.md "Updating"). Regenerate with `node vendor/netsurf/patchcheck.mjs --write-manifest` ONLY for an intentional residual change: a pin bump, a generator/relativize change, or a file gaining/losing a section.';
  const p = path.join(REPO_ROOT, VENDOR_PREFIX, 'patches', MANIFEST_NAME);
  fs.writeFileSync(p, JSON.stringify(out, null, 1) + '\n');
  process.stdout.write(`patchcheck: wrote ${n} residual hash(es) to ${path.relative(REPO_ROOT, p)}\n`);
  return 0;
}

// DIFFERENTIAL between two refs (old → new).
function checkDifferential(rep, refOld, refNew) {
  let compsOld, compsNew;
  try { compsOld = componentsAt(refOld); compsNew = componentsAt(refNew); }
  catch (e) { rep.fail(`differential ${refLabel(refOld)} → ${refLabel(refNew)}: ${e.message}`); return; }

  // Changed paths under vendor/netsurf between the refs.
  let args;
  if (refNew === INDEX) args = ['diff', '--cached', '--name-only', '--no-renames', refOld, '--', VENDOR_PREFIX];
  else if (refNew === WORKTREE) args = ['diff', '--name-only', '--no-renames', refOld, '--', VENDOR_PREFIX];
  else args = ['diff', '--name-only', '--no-renames', refOld, refNew, '--', VENDOR_PREFIX];
  const r = git(args);
  if (r.status !== 0) { rep.fail(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`); return; }
  const changed = new Set(r.stdout.split('\n').filter(Boolean));
  if (refNew === WORKTREE) {
    const u = git(['ls-files', '--others', '--exclude-standard', '--', VENDOR_PREFIX]);
    if (u.status === 0) for (const p of u.stdout.split('\n').filter(Boolean)) changed.add(p);
  }

  const allComps = new Set([...Object.keys(compsOld), ...Object.keys(compsNew)]);
  for (const comp of allComps) {
    const pinOld = compsOld[comp] && compsOld[comp].rev;
    const pinNew = compsNew[comp] && compsNew[comp].rev;
    const compChanged = [...changed].some(p =>
      p.startsWith(`${VENDOR_PREFIX}${comp}/`) || p === `${VENDOR_PREFIX}patches/${comp}.diff`);
    if (pinOld !== pinNew) {
      if (compChanged || pinOld === undefined || pinNew === undefined) {
        rep.note(`${comp}: UPSTREAM.json pin changed (${pinOld && pinOld.slice(0, 12)} → ${pinNew && pinNew.slice(0, 12)}) — differential skipped; run update.sh --check to validate the new base`);
      }
      continue;
    }
    if (!compChanged) continue;

    let sectionsOld, sectionsNew;
    try { sectionsOld = sectionsAt(refOld, comp); sectionsNew = sectionsAt(refNew, comp); }
    catch (e) { rep.fail(e.message); continue; }

    const files = new Set();
    for (const p of changed) {
      if (!p.startsWith(`${VENDOR_PREFIX}${comp}/`)) continue;
      const rel = p.slice(`${VENDOR_PREFIX}${comp}/`.length);
      if (rel === 'lib.json') continue; // preserved by update.sh's install, not upstream-derived
      files.add(rel);
    }
    for (const f of new Set([...sectionsOld.keys(), ...sectionsNew.keys()])) {
      const a = sectionsOld.get(f), b = sectionsNew.get(f);
      if ((a && a.text) !== (b && b.text)) files.add(f);
    }

    for (const file of files) {
      rep.checked++;
      const rel = `${VENDOR_PREFIX}${comp}/${file}`;
      const res = {};
      let bad = false;
      for (const [side, ref, sections] of [['old', refOld, sectionsOld], ['new', refNew, sectionsNew]]) {
        const content = readAt(ref, rel);
        const section = sections.get(file);
        if (!section) { res[side] = content; continue; } // no section: residual IS the file
        const rr = reverseApply(section, content);
        if (!rr.ok) {
          rep.fail(`${comp}/${file} (${refLabel(ref)}): patches/${comp}.diff does not frame its tree: ${rr.err}`);
          bad = true;
          continue;
        }
        res[side] = rr.pristine;
      }
      if (bad) continue;
      if (res.old !== res.new) {
        const oldAbs = res.old === null || res.old === undefined;
        const newAbs = res.new === null || res.new === undefined;
        let detail;
        if (oldAbs && !newAbs) detail = 'a file appeared that no patch section creates — the next update.sh run will destroy it';
        else if (!oldAbs && newAbs) detail = 'a pristine-derived file disappeared without a deletion section — the next update.sh run will resurrect it';
        else detail = 'the tree change is not fully mirrored in the patch record (or the record changed more than the tree)';
        rep.fail(`${comp}/${file}: pristine residual differs between ${refLabel(refOld)} and ${refLabel(refNew)} — ${detail}`);
      }
    }
  }
}

// ---------- CLI ----------

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

  const repo = val('--repo');
  if (repo) { REPO_ROOT = path.resolve(repo); repoOverridden = true; }

  if (has('--write-manifest')) process.exit(writeManifest());

  const rep = new Report();
  const commit = val('--commit');
  const against = val('--against');

  if (commit) {
    checkDifferential(rep, `${commit}^`, commit);
  } else if (has('--staged')) {
    checkStanding(rep);
    checkDifferential(rep, 'HEAD', INDEX);
  } else if (against) {
    checkStanding(rep);
    checkDifferential(rep, against, WORKTREE);
  } else {
    checkStanding(rep);
    // Dirty under vendor/netsurf? Then also prove the change differentially.
    const d = git(['status', '--porcelain', '--', VENDOR_PREFIX]);
    if (d.status !== 0) {
      // A scratch --repo tree need not be a git repo; the real one must be.
      if (!repoOverridden) rep.fail(`git status failed in ${REPO_ROOT}: ${(d.stderr || '').trim()}`);
    } else if (d.stdout.trim()) {
      checkDifferential(rep, 'HEAD', WORKTREE);
    }
  }

  const n = rep.failures.length;
  process.stdout.write(`patchcheck: ${rep.checked} file check(s), ${n} failure(s)${rep.notes.length ? `, ${rep.notes.length} note(s)` : ''}\n`);
  process.exit(n ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
