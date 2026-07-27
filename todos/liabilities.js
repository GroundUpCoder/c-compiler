#!/usr/bin/env node
// todos/liabilities.js — parser + validator for the liability register (todos/0286).
//
// The register (todos/LIABILITIES.md) records gaps that the tree DESCRIBES but
// nothing schedules. A true gap comment is self-perpetuating — it reads as
// known-and-handled — so the useful question is never "is this comment
// accurate?" but "does it describe a gap, and is that gap SCHEDULED?". This
// script is what makes the second question machine-answerable, in the spirit of
// os/win32/PORTS.md: a record that cannot drift because drifting fails a test.
//
//   node todos/liabilities.js check    # validate; exit 1 on any failure
//   node todos/liabilities.js list     # entries with anchors resolved to file:line
//
// Invoked by `todos/queue.js check` (hence the pre-commit hook) and by the
// `todos` suite in tests/run.js, which also routes every file the register
// cites to this check — so a code edit that rewrites an anchored comment
// cannot slip past.
//
// Zero dependencies (Node built-ins only), matching todos/queue.js.
'use strict';

const fs = require('fs');
const path = require('path');

const TODOS_DIR = __dirname;
const REPO_ROOT = path.resolve(TODOS_DIR, '..');
const DONE_DIR = path.join(TODOS_DIR, 'done');
const REGISTER_REL = 'todos/LIABILITIES.md';

const BEGIN = '<!-- BEGIN ENTRIES -->';
const END = '<!-- END ENTRIES -->';

const HEADING_RE = /^###\s+(L\d+)\s+—\s+(\S.*?)\s*$/;
const FIELD_RE = /^-\s+([a-z-]+):\s*(\S.*?)\s*$/;
const ID_RE = /^\d{4}$/;
const ID_IN_TEXT_RE = /\d{4}/g;

const REQUIRED_FIELDS = ['ticket', 'file', 'anchor'];
const ID_LIST_FIELDS = ['defers-to', 'expired', 'provenance'];
const KNOWN_FIELDS = [...REQUIRED_FIELDS, ...ID_LIST_FIELDS];

// ---------- filesystem facts ----------

// { open: Map<id, filename>, done: Map<id, filename> } — the same view of
// ticket state todos/queue.js validates against.
function scanTickets() {
  const pick = (dir) => {
    const m = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return m; }
    for (const n of names) {
      const hit = /^(\d{4})-.*\.md$/.exec(n);
      if (hit) m.set(hit[1], n);
    }
    return m;
  };
  return { open: pick(TODOS_DIR), done: pick(DONE_DIR) };
}

// ---------- parsing ----------

// Strict: inside the entry markers, every non-blank line is either an entry
// heading or a `- key: value` field. Nothing is skipped as "unrecognised" —
// a line this parser does not understand is an error, because a silently
// dropped entry is a liability that stopped being checked without saying so.
function parseRegister(text) {
  const errors = [];
  const entries = [];
  const lines = text.split(/\r?\n/);
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);

  if (begin === -1 || end === -1 || end < begin) {
    errors.push(`${REGISTER_REL}: missing the "${BEGIN}" / "${END}" markers that delimit the entries`);
    return { entries, errors };
  }

  let cur = null;
  const push = () => { if (cur) entries.push(cur); cur = null; };

  for (let i = begin + 1; i < end; i++) {
    const line = lines[i];
    const at = `${REGISTER_REL}:${i + 1}`;
    if (!line.trim()) continue;

    const head = HEADING_RE.exec(line);
    if (head) {
      push();
      cur = { id: head[1], gap: head[2], line: i + 1, fields: new Map() };
      continue;
    }

    const field = FIELD_RE.exec(line);
    if (!field) {
      errors.push(`${at}: not an entry heading ("### L01 — gap") or a field ("- key: value"): ${JSON.stringify(line)}`);
      continue;
    }
    if (!cur) {
      errors.push(`${at}: field "${field[1]}" before any "### Lnn — …" heading`);
      continue;
    }
    if (cur.fields.has(field[1])) {
      errors.push(`${at}: ${cur.id} repeats the field "${field[1]}"`);
      continue;
    }
    cur.fields.set(field[1], field[2]);
  }
  push();

  for (const e of entries) {
    for (const key of e.fields.keys()) {
      if (!KNOWN_FIELDS.includes(key)) {
        errors.push(`${REGISTER_REL}:${e.line}: ${e.id} has unknown field "${key}" (known: ${KNOWN_FIELDS.join(', ')})`);
      }
    }
    for (const key of REQUIRED_FIELDS) {
      if (!e.fields.has(key)) errors.push(`${REGISTER_REL}:${e.line}: ${e.id} is missing the required field "${key}"`);
    }
    for (const key of ID_LIST_FIELDS.concat('ticket')) {
      if (!e.fields.has(key)) continue;
      const ids = e.fields.get(key).split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) errors.push(`${REGISTER_REL}:${e.line}: ${e.id} has an empty "${key}"`);
      for (const id of ids) {
        if (!ID_RE.test(id)) errors.push(`${REGISTER_REL}:${e.line}: ${e.id} "${key}" value ${JSON.stringify(id)} is not a 4-digit todo id`);
      }
      e[key === 'ticket' ? 'tickets' : key] = ids;
    }
    e.ticket = e.tickets ? e.tickets[0] : null;
    if (e.tickets && e.tickets.length > 1) {
      errors.push(`${REGISTER_REL}:${e.line}: ${e.id} cites ${e.tickets.length} tickets — one entry, one funding item (split the entry)`);
    }
    e.file = e.fields.get('file');
    e.anchor = e.fields.get('anchor');
  }

  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.id)) errors.push(`${REGISTER_REL}:${e.line}: duplicate entry id ${e.id} (first at line ${seen.get(e.id)})`);
    else seen.set(e.id, e.line);
  }

  return { entries, errors };
}

// ---------- anchor resolution ----------

// Where the anchor sits today: { line } | { count } when it is absent (0) or
// ambiguous (>1). Never returns "unknown" — a file we cannot read is an error
// the caller reports, not a check that quietly passes.
function locateAnchor(absPath, anchor) {
  const text = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(anchor)) hits.push(i + 1);
  return hits.length === 1 ? { line: hits[0] } : { count: hits.length };
}

// ---------- the check ----------

// Returns { errors: [], pinned: [], entries: [] }. `pinned` are acknowledged
// expired deferrals (green, funded by the entry's own ticket) — reported, never
// hidden.
function check(opts) {
  const registerPath = (opts && opts.registerPath) || path.join(REPO_ROOT, REGISTER_REL);
  const root = (opts && opts.repoRoot) || REPO_ROOT;
  const tickets = (opts && opts.tickets) || scanTickets();
  const errors = [];
  const pinned = [];

  let text;
  try { text = fs.readFileSync(registerPath, 'utf8'); }
  catch (e) { return { errors: [`cannot read ${REGISTER_REL}: ${e.message}`], pinned, entries: [] }; }

  const { entries, errors: parseErrors } = parseRegister(text);
  errors.push(...parseErrors);
  if (parseErrors.length) return { errors, pinned, entries };

  // An empty register would validate perfectly and prove nothing.
  if (!entries.length) {
    errors.push(`${REGISTER_REL} has no entries — an empty register passes vacuously, which is the failure mode this check exists to prevent`);
    return { errors, pinned, entries };
  }

  const state = (id) => tickets.open.has(id) ? 'open' : tickets.done.has(id) ? 'done' : 'missing';

  for (const e of entries) {
    const at = `${REGISTER_REL}:${e.line} (${e.id})`;

    // --- the funding ticket must be live ---
    switch (state(e.ticket)) {
      case 'done':
        errors.push(`${at}: ticket ${e.ticket} is CLOSED (todos/done/) — this gap's funding is gone: retire the entry if the gap is closed too, or re-point it at a live item`);
        break;
      case 'missing':
        errors.push(`${at}: ticket ${e.ticket} has no todos/${e.ticket}-*.md file (open or done)`);
        break;
    }

    // --- the anchor must still be there, exactly once ---
    const abs = path.join(root, e.file);
    if (!fs.existsSync(abs)) {
      errors.push(`${at}: file ${e.file} does not exist — re-point the entry or retire it`);
    } else {
      const loc = locateAnchor(abs, e.anchor);
      if (loc.count === 0) {
        errors.push(`${at}: anchor not found in ${e.file} — the line was edited or removed, so this entry no longer describes anything: re-anchor it, or retire it if the gap is closed\n      anchor: ${e.anchor}`);
      } else if (loc.count > 1) {
        errors.push(`${at}: anchor matches ${loc.count} lines in ${e.file} — it must identify ONE location, so make it longer`);
      } else {
        e.at = `${e.file}:${loc.line}`;
      }
    }

    // --- deferral targets: closed ones must be pinned, pins must still apply ---
    const defers = e['defers-to'] || [];
    const expired = e.expired || [];
    for (const id of expired) {
      if (!defers.includes(id)) {
        errors.push(`${at}: expired: ${id} is not in defers-to — a pin acknowledges a deferral target that has closed, so it must name one`);
      }
    }
    for (const id of defers) {
      const st = state(id);
      if (st === 'missing') {
        errors.push(`${at}: defers-to ${id} has no todos/${id}-*.md file (open or done)`);
        continue;
      }
      const isPinned = expired.includes(id);
      if (st === 'done' && !isPinned) {
        errors.push(`${at}: DEFERRAL OUTLIVED ITS PREMISE — this gap is deferred to ${id}, which is CLOSED (todos/done/). ` +
          `A pointer at a closed item reads as "handled". Do the deferred work under ticket ${e.ticket}, re-point the deferral, ` +
          `or pin it with "- expired: ${id}" once ${e.ticket} owns the fix.`);
      } else if (st === 'open' && isPinned) {
        errors.push(`${at}: pin no longer applies — expired: ${id} claims ${id} is closed, but todos/${id}-*.md is OPEN again. ` +
          `Drop the pin and re-read the entry (this is the xpass case: the premise moved under the acknowledgement).`);
      } else if (st === 'done' && isPinned) {
        pinned.push({ id: e.id, ticket: e.ticket, expired: id, gap: e.gap });
      }
    }

    // --- every ticket id the anchor mentions must be classified ---
    const declared = new Set([e.ticket, ...defers, ...(e.provenance || [])]);
    for (const found of new Set(e.anchor.match(ID_IN_TEXT_RE) || [])) {
      if (state(found) === 'missing') continue;   // a 4-digit number that is not a ticket
      if (declared.has(found)) continue;
      errors.push(`${at}: the anchor mentions todo ${found} but the entry does not classify it — ` +
        `add "- defers-to: ${found}" if the gap waits on it, or "- provenance: ${found}" if it is only history`);
    }
  }

  return { errors, pinned, entries };
}

// ---------- the diff-planner seam ----------

// Repo-relative paths the register cites, for tests/run.js's rule table: a
// change to any of them must re-run this check. `ok: false` means the register
// itself could not be parsed — the caller must then treat EVERY path as cited,
// so a broken register widens the gate instead of quietly narrowing it.
function citedFiles() {
  let text;
  try { text = fs.readFileSync(path.join(REPO_ROOT, REGISTER_REL), 'utf8'); }
  catch (e) { return { ok: false, error: `cannot read ${REGISTER_REL}: ${e.message}`, files: [] }; }
  const { entries, errors } = parseRegister(text);
  if (errors.length) return { ok: false, error: errors[0], files: [] };
  return { ok: true, files: [...new Set(entries.map(e => e.file).filter(Boolean))] };
}

// ---------- CLI ----------

function cmdCheck() {
  const { errors, pinned, entries } = check();
  for (const p of pinned) {
    process.stdout.write(`  pinned  ${p.id}  deferral target ${p.expired} is closed — funded by todos/${p.ticket}: ${p.gap}\n`);
  }
  if (errors.length) {
    process.stderr.write(`liabilities: FAILED (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`liabilities: OK — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
    `${pinned.length} pinned, ${new Set(entries.map(e => e.ticket)).size} funding ticket(s).\n`);
}

function cmdList() {
  const { errors, entries } = check();
  for (const e of entries) {
    process.stdout.write(`${e.id}  todos/${e.ticket}  ${e.at || `${e.file}:?`}\n      ${e.gap}\n`);
  }
  if (errors.length) {
    process.stderr.write(`\n(${errors.length} error(s) — run: node todos/liabilities.js check)\n`);
    process.exit(1);
  }
}

// The next free `Lnn`, derived across every ref (todos/0358). The register had
// no allocator at all: entries were numbered by eye off whatever ref the lane
// happened to be on, which is how two different L44 entries were written on two
// branches. parseRegister already rejects a duplicate id WITHIN one file (and
// still does — see its `seen` map), but that check can only fire once both
// entries are in the same file, i.e. after the merge that this allocator is
// meant to stop needing.
function cmdNextId(argv) {
  const local = argv.includes('--local');
  const IDSPACE = require('./idspace.js');
  const ids = [];
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, REGISTER_REL), 'utf8');
    for (const line of text.split('\n')) {
      const hit = /^###\s+L(\d+)\s+—/.exec(line);
      if (hit) ids.push(Number(hit[1]));
    }
  } catch { /* no register here — the refs still carry one */ }
  try {
    const a = IDSPACE.allocate('liability', ids, { root: REPO_ROOT, local });
    process.stdout.write(`${a.id}  ${a.note}\n`);
  } catch (e) {
    if (!(e instanceof IDSPACE.IdSpaceError)) throw e;
    process.stderr.write(`liabilities: ${e.message}\n`);
    process.exit(1);
  }
}

const USAGE = `liabilities.js — the liability register's validator (todos/0286)

  check            validate todos/LIABILITIES.md; exit 1 on any failure
  list             entries, with each anchor resolved to a live file:line
  next-id [--local]  the next free Lnn, derived across every ref (todos/0358)
`;

function main() {
  const cmd = process.argv[2];
  if (cmd === undefined || cmd === '-h' || cmd === '--help') { process.stdout.write(USAGE); return; }
  switch (cmd) {
    case 'check': return cmdCheck();
    case 'list': return cmdList();
    case 'next-id': return cmdNextId(process.argv.slice(3));
    default:
      process.stderr.write(`liabilities.js: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

module.exports = {
  check, parseRegister, citedFiles, scanTickets, REGISTER_REL,
  registerPath: () => path.join(REPO_ROOT, REGISTER_REL),
};

if (require.main === module) main();
