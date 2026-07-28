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
// The survey answers "what ids exist?"; todos/0360 added the second question a
// caller needs and never asked — "how stale is what I just surveyed?". See the
// freshness section below.
//
// Zero dependencies (Node built-ins only), matching todos/queue.js.
'use strict';

const fs = require('fs');
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
// has). How fresh `refs/remotes/*` is here is measured, not assumed — see the
// freshness section (todos/0360).
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

// ---------- how stale is the survey? (todos/0360) ----------
//
// 0358 shipped the cross-ref survey with a printed DISCLAIMER — `Remote refs
// are as fresh as your last fetch` — and the gap it disclaimed fired the same
// day: the master, mid-merge in the main tree, assigned L47/L48 in an
// UNCOMMITTED working tree at the moment this module's own lane allocated L47
// off the refs and pushed. Neither could see the other. A true sentence in the
// output is not a check; it reads as known-and-handled, which is the whole
// thesis of todos/LIABILITIES.md. So the survey now MEASURES its staleness:
//
//   1. WHEN did this clone last look at the remote — local, free, a lower
//      bound (below).
//   2. WOULD a fetch move anything — `git ls-remote`, authoritative, a network
//      call, so timed out and degrading LOUDLY (never silently to (1)).
//   3. WHO holds an id that is on no ref at all — every sibling worktree of
//      this clone is read from disk, which covers the incident above exactly.
//
// RESIDUAL, stated plainly rather than implied away: an id that exists only in
// a DIFFERENT CLONE and has not been pushed is invisible to all three — no
// fetch can show it and no local scan can reach it. Closing that needs a
// coordination point (a pushed reservation ref), which is todos/0364, register
// L52; until then the guarantee is "authoritative over everything pushed, plus
// this clone's uncommitted trees", and that is what the printed line says.

const PROBE_TIMEOUT_MS = 5000;          // an allocator that hangs on a flaky
                                        // network is worse than one that is
                                        // honestly stale (todos/0360).
const REFRESH_WARN_MS = 60 * 60 * 1000; // only consulted when the probe did not
                                        // run: the probe is authoritative, so a
                                        // day-old FETCH_HEAD it says is current
                                        // must NOT nag.

function humanAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function gitCommonDir(root) {
  // Relative (`.git`) at the top of a main tree, absolute in a linked worktree.
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
}

// When did this clone last SEE the remote? Two lower bounds, maxed:
//
//   - FETCH_HEAD's mtime. git rewrites it on every fetch even when nothing
//     moved — but it is PER-WORKTREE ($GIT_DIR/FETCH_HEAD) while the
//     remote-tracking refs it updates are SHARED, so a fetch in the main tree
//     leaves a worktree's copy absent. Reading one worktree's FETCH_HEAD would
//     therefore report "never fetched" in every fresh worktree — a false alarm,
//     and a check that cries wolf is a check nobody reads. All the copies are
//     maxed together instead.
//   - the newest reflog mtime under logs/refs/remotes, which IS shared but only
//     moves when a ref actually changed.
//
// Both UNDERSTATE freshness and neither can overstate it, so the verdict errs
// toward "might be stale" — the probe is what settles it.
function lastRefresh(root) {
  let common;
  try { common = gitCommonDir(root); } catch { return { at: null, source: null }; }
  const cands = [];
  const add = (at, source) => { if (at !== null) cands.push({ at, source }); };
  add(mtimeMs(path.join(common, 'FETCH_HEAD')), 'FETCH_HEAD');
  let wts = [];
  try { wts = fs.readdirSync(path.join(common, 'worktrees')); } catch { /* no linked worktrees */ }
  for (const w of wts) add(mtimeMs(path.join(common, 'worktrees', w, 'FETCH_HEAD')), `FETCH_HEAD of worktree ${w}`);
  let newestLog = null;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const m = mtimeMs(p);
      if (m !== null && (newestLog === null || m > newestLog)) newestLog = m;
    }
  })(path.join(common, 'logs', 'refs', 'remotes'));
  add(newestLog, 'a remote-tracking reflog');
  if (!cands.length) return { at: null, source: null };
  return cands.reduce((a, b) => (b.at > a.at ? b : a));
}

// The lane's own newest commit. `committed since you last looked` is the
// staleness that actually matters offline: it means the world moved on for at
// least as long as you have been working, unobserved.
function newestLocalCommit(root) {
  try {
    const out = git(root, ['for-each-ref', '--sort=-committerdate', '--count=1',
                           '--format=%(committerdate:unix)', 'refs/heads']);
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n * 1000 : null;
  } catch { return null; }
}

// Non-interactive git: a credential or host-key prompt would turn "the
// allocator checks its freshness" into "the allocator hangs forever".
// Pre-set values win — someone who configured ssh deliberately keeps it.
function probeEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  if (!env.GIT_ASKPASS) env.GIT_ASKPASS = 'echo';
  return env;
}

// Would a fetch move anything? Compares the remote's advertised refs against
// this clone's remote-tracking view. Only the dangerous direction is reported:
// a ref the REMOTE has that we have not seen (or see at another commit). A
// local remote-tracking ref for a branch deleted upstream is not staleness —
// it can only make the survey over-count, never under-count.
function probeRemote(root, remote, timeoutMs) {
  let out;
  try {
    out = git(root, ['ls-remote', '--heads', '--tags', remote],
              { timeout: timeoutMs, env: probeEnv() });
  } catch (e) {
    // A killed child is the timeout: execFileSync reports it as signal SIGTERM
    // with a null status, NOT as an error message.
    const reason = (e.killed || e.signal)
      ? `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`
      : (String(e.stderr || e.message).trim().split('\n').filter(Boolean).pop() || 'git ls-remote failed');
    return { status: 'failed', remote, reason };
  }
  const local = new Map();
  try {
    const listing = git(root, ['for-each-ref', '--format=%(objectname) %(refname)',
                               `refs/remotes/${remote}`, 'refs/tags']);
    for (const line of listing.split('\n')) {
      const [oid, name] = line.trim().split(' ');
      if (oid && name) local.set(name, oid);
    }
  } catch { /* handled as "we have nothing" — every remote ref reads unseen */ }

  const unseen = [];
  for (const line of out.split('\n')) {
    const hit = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (!hit) continue;
    const [, oid, name] = hit;
    if (name.endsWith('^{}')) continue;          // the peeled half of an annotated tag
    // refs/heads/X is tracked at refs/remotes/<remote>/X; tags are not
    // namespaced per remote, so they compare against themselves.
    const at = name.startsWith('refs/heads/')
      ? `refs/remotes/${remote}/${name.slice('refs/heads/'.length)}`
      : name;
    if (local.get(at) !== oid) unseen.push({ ref: name, at, have: local.get(at) || null });
  }
  return unseen.length ? { status: 'stale', remote, unseen } : { status: 'fresh', remote };
}

// One freshness verdict per (root, mode) per process: `next-id` allocates in
// BOTH id spaces and must not pay for (or print) two probes.
const _freshCache = new Map();

// { level: 'ok'|'warn'|'stale', line, probe, refreshedAt, ageMs, workedSince }
//
// `level` is POLICY-FREE on purpose: this module measures, the caller decides.
// queue.js refuses to WRITE an id on 'stale' (proof) and only warns on 'warn'
// (ignorance) — refuse on proof, warn on doubt.
function freshness(root, opts = {}) {
  if (opts.noCache) return computeFreshness(root, opts);   // the tests move the clock
  const key = `${root} ${opts.offline ? 'offline' : 'probe'}`;
  if (_freshCache.has(key)) return _freshCache.get(key);
  const v = computeFreshness(root, opts);
  _freshCache.set(key, v);
  return v;
}

function computeFreshness(root, opts) {
  const timeoutMs = Number.isFinite(opts.probeTimeoutMs) ? opts.probeTimeoutMs : PROBE_TIMEOUT_MS;
  const refreshed = lastRefresh(root);
  const ageMs = refreshed.at === null ? null : Math.max(0, Date.now() - refreshed.at);
  const newest = newestLocalCommit(root);
  const workedSince = refreshed.at !== null && newest !== null && newest > refreshed.at;

  let remotes = [];
  try { remotes = git(root, ['remote']).split('\n').map(s => s.trim()).filter(Boolean); }
  catch { /* not a repo — the survey itself will have refused already */ }

  let probe = { status: 'none' };
  if (remotes.length && opts.offline) probe = { status: 'skipped' };
  else if (remotes.length) {
    probe = { status: 'fresh', remote: remotes.join(', ') };
    for (const r of remotes) {
      const p = probeRemote(root, r, timeoutMs);
      if (p.status !== 'fresh') { probe = p; break; }
    }
  }

  const clock = refreshed.at === null
    ? 'this clone has NEVER fetched'
    : `last refreshed ${humanAge(ageMs)} ago (${refreshed.source})`;
  const clockWarns = refreshed.at === null || ageMs > REFRESH_WARN_MS || workedSince;
  const worked = workedSince ? ' — and you have COMMITTED since then' : '';

  let level, line;
  if (probe.status === 'none') {
    level = 'ok';
    line = 'freshness: no remote is configured, so every ref surveyed is local — nothing to be stale about.';
  } else if (probe.status === 'fresh') {
    level = 'ok';
    line = `freshness: ${probe.remote} advertises nothing this survey has not seen (git ls-remote) — ` +
      'a fetch would move nothing. Unpushed ids in another CLONE remain invisible (todos/0364).';
  } else if (probe.status === 'stale') {
    level = 'stale';
    const names = probe.unseen.map(u => u.ref).slice(0, 3).join(', ');
    const more = probe.unseen.length > 3 ? ` +${probe.unseen.length - 3} more` : '';
    line = `freshness: STALE — ${probe.remote} carries ${probe.unseen.length} ref(s) this survey never saw ` +
      `(${names}${more}). Run \`git fetch\` and re-run: the id above is a LOWER BOUND, which is exactly ` +
      'how 0354 and L44 were each handed out twice.';
  } else if (probe.status === 'failed') {
    level = 'warn';
    line = `freshness: PROBE FAILED (${probe.remote}: ${probe.reason}) — falling back to the local clock: ` +
      `${clock}${worked}. This survey CANNOT be shown current either way; fetch before you trust the id.`;
  } else { // skipped
    level = clockWarns ? 'warn' : 'ok';
    line = `freshness: probe SKIPPED (--offline) — local clock only: ${clock}${worked}.` +
      (clockWarns ? ' Treat the id above as a lower bound until you fetch.' : '');
  }
  return { level, line, probe, refreshedAt: refreshed.at, refreshedFrom: refreshed.source, ageMs, workedSince };
}

// ---------- ids that are on no ref at all ----------

// Every OTHER worktree of this clone. A linked worktree's working tree is on no
// ref until it commits, and that is the incident that filed todos/0360: an
// uncommitted merge resolution in the main tree assigning L47 while a worktree
// allocated L47 off the refs. Sibling worktrees share the common git dir, so
// `git worktree list` sees all of them from any one of them.
function otherWorktrees(root) {
  let out;
  try { out = git(root, ['worktree', 'list', '--porcelain']); }
  catch { return []; }   // not a repo / ancient git — the refs are still surveyed
  const found = [];
  let cur = null, prunable = false;
  const flush = () => { if (cur) found.push({ path: cur, prunable }); };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); cur = line.slice('worktree '.length).trim(); prunable = false; }
    else if (line.startsWith('prunable')) prunable = true;
  }
  flush();
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(root);
  return found.filter(w => !w.prunable && real(w.path) && real(w.path) !== self);
}

function worktreeTicketIds(wtPath) {
  const ids = [];
  for (const dir of [path.join(wtPath, 'todos'), path.join(wtPath, 'todos', 'done')]) {
    let ents;
    try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const name of ents) {
      const hit = TICKET_FILE_RE.exec(name);
      if (hit) ids.push(Number(hit[1]));
    }
  }
  return ids;
}

function worktreeLiabilityIds(wtPath) {
  let text;
  try { text = fs.readFileSync(path.join(wtPath, 'todos', 'LIABILITIES.md'), 'utf8'); } catch { return []; }
  const ids = [];
  for (const line of text.split('\n')) {
    const hit = LIABILITY_HEADING_RE.exec(line);
    if (hit) ids.push(Number(hit[1]));
  }
  return ids;
}

// Fold the sibling worktrees into an ids map. Called AFTER the refs and the
// caller's own working tree, so an id that is committed somewhere keeps its ref
// label and only a genuinely uncommitted one is labelled by worktree path.
function addWorktreeIds(root, ids, read) {
  const wts = otherWorktrees(root);
  for (const w of wts) {
    for (const id of read(w.path)) if (!ids.has(id)) ids.set(id, `${w.path} (uncommitted)`);
  }
  return wts.length;
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
  const worktrees = addWorktreeIds(root, ids, worktreeTicketIds);
  return { ids, refs: refs.length, objects: byTree.size, worktrees };
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
  const worktrees = addWorktreeIds(root, ids, worktreeLiabilityIds);
  return { ids, refs: refs.length, objects: byBlob.size, worktrees };
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

// Allocate the next id in `kind`, surveying every ref, every sibling
// worktree's uncommitted tree, and the caller's own working-tree ids. Returns
// { id, note, max, refs, objects, worktrees, from, freshness, stale }.
//
// Refuses (throws IdSpaceError) when git cannot be reached at all. `local:
// true` is the explicit opt-out: it takes the working-tree bound and SAYS in
// the note that that is all it saw. `offline: true` keeps the survey but skips
// the network probe — and says THAT too (todos/0360).
function allocate(kind, localIds, opts = {}) {
  const space = SPACES[kind];
  if (!space) throw new IdSpaceError(`unknown id space "${kind}"`);
  const root = opts.root || REPO_ROOT;
  const local = [...localIds].map(Number).filter(Number.isFinite);

  const bump = (max) => space.format(max + 1);

  if (opts.local) {
    const max = local.reduce((a, b) => Math.max(a, b), 0);
    return {
      id: bump(max), max, refs: 0, objects: 0, worktrees: 0, from: 'the working tree', stale: false,
      freshness: { level: 'warn', probe: { status: 'skipped' },
        line: 'freshness: NOT MEASURED — --local surveyed no ref and probed no remote.' },
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
  const sibs = survey.worktrees ? ` + ${survey.worktrees} sibling worktree(s)` : '';
  // The measurement that replaced 0358's `Remote refs are as fresh as your last
  // fetch.` — the disclaimer that was true, unchecked, and collided anyway.
  const fresh = freshness(root, opts);
  return {
    id, max, refs: survey.refs, objects: survey.objects, worktrees: survey.worktrees, from,
    freshness: fresh, stale: fresh.level === 'stale',
    note: `${space.noun} id ${id} — derived across ${seen}${sibs} + the working tree ` +
      `(highest existing: ${max ? `${space.format(max)} on ${from}` : 'none'}).`,
  };
}

module.exports = {
  allocate, surveyTickets, surveyLiabilities, freshness, otherWorktrees,
  IdSpaceError, REPO_ROOT, PROBE_TIMEOUT_MS, REFRESH_WARN_MS,
};
