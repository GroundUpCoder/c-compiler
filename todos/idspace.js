#!/usr/bin/env node
// todos/idspace.js — the cross-ref id allocator for todos/ (todos/0358).
//
// Both id spaces in todos/ are allocated by LANES: a lane branches, files a
// ticket (`todos/NNNN-*.md`) and/or a liability entry (`### Lnn` in
// todos/LIABILITIES.md), and pushes at the END. So the highest id visible on
// any ONE ref — including origin/main — is a LOWER BOUND on the id space, not
// the id space. Deriving "next" from the working tree is therefore wrong by
// construction whenever two lanes are live, which is the normal case here.
//
// It has already cost us twice, and both lanes were correct when they
// allocated: 0318 and 0338 each took 0354 (renumbered to 0356 at merge), and
// the register collided the same way with two different L44 entries (0356's
// side renumbered to L46). A renumber at merge is not free — the id is
// referenced from the ticket body, queue.json, the register's `ticket:` field
// and the lane's dev log.
//
// This module answers the question the shell one-liner in todos/0358 answers,
// but reading TREES rather than diffs, which is load-bearing: the obvious
// cheap form
//
//     git log --all -p -- todos/LIABILITIES.md | grep '^+### L'
//
// MISSES ids introduced by a merge commit, because `git log -p` prints no diff
// for merges by default. Verified on this repo: it reports L45 as the maximum
// while origin/main's register carries L46 — the very entry a renumber landed
// during a merge. A survey that reads each ref's tree cannot have that hole.
//
// Zero dependencies (Node built-ins only), matching todos/queue.js.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// Thrown when the survey cannot see the refs at all. Deliberately NOT a silent
// degradation to the working tree: an allocator whose whole purpose is
// cross-ref visibility must not quietly become the thing it replaced. See
// `todos/0358` item 4 and the reasoning in the dev log.
class IdSpaceError extends Error {}

const TICKET_FILE_RE = /^(\d{4})-.*\.md$/;      // matched on the BASENAME — a
                                                // path-anchored form misses
                                                // todos/done/ (todos/0358 (1)).
const LIABILITY_HEADING_RE = /^###\s+L(\d+)\s+—/;

// ---------- git plumbing ----------

function git(root, args, opts) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...opts,
  });
}

// Every ref that could carry another lane's allocation, plus HEAD (which
// for-each-ref does not list, and which is the only ref a detached checkout
// has).
//
// GAP: a remote-tracking ref is only as fresh as the last `git fetch`, and
// nothing here checks when that was — a lane that has not fetched still
// allocates from a stale bound (todos/0360, register L47). Every caller
// therefore prints what it surveyed, which is a reminder, not a guard.
function refNames(root) {
  let out;
  try {
    out = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  } catch (e) {
    throw new IdSpaceError(`cannot enumerate refs in ${root}: ${e.message.trim().split('\n')[0]}`);
  }
  const refs = out.split('\n').map(s => s.trim()).filter(Boolean);
  try {
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    refs.push('HEAD');
  } catch { /* unborn HEAD (a fresh `git init`) — nothing to read there */ }
  return refs;
}

// Resolve `<ref>:<relPath>` for every ref in ONE `git cat-file --batch-check`,
// and group the refs by the object they landed on. Most refs share a tree, so
// the caller reads each distinct object once. Refs where the path is absent
// are simply omitted (an old branch predating todos/, a tag from before the
// register existed) — that is a legitimately empty contribution, not an error.
function objectsAtRefs(root, refs, relPath) {
  if (!refs.length) return new Map();
  const input = refs.map(r => `${r}:${relPath}\n`).join('');
  let out;
  try {
    out = git(root, ['cat-file', '--batch-check'], { input });
  } catch (e) {
    throw new IdSpaceError(`cannot resolve ${relPath} across refs in ${root}: ${e.message.trim().split('\n')[0]}`);
  }
  // One output line per input line, in order — including the miss form, so the
  // positional pairing below holds. Only a trailing newline is stripped;
  // filtering blanks anywhere else would silently shift the pairing.
  const lines = out.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const byOid = new Map(); // oid -> [refname]
  lines.forEach((line, i) => {
    // "<oid> <type> <size>" on a hit; "<input> missing" (older git: "missing")
    // on a miss. Positional, because the miss form does not echo an oid.
    const parts = line.split(/\s+/);
    const oid = parts[0];
    if (!/^[0-9a-f]{40,64}$/.test(oid)) return;
    const ref = refs[i];
    if (!byOid.has(oid)) byOid.set(oid, []);
    byOid.get(oid).push(ref);
  });
  return byOid;
}

// ---------- the two surveys ----------

// Shape shared by both: { ids: Map<number, string>, refs, objects, local }.
// `ids` maps the numeric id to a human label for where it was first seen, so a
// caller can say WHERE the competing allocation lives — the fact a lane
// actually needs when the number it expected is already taken.

function surveyTickets(root, localIds) {
  const refs = refNames(root);
  const byTree = objectsAtRefs(root, refs, 'todos');
  const ids = new Map();
  for (const [tree, treeRefs] of byTree) {
    let listing;
    try { listing = git(root, ['ls-tree', '-r', '--name-only', tree]); }
    catch (e) { throw new IdSpaceError(`cannot list todos/ at ${treeRefs[0]}: ${e.message.trim().split('\n')[0]}`); }
    for (const rel of listing.split('\n')) {
      const hit = TICKET_FILE_RE.exec(path.basename(rel.trim()));
      if (hit && !ids.has(Number(hit[1]))) ids.set(Number(hit[1]), treeRefs[0]);
    }
  }
  for (const id of localIds) if (!ids.has(Number(id))) ids.set(Number(id), 'the working tree');
  return { ids, refs: refs.length, objects: byTree.size };
}

function surveyLiabilities(root, localIds) {
  const refs = refNames(root);
  const byBlob = objectsAtRefs(root, refs, 'todos/LIABILITIES.md');
  const ids = new Map();
  for (const [blob, blobRefs] of byBlob) {
    let text;
    try { text = git(root, ['cat-file', 'blob', blob]); }
    catch (e) { throw new IdSpaceError(`cannot read the register at ${blobRefs[0]}: ${e.message.trim().split('\n')[0]}`); }
    for (const line of text.split('\n')) {
      const hit = LIABILITY_HEADING_RE.exec(line);
      if (hit && !ids.has(Number(hit[1]))) ids.set(Number(hit[1]), blobRefs[0]);
    }
  }
  for (const id of localIds) if (!ids.has(Number(id))) ids.set(Number(id), 'the working tree');
  return { ids, refs: refs.length, objects: byBlob.size };
}

// ---------- allocation ----------

// `format` renders a numeric id; `noun`/`unit` name the space in the note.
const SPACES = {
  ticket: {
    noun: 'ticket', unit: 'todos trees', survey: surveyTickets,
    format: (n) => String(n).padStart(4, '0'),
  },
  liability: {
    noun: 'liability', unit: 'register revisions', survey: surveyLiabilities,
    format: (n) => `L${String(n).padStart(2, '0')}`,
  },
};

// Allocate the next id in `kind`, surveying every ref plus the caller's
// working-tree ids. Returns { id, note, max, refs, objects, from }.
//
// Refuses (throws IdSpaceError) when git cannot be reached at all. `local:
// true` is the explicit opt-out: it takes the working-tree bound and SAYS in
// the note that that is all it saw.
function allocate(kind, localIds, opts = {}) {
  const space = SPACES[kind];
  if (!space) throw new IdSpaceError(`unknown id space "${kind}"`);
  const root = opts.root || REPO_ROOT;
  const local = [...localIds].map(Number).filter(Number.isFinite);

  const bump = (max) => space.format(max + 1);

  if (opts.local) {
    const max = local.reduce((a, b) => Math.max(a, b), 0);
    return {
      id: bump(max), max, refs: 0, objects: 0, from: 'the working tree',
      note: `${space.noun} id ${bump(max)} — WORKING TREE ONLY (--local): no ref was surveyed, so this ` +
        `id is a lower bound and may already be taken on another lane's branch`,
    };
  }

  let survey;
  try {
    survey = space.survey(root, local);
  } catch (e) {
    if (!(e instanceof IdSpaceError)) throw e;
    throw new IdSpaceError(
      `${e.message}\n` +
      `  Refusing to allocate a ${space.noun} id from the working tree alone: that is exactly how 0354 and\n` +
      `  L44 were each assigned twice. Fix the repo (run this inside the checkout), pass an explicit id,\n` +
      `  or accept the lower bound deliberately with --local.`);
  }

  let max = 0;
  let from = 'nothing — this id space is empty';
  for (const [n, where] of survey.ids) if (n > max) { max = n; from = where; }
  const id = bump(max);
  const seen = survey.refs === 0
    ? 'no refs (this repo has no history yet)'
    : `${survey.refs} ref(s) / ${survey.objects} ${space.unit}`;
  return {
    id, max, refs: survey.refs, objects: survey.objects, from,
    note: `${space.noun} id ${id} — derived across ${seen} + the working tree ` +
      `(highest existing: ${max ? `${space.format(max)} on ${from}` : 'none'}). ` +
      `Remote refs are as fresh as your last fetch.`,
  };
}

module.exports = { allocate, surveyTickets, surveyLiabilities, IdSpaceError, REPO_ROOT };
