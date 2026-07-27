#!/usr/bin/env node
// todos/queue.js — the ordering-manifest CLI + validator for the work queue.
//
// The order of attack and the hard/soft dependency split live in
// todos/queue.json (the manifest); the per-item todos/NNNN-<slug>.md files stay
// the source of truth for everything else (title, status, body). Dependency
// ids live ONLY in the manifest — open items must not carry a structured
// `- **Depends**:` line (the check below enforces this); dependency
// *rationale* belongs in the item's body prose.
// This script is the SINGLE WRITER of queue.json and the validator that keeps
// the manifest and the filesystem consistent, so agents and humans mutate the
// queue through one checked interface instead of hand-editing two files in sync.
// The netguc/cc Todos tab reads the same queue.json (design:
// netguc/cc/docs/todos-queue-manifest.md).
//
//   node todos/queue.js list                         # effective order + ready/blocked state
//   node todos/queue.js add <NNNN|next> [--slug s] [--title t] \
//                        [--after A,B] [--blocked-by A,B] [--pos N] \
//                        [--priority 0..3] [--reflection]
//   node todos/queue.js set-priority <ID> <0..3>     # P0 urgent … P3 background; 1 = default
//   node todos/queue.js reorder <ID> --before <ID> | --after <ID> | --pos <N>
//   node todos/queue.js done <ID>                    # git-mv to done/, drop from queue
//   node todos/queue.js block <ID> [--hard A,B] [--soft C,D]
//   node todos/queue.js check [--fix]                # validate; exit non-zero on failure
//                                                    # --fix: list unlisted open items,
//                                                    #   rewrite done/ Status lines saying "open"
//
// `-h`/`--help` anywhere prints usage and exits 0 (checked before dispatch, so
// `add --help` can never scaffold an item); an unknown `--flag` on any
// subcommand is a usage error (exit 2, nothing written).
//
// Priority: each entry may carry an optional integer `priority` 0..3 (P0 most
// urgent, P3 background). Absent means P1, the default; the field is omitted
// at P1 to keep entries minimal. The EFFECTIVE order of attack is a stable
// sort by priority then array position — array order is still the only order
// within a bucket, and the array is never rewritten when a priority changes
// (the sort happens at read time, here and in the cc Todos tab).
//
// Zero dependencies (Node built-ins only), matching the repo's tools/ ethos.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const LIABILITIES = require('./liabilities.js');

const TODOS_DIR = __dirname;
const REPO_ROOT = path.resolve(TODOS_DIR, '..');
const DONE_DIR = path.join(TODOS_DIR, 'done');
const QUEUE_PATH = path.join(TODOS_DIR, 'queue.json');

const TODO_FILE_RE = /^(\d{4})-.*\.md$/;
const ID_RE = /^\d{4}$/;

// ---------- small utils ----------

function die(msg) {
  process.stderr.write(`queue.js: ${msg}\n`);
  process.exit(1);
}

// Usage errors (unknown command/flag) exit 2, distinct from validation failures (1).
function usageDie(msg) {
  process.stderr.write(`queue.js: ${msg} (run queue.js --help for usage)\n`);
  process.exit(2);
}

// `queue.js list | head` must not crash: the consumer closing the pipe early
// surfaces as EPIPE on our next write — that's normal termination, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
}

function parseListFlag(v) {
  // "0057,0058" / "0057, 0058" -> ['0057','0058']; "" / "-" -> []
  if (v === undefined) return undefined;
  return v.split(',').map(s => s.trim()).filter(s => s && s !== '—' && s !== '-');
}

// Parse `add`/`reorder`/`block` style `--flag value` args into a map.
// `allowed` is the subcommand's flag allowlist: an unknown `--flag` is a usage
// error (exit 2) — the mutation commands must not guess what a typo meant.
function parseFlags(cmd, argv, allowed) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!allowed.includes(name)) usageDie(`${cmd}: unknown flag "--${name}"`);
      if (eq !== -1) {
        flags[name] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
        else flags[name] = true; // bare boolean flag
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------- filesystem scan ----------

function scanDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return new Map(); }
  const m = new Map(); // id -> fileName
  for (const name of names) {
    const mm = name.match(TODO_FILE_RE);
    if (mm) m.set(mm[1], name);
  }
  return m;
}

function scanFs() {
  return { open: scanDir(TODOS_DIR), done: scanDir(DONE_DIR) };
}

// ---------- the `- **Status**:` line (todos/0353) ----------
//
// The Status line is documentation, and until 0353 nothing validated it, so it
// drifted in BOTH directions: 35 tickets in todos/done/ still said "open", and
// 0117 sat at rank 1 of 91 at P0 with a Status line advertising an R2 that its
// own body recorded as landed. The cost is a lane spending a turn on finished
// work, so the cheap, decidable half of the line is checked below. The
// directory is still the source of truth for done-ness and queue.json for
// priority — these checks only stop the documentation from contradicting them.

// Matches the whole line; group 1 is the FIRST line after `Status:` — the unit
// statusOf() has always classified on, so every check here reads the same text.
const STATUS_RE = /^-\s*\*{0,2}Status\*{0,2}\s*:\s*(.*)$/mi;

// Leads with the word "open" — `open`, `Open (P1)`, `**open** — …` all do;
// `reopened`, `closed — was open until …` deliberately do not (the leading-
// token test is what keeps this decidable instead of prose-guessing).
const STATUS_OPEN_RE = /^([*_\s]*)open\b/i;

// A round heading the body records as finished: `## R2 — DONE 2026-07-28`,
// `## R1 — LANDED …`. Narrowly pattern-matched on purpose (0353 scope note):
// a checker that guesses at prose is worse than no checker.
const ROUND_DONE_RE = /^#{1,6}[ \t]*R(\d+)\b[^\n]*\b(?:DONE|LANDED)\b/gim;

// Words that claim a round is still ahead of us. Only meaningful when they sit
// in the SAME clause as the round they refer to (see statusContradictions).
const REMAINING_RE = /\b(?:remaining|remains?|pending|outstanding|unstarted|not started|to ?do|left)\b/i;

// Negated deferral. `statusOf` substring-tests the line for "deferred", so
// writing "un-deferred" here silently RE-DEFERS the ticket (the footgun
// documented in 0126). The classification is deliberately left alone — it is
// load-bearing for every other line — and the ambiguous phrasing is rejected
// instead, so the trap can no longer be sprung silently.
const NEGATED_DEFER_RE = /\b(?:un-?deferred|not deferred|no longer deferred|de-?deferred)\b/i;

// The first line after `Status:`, or null when the ticket carries no such line.
function statusLineOf(body) {
  const m = body.match(STATUS_RE);
  return m ? m[1] : null;
}

// Split a Status line into clauses so "R1 done, R2 remaining" doesn't read as
// "R1 remaining". Separators are the ones these lines actually use.
function statusClauses(line) {
  return line.split(/[;,]|—|--|·|\bwhile\b/i);
}

// (2) An OPEN ticket whose Status line claims a round is still to come while
// its own body carries a `## R<n> — DONE/LANDED` heading for that round.
// Returns a list of {round, clause} — empty when the line and body agree.
function statusContradictions(line, body) {
  const out = [];
  const clauses = statusClauses(line);
  ROUND_DONE_RE.lastIndex = 0;
  for (let m; (m = ROUND_DONE_RE.exec(body)); ) {
    const round = m[1];
    const named = new RegExp(`\\bR${round}\\b`, 'i');
    // Both signals must sit in ONE clause: naming the round and calling it
    // remaining in the same breath is the contradiction; naming it anywhere on
    // a line that also says something else is remaining is not.
    const clause = clauses.find(c => named.test(c) && REMAINING_RE.test(c));
    if (clause) out.push({ round, clause: clause.trim() });
  }
  return out;
}

// Rewrite a done/ ticket's leading "open" to "done", preserving the rest of the
// line verbatim (a trailing "(P1)" or a dated parenthetical is the author's
// text, not this script's to edit). Returns the new body, or null if no change.
function fixDoneStatusLine(body) {
  const m = body.match(STATUS_RE);
  if (!m || !STATUS_OPEN_RE.test(m[1])) return null;
  const fixed = m[0].replace(m[1], m[1].replace(STATUS_OPEN_RE, '$1done'));
  return body.slice(0, m.index) + fixed + body.slice(m.index + m[0].length);
}

function statusOf(id, openFiles) {
  const file = openFiles.get(id);
  if (!file) return 'unknown';
  let body;
  try { body = fs.readFileSync(path.join(TODOS_DIR, file), 'utf8'); }
  catch { return 'unknown'; }
  const line = statusLineOf(body);
  // Substring test, first line only — see NEGATED_DEFER_RE for the footgun this
  // shape carries and how check() defuses it. Behaviour intentionally unchanged.
  if (line !== null && /deferred/i.test(line)) return 'deferred';
  return 'open';
}

// ---------- manifest load / parse / format ----------

function loadManifestRaw() {
  let content;
  try { content = fs.readFileSync(QUEUE_PATH, 'utf8'); }
  catch { return null; }
  return content;
}

// Allowed difficulty tags (optional per entry; absent = untagged). A light-mode
// churn run in cc skips 'heavy' items. Kept in sync with cc's TODO_DIFFICULTIES.
const DIFFICULTIES = ['light', 'medium', 'heavy'];

// Parse + structurally validate the manifest JSON. Returns {manifest} or {error}.
// `manifest` keeps entries as a plain array so writes round-trip losslessly.
function parseManifest(content) {
  let data;
  try { data = JSON.parse(content); }
  catch (e) { return { error: `not valid JSON (${e.message})` }; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'top level must be a JSON object' };
  }
  if (data.version !== 1) return { error: `unsupported version ${JSON.stringify(data.version)} (expected 1)` };
  if (!Array.isArray(data.queue)) return { error: '"queue" must be an array' };
  const seen = new Set();
  for (const entry of data.queue) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: 'every "queue" entry must be an object' };
    }
    if (typeof entry.id !== 'string' || !entry.id) return { error: 'every "queue" entry needs a non-empty string "id"' };
    if (seen.has(entry.id)) return { error: `duplicate id "${entry.id}"` };
    seen.add(entry.id);
    for (const k of ['blockedBy', 'after']) {
      if (entry[k] !== undefined && (!Array.isArray(entry[k]) || entry[k].some(x => typeof x !== 'string'))) {
        return { error: `"${k}" for "${entry.id}" must be an array of strings` };
      }
    }
    if (entry.priority !== undefined
        && (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 3)) {
      return { error: `"priority" for "${entry.id}" must be an integer 0..3 (got ${JSON.stringify(entry.priority)})` };
    }
    if (entry.difficulty !== undefined && !DIFFICULTIES.includes(entry.difficulty)) {
      return { error: `"difficulty" for "${entry.id}" must be one of ${DIFFICULTIES.join('/')} (got ${JSON.stringify(entry.difficulty)})` };
    }
  }
  return { manifest: data };
}

// Diff-friendly serializer: one entry per line, `{ "id": ... }` shape.
function formatManifest(manifest) {
  const lines = manifest.queue.map(e => {
    let s = `    { "id": ${JSON.stringify(e.id)}`;
    if (e.priority !== undefined && e.priority !== 1) s += `, "priority": ${e.priority}`; // P1 is the default — omitted
    if (e.difficulty !== undefined) s += `, "difficulty": ${JSON.stringify(e.difficulty)}`; // untagged = field omitted
    if (e.blockedBy && e.blockedBy.length) s += `, "blockedBy": [${e.blockedBy.map(x => JSON.stringify(x)).join(', ')}]`;
    if (e.after && e.after.length) s += `, "after": [${e.after.map(x => JSON.stringify(x)).join(', ')}]`;
    s += ' }';
    return s;
  });
  return `{\n  "version": 1,\n  "queue": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

function writeManifest(manifest) {
  fs.writeFileSync(QUEUE_PATH, formatManifest(manifest));
}

// Load the manifest for a mutation; die loudly if it's absent or malformed.
function requireManifest() {
  const raw = loadManifestRaw();
  if (raw === null) die(`no ${path.relative(REPO_ROOT, QUEUE_PATH)} — nothing to operate on`);
  const res = parseManifest(raw);
  if (res.error) die(`${path.relative(REPO_ROOT, QUEUE_PATH)}: ${res.error}`);
  return res.manifest;
}

function entryFor(manifest, id) { return manifest.queue.find(e => e.id === id); }

// ---------- priority ----------

const DEFAULT_PRIORITY = 1;

function priorityOf(entry) {
  return entry.priority === undefined ? DEFAULT_PRIORITY : entry.priority;
}

// Validate a CLI-supplied priority value; die loudly on anything but 0..3.
function parsePriorityArg(v, context) {
  const n = (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    die(`${context}: priority must be an integer 0..3 (P0 most urgent, P1 default, P3 background), got ${JSON.stringify(v)}`);
  }
  return n;
}

// ---------- difficulty ----------

// Validate a CLI-supplied difficulty value; die loudly on anything but a known
// tag. The literal 'none'/'' clears the field (expresses "untagged").
function parseDifficultyArg(v, context) {
  if (typeof v !== 'string') die(`${context}: difficulty must be one of ${DIFFICULTIES.join('/')} (or "none" to clear)`);
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'none') return null; // clear
  if (!DIFFICULTIES.includes(s)) {
    die(`${context}: difficulty must be one of ${DIFFICULTIES.join('/')} (or "none" to clear), got ${JSON.stringify(v)}`);
  }
  return s;
}

// The EFFECTIVE order of attack: stable sort by priority (ascending, absent =
// P1), array position within the same priority. Never rewrites the array.
function effectiveQueue(manifest) {
  return manifest.queue
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (priorityOf(a.entry) - priorityOf(b.entry)) || (a.i - b.i))
    .map(x => x.entry);
}

// ---------- validation (the lint) ----------

// Cross-check a parsed manifest against the filesystem. Returns {errors, warnings}.
function validate(manifest, fsState) {
  const errors = [];
  const warnings = [];
  const { open, done } = fsState;
  const queueIds = manifest.queue.map(e => e.id);
  const queueSet = new Set(queueIds);
  const known = new Set([...open.keys(), ...done.keys()]);

  for (const e of manifest.queue) {
    if (!ID_RE.test(e.id)) warnings.push(`id "${e.id}" is not the 4-digit NNNN convention`);
    if (!open.has(e.id)) {
      errors.push(done.has(e.id)
        ? `"${e.id}" is in queue but its file is in todos/done/ (run: queue.js done ${e.id}, or remove it)`
        : `"${e.id}" is in queue but has no todos/${e.id}-*.md file`);
    }
    for (const dep of (e.blockedBy || [])) {
      if (dep === e.id) errors.push(`"${e.id}" blockedBy references itself`);
      else if (!known.has(dep)) errors.push(`"${e.id}" blockedBy "${dep}" — no such todo (open or done)`);
    }
    for (const dep of (e.after || [])) {
      if (dep === e.id) errors.push(`"${e.id}" after references itself`);
      else if (!known.has(dep)) errors.push(`"${e.id}" after "${dep}" — no such todo (open or done)`);
    }
  }

  // Every open file must be listed exactly once.
  for (const id of open.keys()) {
    if (!queueSet.has(id)) errors.push(`todos/${open.get(id)} is not listed in queue.json (run: queue.js add ${id}, or queue.js check --fix)`);
  }
  // No id present in both open and done.
  for (const id of open.keys()) {
    if (done.has(id)) errors.push(`"${id}" exists in BOTH todos/ and todos/done/`);
  }

  // No structured `- **Depends**:` line in OPEN items — dependency ids live
  // only in this manifest (blockedBy/after); rationale belongs in body prose.
  // (done/ files are frozen history and exempt.)
  for (const [id, file] of open) {
    let body;
    try { body = fs.readFileSync(path.join(TODOS_DIR, file), 'utf8'); }
    catch { continue; } // unreadable file already surfaces as a queue error
    if (/^-\s*\*{0,2}Depends\*{0,2}\s*:/mi.test(body)) {
      errors.push(`todos/${file} carries a structured Depends: line — deps belong in queue.json (queue.js block ${id} --hard/--soft); move any rationale into the body prose`);
    }

    // (todos/0353 §2) The Status line must not advertise a round the body
    // records as landed — that is how 0117 kept a shipped R2 at rank 1. NOT
    // auto-fixable: which side is right is a judgement call, so this only ever
    // reports, naming the clause so the author can see what tripped it.
    const line = statusLineOf(body);
    if (line === null) continue;
    for (const c of statusContradictions(line, body)) {
      errors.push(`todos/${file} Status line says "${c.clause}" but the body has a "R${c.round} — DONE/LANDED" heading — one of the two is stale; fix whichever is wrong (not auto-fixable)`);
    }
    if (NEGATED_DEFER_RE.test(line)) {
      errors.push(`todos/${file} Status line reads "${line.trim()}" — a negated "deferred" on this line still classifies the item as DEFERRED (the 0126 footgun: the classifier substring-tests for "deferred"); say "open" or "ready" instead`);
    }
  }

  // (todos/0353 §1) A ticket in todos/done/ is closed by definition — the
  // directory IS the source of truth — so its Status line must not still lead
  // with "open". 35 of 260 did; 0330 was one, and it is cited as a dependency
  // by 0340 and 0347, so it is precisely the file a lane WILL read.
  for (const [, file] of done) {
    let body;
    try { body = fs.readFileSync(path.join(DONE_DIR, file), 'utf8'); }
    catch { continue; }
    const line = statusLineOf(body);
    if (line !== null && STATUS_OPEN_RE.test(line)) {
      errors.push(`todos/done/${file} is closed but its Status line still reads "${line.trim()}" — it belongs in done/, so the line must not say open (run: queue.js check --fix)`);
    }
  }

  // Cycle detection over the hard-dependency graph (open ids only — done deps
  // are already satisfied and terminal).
  const hard = new Map();
  for (const e of manifest.queue) hard.set(e.id, (e.blockedBy || []).filter(d => queueSet.has(d)));
  const state = new Map(); // id -> 0 visiting, 1 done
  const stack = [];
  let cycleReported = false;
  const visit = (id) => {
    if (cycleReported) return;
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) {
      const from = stack.slice(stack.indexOf(id)).concat(id).join(' -> ');
      errors.push(`dependency cycle in blockedBy: ${from}`);
      cycleReported = true;
      return;
    }
    state.set(id, 0); stack.push(id);
    for (const dep of (hard.get(id) || [])) visit(dep);
    stack.pop(); state.set(id, 1);
  };
  for (const id of hard.keys()) visit(id);

  return { errors, warnings };
}

// Validate the given manifest; on error print + exit 1 (used before every write).
function validateOrDie(manifest, fsState, context) {
  const { errors, warnings } = validate(manifest, fsState || scanFs());
  for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
  if (errors.length) {
    process.stderr.write(`${context || 'validation'} failed:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
}

// ---------- commands ----------

function cmdCheck(argv) {
  const { flags } = parseFlags('check', argv, ['fix']);
  const raw = loadManifestRaw();
  if (raw === null) die(`no ${path.relative(REPO_ROOT, QUEUE_PATH)}`);
  const res = parseManifest(raw);
  if (res.error) die(`${path.relative(REPO_ROOT, QUEUE_PATH)}: ${res.error}`);
  const manifest = res.manifest;
  const fsState = scanFs();

  if (flags.fix) {
    // Append any open files missing from the queue (order preserved otherwise).
    const queueSet = new Set(manifest.queue.map(e => e.id));
    const missing = [...fsState.open.keys()].filter(id => !queueSet.has(id)).sort();
    if (missing.length) {
      for (const id of missing) manifest.queue.push({ id });
      process.stdout.write(`--fix: appended ${missing.length} unlisted item(s): ${missing.join(', ')}\n`);
    }
    // Rewrite done/ Status lines that still say "open" (todos/0353 §3). Only
    // this one — the R<n> contradiction is deliberately NOT auto-fixed.
    // Written to disk here rather than staged like the manifest above, because
    // validate() re-reads the ticket files: the fix has to land before the
    // check that would otherwise fail on it.
    const fixed = [];
    for (const [, file] of fsState.done) {
      const p = path.join(DONE_DIR, file);
      let body;
      try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const next = fixDoneStatusLine(body);
      if (next !== null) { fs.writeFileSync(p, next); fixed.push(file); }
    }
    if (fixed.length) {
      process.stdout.write(`--fix: rewrote "open" -> "done" on ${fixed.length} closed ticket(s):\n`);
      for (const f of fixed) process.stdout.write(`  todos/done/${f}\n`);
    }
  }

  const { errors, warnings } = validate(manifest, fsState);
  // The liability register (todos/0286) cites ticket ids, so its staleness is
  // ticket state — this CLI's subject. Validated here so closing or filing an
  // item re-checks it. Whether the register EXISTS is not this command's
  // business: `liabilities.js check` fails on a missing one, and both gates
  // that run this command (the pre-commit hook, the `todos` suite in
  // tests/run.js) run that command too. tests/run.js is also what catches a
  // CODE edit that rewrites an anchored comment.
  const liab = fs.existsSync(LIABILITIES.registerPath())
    ? LIABILITIES.check({ tickets: fsState }) : { errors: [], pinned: [], entries: [] };
  for (const p of liab.pinned) {
    process.stdout.write(`  pinned  ${p.id}  deferral target ${p.expired} is closed — funded by todos/${p.ticket}\n`);
  }
  errors.push(...liab.errors);
  for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
  if (errors.length) {
    process.stderr.write(`check FAILED (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  if (flags.fix) writeManifest(manifest);
  process.stdout.write(`check OK — ${manifest.queue.length} item(s), ${fsState.done.size} done, ` +
    `${liab.entries.length} liability entr${liab.entries.length === 1 ? 'y' : 'ies'} (${liab.pinned.length} pinned).\n`);
}

function cmdList(argv) {
  parseFlags('list', argv, []);
  const manifest = requireManifest();
  const fsState = scanFs();
  const doneSet = new Set(fsState.done.keys());
  process.stdout.write(`Order of attack (${manifest.queue.length} open):\n`);
  effectiveQueue(manifest).forEach((e, i) => {
    const status = statusOf(e.id, fsState.open);
    const hardUnmet = (e.blockedBy || []).filter(d => !doneSet.has(d));
    const softUnmet = (e.after || []).filter(d => !doneSet.has(d));
    let state;
    if (status === 'deferred') state = 'deferred';
    else if (status === 'unknown') state = 'MISSING FILE';
    else if (hardUnmet.length) state = `blocked ⛓ ${hardUnmet.join(' ')}`;
    else state = 'ready';
    const prio = priorityOf(e);
    const marker = prio === DEFAULT_PRIORITY ? '' : `P${prio}  `; // P1 (default) stays unmarked
    const diff = e.difficulty ? `[${e.difficulty}]  ` : ''; // untagged stays unmarked
    let line = `  ${String(i + 1).padStart(2)}. ${e.id}  ${marker}${diff}${state}`;
    if (softUnmet.length) line += `   (after ▸ ${softUnmet.join(' ')})`;
    process.stdout.write(line + '\n');
  });
}

function nextId(fsState) {
  let max = 0;
  for (const id of [...fsState.open.keys(), ...fsState.done.keys()]) {
    const n = parseInt(id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, '0');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function scaffold(id, title) {
  return `# ${id} — ${title}

- **Status**: open
- **Design**: —

## Goal

## Plan

## Acceptance
`;
}

// The scaffold for `add --reflection`: a curation-only item whose whole turn
// is re-evaluating the queue against reality. Created by the netguc/cc churn
// engine on a per-project cadence (todoReflectionEvery) — an ordinary item in
// every other way (kickoff, audit, close by file move). The cadence is
// system-owned: reflection items must not create more reflection items.
function reflectionScaffold(id) {
  return `# ${id} — queue reflection

- **Status**: open
- **Design**: —

## Goal

Curation-only turn: re-evaluate the queue against the actual state of the
repo, then adjust it. No feature work in this item.

## Plan

- Orient: HANDOFF.md, \`node todos/queue.js list\`, the most recently
  finished items in todos/done/, and the recent dev logs.
- For each recently-done item: did the landed work satisfy its stated
  Goal/Acceptance? Every descoped or deferred residue must have an open
  item that owns it — create the missing ones (\`queue.js add\`).
- Check the committed backlog artifacts the queue is supposed to track
  (missing-symbol reports, conformance lists, ...) for demand that has no
  owner item.
- For each open item: still worth doing, still correctly scoped, still
  correctly ordered/blocked? Adjust via \`queue.js reorder\`/\`block\`;
  defer or retire what no longer makes sense (rewrite its Status line
  with the why — never a silent deletion).
- Do NOT create another reflection item — the cadence is system-owned.

## Acceptance

- Queue order + deps reflect reality; \`node todos/queue.js check\` passes.
- Every change carries a one-line rationale (item body or Status line).
`;
}

// The scaffold for `add --difficulty-triage`: a curation-only item whose whole
// turn is assigning a difficulty tag to every currently-untagged open item.
// Created by the netguc/cc churn engine when a project has difficulty-triage
// enabled and untagged items exist — so a light-mode run can rely on the tags.
function difficultyTriageScaffold(id) {
  return `# ${id} — difficulty triage

- **Status**: open
- **Design**: —

## Goal

Curation-only turn: give every currently-untagged open todo a difficulty tag
(\`light\` / \`medium\` / \`heavy\`) so the churn engine's light mode can skip the
heavy ones. No feature work in this item.

## Plan

- List the queue: \`node todos/queue.js list\`. Items with no \`[light|medium|
  heavy]\` marker are untagged.
- For each untagged open item, read its \`todos/NNNN-*.md\` (Goal/Plan/Acceptance)
  and judge the effort/risk, then tag it:
  \`node todos/queue.js set-difficulty <ID> <light|medium|heavy>\`.
    - light  — a small, well-scoped change; low risk; minutes to an hour.
    - medium — a normal feature/fix; some unknowns; a focused session.
    - heavy  — large/architectural/high-uncertainty; a light run should skip it.
- Base the call on the item's own scope, not the numbering.
- Do NOT create or retitle items and do NOT create another triage item — this
  pass only tags. Leave already-tagged items alone unless clearly wrong.

## Acceptance

- Every open item has a difficulty tag; \`node todos/queue.js check\` passes.
- Close this item the normal way (Status line, move to done, commit, push).
`;
}

// The scaffold for `add --manual-ux`: a recurring, self-perpetuating dogfood
// turn whose whole job is to DRIVE the live OS like a human — launch apps, use
// menus, play the games, take screenshots, and eyeball them for anything that
// looks or behaves wrong. Unlike the golden browser legs (which assert known
// pixels), this pass hunts for the unknown. It is the ONE queue item that
// deliberately reseeds itself — exactly ONE successor, seeded AT CLOSE, so
// exactly one open copy exists at a time (the 2026-07-15 reconciliation
// retired the old top-up-to-3-4 kickoff rule after it piled seven overlapping
// sweep copies into the queue; contrast the reflection item, whose cadence is
// system-owned and must NOT self-perpetuate).
function manualUxScaffold(id) {
  return `# ${id} — manual UX bug sweep

- **Status**: open
- **Design**: \`todos/OS.md\` (the agent-target pillar + \`wmctl\`), the
  \`tests/browser/os-*.mjs\` sweep, and the 0073 desktop-apps dogfood format.

## Goal

A recurring, exploratory dogfood pass: interact with the live OS the way a
person would — launch apps, click through menus, play the games — TAKE
SCREENSHOTS, and actually LOOK at them for anything visibly or behaviourally
wrong. The automated \`os-*.mjs\` legs only assert pixels they already know to
expect; this turn hunts the bugs no golden covers. Output is repro tests +
fixes + an updated known-issues list, NOT a new feature.

## Reseed rule — ONE open copy, successor seeded at close

This item keeps the cadence alive, but there must only ever be **one open
copy** (the 2026-07-15 reconciliation consolidated seven overlapping sweep
copies into one — don't rebuild the pile). At CLOSE time, as part of the
closing commit:

    ls todos/*-manual-ux-sweep.md   # must list ONLY this file
    node todos/queue.js add next --manual-ux --priority 2   # exactly once

Then \`node todos/queue.js check\` and close this one. (\`add next
--manual-ux\` scaffolds a fresh copy of this item and appends it to the
tail — note in ITS body which slices this run covered, so the rotation
advances.)

## Plan

- **Boot the OS and get onto the desktop (VT2).** Two ways to drive it:
  - Real compositor (best for visual bugs): a Chromium session in the
    \`tests/browser/os-*.mjs\` style (\`--enable-unsafe-webgpu\`); switch to VT2
    with \`window.__osVtSwitch(2)\`, derive screen geometry from
    \`window.__osScreen\`.
  - Headless + screenshots (fast, no GPU visuals but full app logic):
    \`node os/boot.js\` driving the shell, \`wmctl list/tree/shot/click/
    dblclick/keydown\` for gestures, \`wmctl shot <sid> out.ppm\` for frames.
- **Exercise breadth, not depth.** A non-exhaustive rotation — cover a
  different slice each run and note what you skipped:
  - Shell & WM: Start menu + flyouts + search, desktop icons (select/drag/
    rename/marquee), right-click context menus, taskbar (buttons, clock,
    Show Desktop, right-click Cascade/Tile), Aero Snap, window min/max/close,
    Alt-Tab cycle, the screensaver.
  - Desktop apps: calc, notepad, paint, fileman (copy/cut/paste/rename/
    delete/Recycle Bin), ctlpanel applets, term, winmine.
  - Games / media: doom, quake, snake, sameboy & gameboy (a ROM through the
    .gb/.gbc association), the REPLs (lua/micropython/sqlite3).
- **Screenshot and eyeball.** For each windowed app, \`wmctl shot\` a frame (or
  grab a browser screenshot) and LOOK: garbled pixels, wrong colours, missing
  chrome, stuck frames, off-by-one layout, unreadable text. Note audio glitches
  where audible.
- **File every finding as a MINIMAL repro test FIRST** (conformance-corpus
  rule), then a fix as its own commit referencing this item. A finding you
  can't cheaply fix goes to the relevant known-issues list (\`WM.md\` /
  \`WIN32.md\` / the vendored app's README) with a repro — never silently
  dropped.

## Acceptance

- Exactly ONE fresh \`manual-ux-sweep\` successor seeded at close (with the
  covered-slices note); \`queue.js check\` passes.
- A dev-log entry (\`logs/YYYY-MM-DD/manual-ux-sweep.md\`) listing what was
  driven, the screenshots taken, and a fixed/deferred split of findings.
- New regression tests committed for everything fixed; known-issues lists
  updated for everything deferred.
- Close this item the normal way (Status line → move to \`done/\`, commit, push).
`;
}

function cmdAdd(argv) {
  const { flags, positional } = parseFlags('add', argv,
    ['slug', 'title', 'after', 'blocked-by', 'pos', 'priority', 'difficulty', 'reflection', 'difficulty-triage', 'manual-ux']);
  const fsState = scanFs();
  let id = positional[0];
  if (!id || id === 'next') id = nextId(fsState);
  if (!ID_RE.test(id)) die(`add: id must be NNNN (4 digits) or "next", got "${id}"`);
  if (fsState.open.has(id) || fsState.done.has(id)) die(`add: id "${id}" already exists`);

  const priority = flags.priority !== undefined ? parsePriorityArg(flags.priority, 'add') : undefined;
  const difficulty = flags.difficulty !== undefined ? parseDifficultyArg(flags.difficulty, 'add') : undefined;

  const isReflection = flags.reflection !== undefined;
  const isDiffTriage = flags['difficulty-triage'] !== undefined;
  const isManualUx = flags['manual-ux'] !== undefined;
  const title = typeof flags.title === 'string' ? flags.title
    : (typeof flags.slug === 'string' ? flags.slug.replace(/-/g, ' ')
    : (isReflection ? 'queue reflection' : (isDiffTriage ? 'difficulty triage'
    : (isManualUx ? 'manual UX bug sweep' : 'untitled'))));
  // A manual-ux sweep keeps a stable, greppable slug so the self-perpetuation
  // step (and `ls todos/*-manual-ux-sweep.md`) can count the open copies.
  const slug = typeof flags.slug === 'string' ? flags.slug
    : (isManualUx ? 'manual-ux-sweep' : (slugify(title) || 'untitled'));
  const fileName = `${id}-${slug}.md`;
  const filePath = path.join(TODOS_DIR, fileName);

  const entry = { id };
  if (priority !== undefined && priority !== DEFAULT_PRIORITY) entry.priority = priority; // P1 = default, field omitted
  if (difficulty) entry.difficulty = difficulty; // untagged (null) = field omitted
  const hard = parseListFlag(typeof flags['blocked-by'] === 'string' ? flags['blocked-by'] : undefined);
  const soft = parseListFlag(typeof flags.after === 'string' ? flags.after : undefined);
  if (hard && hard.length) entry.blockedBy = hard;
  if (soft && soft.length) entry.after = soft;

  const manifest = requireManifest();
  let pos = manifest.queue.length;
  if (flags.pos !== undefined) {
    const p = parseInt(flags.pos, 10);
    if (!Number.isFinite(p) || p < 1) die(`add: --pos must be a positive integer`);
    pos = Math.min(p - 1, manifest.queue.length);
  }
  manifest.queue.splice(pos, 0, entry);

  // Write the scaffold first so validation sees the file, then roll it back if
  // the resulting manifest doesn't validate (never leave a half-applied add).
  fs.writeFileSync(filePath, isReflection ? reflectionScaffold(id)
    : isDiffTriage ? difficultyTriageScaffold(id)
    : isManualUx ? manualUxScaffold(id) : scaffold(id, title));
  const { errors } = validate(manifest, scanFs());
  if (errors.length) {
    fs.unlinkSync(filePath);
    process.stderr.write(`add failed (nothing written):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  writeManifest(manifest);
  process.stdout.write(`added ${id} at position ${pos + 1} → todos/${fileName}\n`);
}

function removeFromQueue(manifest, id) {
  const idx = manifest.queue.findIndex(e => e.id === id);
  if (idx === -1) return null;
  return manifest.queue.splice(idx, 1)[0];
}

function cmdSetPriority(argv) {
  const { positional } = parseFlags('set-priority', argv, []);
  const [id, value] = positional;
  if (!id || value === undefined) die('set-priority: usage: set-priority <ID> <0..3>  (1 is the default; setting 1 removes the field)');
  const manifest = requireManifest();
  const entry = entryFor(manifest, id);
  if (!entry) die(`set-priority: "${id}" is not in the queue`);
  const priority = parsePriorityArg(value, 'set-priority');
  if (priority === DEFAULT_PRIORITY) delete entry.priority; // default is expressed by absence
  else entry.priority = priority;
  validateOrDie(manifest, scanFs(), 'set-priority');
  writeManifest(manifest);
  process.stdout.write(`set-priority ${id} → P${priority}${priority === DEFAULT_PRIORITY ? ' (default; field removed)' : ''}\n`);
}

function cmdSetDifficulty(argv) {
  const { positional } = parseFlags('set-difficulty', argv, []);
  const [id, value] = positional;
  if (!id || value === undefined) die('set-difficulty: usage: set-difficulty <ID> <light|medium|heavy|none>  (none clears the tag)');
  const manifest = requireManifest();
  const entry = entryFor(manifest, id);
  if (!entry) die(`set-difficulty: "${id}" is not in the queue`);
  const difficulty = parseDifficultyArg(value, 'set-difficulty');
  if (difficulty === null) delete entry.difficulty; // untagged = absence
  else entry.difficulty = difficulty;
  validateOrDie(manifest, scanFs(), 'set-difficulty');
  writeManifest(manifest);
  process.stdout.write(`set-difficulty ${id} → ${difficulty === null ? 'untagged (field removed)' : difficulty}\n`);
}

function cmdReorder(argv) {
  const { flags, positional } = parseFlags('reorder', argv, ['before', 'after', 'pos']);
  const id = positional[0];
  if (!id) die('reorder: usage: reorder <ID> --before <ID> | --after <ID> | --pos <N>');
  const manifest = requireManifest();
  const entry = entryFor(manifest, id);
  if (!entry) die(`reorder: "${id}" is not in the queue`);

  removeFromQueue(manifest, id);
  let pos;
  if (flags.before !== undefined) {
    const t = manifest.queue.findIndex(e => e.id === flags.before);
    if (t === -1) die(`reorder: --before target "${flags.before}" not in queue`);
    pos = t;
  } else if (flags.after !== undefined) {
    const t = manifest.queue.findIndex(e => e.id === flags.after);
    if (t === -1) die(`reorder: --after target "${flags.after}" not in queue`);
    pos = t + 1;
  } else if (flags.pos !== undefined) {
    const p = parseInt(flags.pos, 10);
    if (!Number.isFinite(p) || p < 1) die('reorder: --pos must be a positive integer');
    pos = Math.min(p - 1, manifest.queue.length);
  } else {
    die('reorder: need one of --before <ID>, --after <ID>, --pos <N>');
  }
  manifest.queue.splice(pos, 0, entry);
  validateOrDie(manifest, scanFs(), 'reorder');
  writeManifest(manifest);
  process.stdout.write(`reordered ${id} → position ${pos + 1}\n`);
}

function cmdDone(argv) {
  const { positional } = parseFlags('done', argv, []);
  const id = positional[0];
  if (!id) die('done: usage: done <ID>');
  const fsState = scanFs();
  const file = fsState.open.get(id);
  if (!file) die(`done: no open todos/${id}-*.md to complete`);

  const src = path.join(TODOS_DIR, file);
  const dst = path.join(DONE_DIR, file);
  fs.mkdirSync(DONE_DIR, { recursive: true });
  // Prefer `git mv` to preserve history; fall back to a plain rename if the
  // file isn't tracked or this isn't a git tree.
  try {
    execFileSync('git', ['mv', path.relative(REPO_ROOT, src), path.relative(REPO_ROOT, dst)], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    fs.renameSync(src, dst);
    process.stderr.write(`  note: git mv failed; used a plain rename (stage it yourself)\n`);
  }

  // The directory is the source of truth for done-ness, so the Status line has
  // to follow it here — otherwise every close would manufacture exactly the
  // drift 0353 exists to stop, and the validate() below would reject the move
  // it just made. Re-stage after the rewrite: `git mv` staged the pre-edit blob.
  const moved = fixDoneStatusLine(fs.readFileSync(dst, 'utf8'));
  if (moved !== null) {
    fs.writeFileSync(dst, moved);
    try { execFileSync('git', ['add', path.relative(REPO_ROOT, dst)], { cwd: REPO_ROOT, stdio: 'pipe' }); } catch { /* untracked / not a git tree */ }
    process.stdout.write(`  Status line: open → done\n`);
  }

  const manifest = requireManifest();
  if (!removeFromQueue(manifest, id)) process.stderr.write(`  note: "${id}" was not in queue.json\n`);
  validateOrDie(manifest, scanFs(), 'done');
  writeManifest(manifest);
  process.stdout.write(`done ${id} → todos/done/${file} (dropped from queue)\n`);

  // Closing a ticket is the moment the liability register goes stale — that is
  // how 0291/0293/0300 were each missed. Name the entries now; `queue.js check`
  // (and the `todos` suite) then block until they are retired or re-pointed.
  const stale = fs.existsSync(LIABILITIES.registerPath()) ? LIABILITIES.check().errors : [];
  if (stale.length) {
    process.stderr.write(`\n  todos/LIABILITIES.md now FAILS its check — fix it in this closing commit:\n`);
    for (const e of stale) process.stderr.write(`    - ${e}\n`);
  }
}

function cmdBlock(argv) {
  const { flags, positional } = parseFlags('block', argv, ['hard', 'soft']);
  const id = positional[0];
  if (!id) die('block: usage: block <ID> [--hard A,B] [--soft C,D]');
  const manifest = requireManifest();
  const entry = entryFor(manifest, id);
  if (!entry) die(`block: "${id}" is not in the queue`);
  if (flags.hard === undefined && flags.soft === undefined) die('block: pass --hard and/or --soft (use "" to clear)');

  if (flags.hard !== undefined) {
    const hard = parseListFlag(typeof flags.hard === 'string' ? flags.hard : '');
    if (hard && hard.length) entry.blockedBy = hard; else delete entry.blockedBy;
  }
  if (flags.soft !== undefined) {
    const soft = parseListFlag(typeof flags.soft === 'string' ? flags.soft : '');
    if (soft && soft.length) entry.after = soft; else delete entry.after;
  }
  validateOrDie(manifest, scanFs(), 'block');
  writeManifest(manifest);
  process.stdout.write(`updated deps for ${id}: blockedBy=[${(entry.blockedBy || []).join(' ')}] after=[${(entry.after || []).join(' ')}]\n`);
}

// ---------- dispatch ----------

const USAGE = `queue.js — the todos ordering-manifest CLI

  list                                          effective order (priority buckets, then
                                                array position) + ready/blocked state
  add <NNNN|next> [--slug s] [--title t]        scaffold a todo + insert into the queue
          [--after A,B] [--blocked-by A,B] [--pos N]
          [--priority 0..3]                     P0 most urgent … P3 background (default P1,
                                                field omitted at P1)
          [--difficulty light|medium|heavy]     optional difficulty tag (light runs skip heavy)
          [--reflection]                        curation-only "queue reflection" scaffold
          [--difficulty-triage]                 curation-only "tag all untagged items" scaffold
          [--manual-ux]                         recurring, self-perpetuating "manual UX bug sweep" scaffold
  set-priority <ID> <0..3>                      set an entry's priority (1 = default,
                                                removes the field)
  set-difficulty <ID> <light|medium|heavy|none> set an entry's difficulty tag
                                                (none clears it)
  reorder <ID> --before <ID> | --after <ID> | --pos <N>
  done <ID>                                     git-mv to done/, drop from queue
  block <ID> [--hard A,B] [--soft C,D]          set hard/soft deps ("" clears)
  check [--fix]                                 validate; exit non-zero on failure
                                                --fix: list unlisted open items +
                                                rewrite done/ Status lines saying "open"

-h/--help anywhere prints this and exits 0. An unknown command or --flag is a
usage error (exit 2; nothing written) — validation failures exit 1.
`;

function main() {
  const [, , cmd, ...rest] = process.argv;
  // `-h`/`--help` ANYWHERE wins, before any command dispatch — `add --help`
  // must print usage, never scaffold an "untitled" item.
  if (cmd === undefined || process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }
  switch (cmd) {
    case 'list': return cmdList(rest);
    case 'add': return cmdAdd(rest);
    case 'set-priority': return cmdSetPriority(rest);
    case 'set-difficulty': return cmdSetDifficulty(rest);
    case 'reorder': return cmdReorder(rest);
    case 'done': return cmdDone(rest);
    case 'block': return cmdBlock(rest);
    case 'check': return cmdCheck(rest);
    default:
      process.stderr.write(`queue.js: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

main();
