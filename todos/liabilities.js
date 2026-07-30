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
// Invoked by the pre-commit hook and by the `todos` suite in tests/run.js,
// which also routes every file the register cites to this check — so a code
// edit that rewrites an anchored comment cannot slip past.
//
// Ticket refs come in two dialects since the 2026-07-30 queue cutover:
//   #N     a cc ticket (the live tracker; per-project number in the
//          c-compiler cc project). The REQUIRED funding dialect for `ticket:`.
//   NNNN   a legacy file-queue id, resolved against todos/done/ (the archive)
//          — an open NNNN file no longer exists, so a legacy id can only be
//          'done' or 'missing'. Still meaningful in `defers-to:`/`expired:`/
//          `provenance:` where the target already shipped.
// Liveness for #N is asked of `cc-meta ticket list`; when that CLI is absent
// or fails (public clone, offline), the check DEGRADES LOUDLY — anchors and
// structure still gate, #N liveness reports UNVERIFIED instead of silently
// passing or silently failing. `--offline` is the explicit opt-out.
//
// Zero dependencies (Node built-ins only).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TODOS_DIR = __dirname;
const REPO_ROOT = path.resolve(TODOS_DIR, '..');
const DONE_DIR = path.join(TODOS_DIR, 'done');
const REGISTER_REL = 'todos/LIABILITIES.md';

// The c-compiler cc project — where `#N` funding tickets live.
const CC_PROJECT = '019d77d8-f894-7d09-9099-4e747aa20bfb';
const CC_TIMEOUT_MS = 15000;

const BEGIN = '<!-- BEGIN ENTRIES -->';
const END = '<!-- END ENTRIES -->';

const HEADING_RE = /^###\s+(L\d+)\s+—\s+(\S.*?)\s*$/;
const FIELD_RE = /^-\s+([a-z-]+):\s*(\S.*?)\s*$/;
const ID_RE = /^\d{4}$/;
const CC_RE = /^#\d+$/;
const ID_IN_TEXT_RE = /\d{4}/g;
const CC_IN_TEXT_RE = /#\d+/g;

const REQUIRED_FIELDS = ['ticket', 'file', 'anchor'];
const ID_LIST_FIELDS = ['defers-to', 'expired', 'provenance'];
const KNOWN_FIELDS = [...REQUIRED_FIELDS, ...ID_LIST_FIELDS];

// ---------- filesystem facts ----------

// { open: Map<id, filename>, done: Map<id, filename> } — legacy NNNN ids,
// resolved against the filesystem. Since the 2026-07-30 cutover only done/
// is populated in practice; `open` remains so a stray resurrected NNNN file
// still reads as what it is.
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

// { states: Map<'#N', status>, verified, note } — cc ticket liveness, asked
// of `cc-meta ticket list` in one shot (the per-project list is unpaginated).
// verified:false NEVER fails the check by itself; it makes the report say
// UNVERIFIED out loud, because a public clone without cc-meta must still be
// able to run the structural half of this gate.
function scanCcTickets(opts) {
  if (opts && opts.offline) {
    return { states: new Map(), verified: false, note: '#N liveness UNVERIFIED (--offline)' };
  }
  let out;
  try {
    out = execFileSync('cc-meta',
      ['ticket', 'list', '--project', CC_PROJECT, '--status', 'all'],
      { encoding: 'utf8', timeout: CC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'cc-meta not on PATH'
      : e.signal ? `cc-meta timed out (${e.signal})` : `cc-meta failed: ${String(e.message).split('\n')[0]}`;
    return { states: new Map(), verified: false, note: `#N liveness UNVERIFIED (${why})` };
  }
  let items;
  try { items = JSON.parse(out).items; } catch {
    return { states: new Map(), verified: false, note: '#N liveness UNVERIFIED (cc-meta output was not the expected JSON)' };
  }
  const states = new Map();
  for (const it of items || []) {
    const t = it.ticket || it;
    if (typeof t.number === 'number') states.set(`#${t.number}`, t.status);
  }
  return { states, verified: true, note: null };
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
        if (!ID_RE.test(id) && !CC_RE.test(id)) errors.push(`${REGISTER_REL}:${e.line}: ${e.id} "${key}" value ${JSON.stringify(id)} is not a ticket ref (cc "#N" or legacy 4-digit id)`);
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
  // Injectable for tests (opts.cc); lazily consulted either way, so a register
  // with no #N refs never pays for — or reports on — the cc probe.
  const ccProvided = (opts && opts.cc) || null;
  let cc = null;
  const ccInfo = () => (cc || (cc = ccProvided || scanCcTickets(opts)));
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

  // One state vocabulary over both dialects: 'open' (live funding), 'done'
  // (closed — cc done/dropped, or a legacy id in todos/done/), 'missing', and
  // 'unverified' (a #N ref while cc liveness could not be asked — reported,
  // never an error, never silently treated as live).
  const state = (ref) => {
    if (CC_RE.test(ref)) {
      const info = ccInfo();
      if (!info.verified) return 'unverified';
      const st = info.states.get(ref);
      if (!st) return 'missing';
      return (st === 'done' || st === 'dropped') ? 'done' : 'open';
    }
    return tickets.open.has(ref) ? 'open' : tickets.done.has(ref) ? 'done' : 'missing';
  };
  // Where a ref lives, for error prose.
  const where = (ref) => CC_RE.test(ref) ? `cc ticket ${ref}` : `ticket ${ref}`;

  for (const e of entries) {
    const at = `${REGISTER_REL}:${e.line} (${e.id})`;

    // --- the funding ticket must be live ---
    switch (state(e.ticket)) {
      case 'done':
        errors.push(CC_RE.test(e.ticket)
          ? `${at}: ${where(e.ticket)} is CLOSED (done/dropped) — this gap's funding is gone: retire the entry if the gap is closed too, or re-point it at a live ticket`
          : `${at}: ${where(e.ticket)} is CLOSED (todos/done/) — this gap's funding is gone: legacy ids cannot fund a gap since the 2026-07-30 cutover; re-point it at a live cc ticket (#N)`);
        break;
      case 'missing':
        errors.push(CC_RE.test(e.ticket)
          ? `${at}: ${where(e.ticket)} does not exist in the c-compiler cc project`
          : `${at}: ticket ${e.ticket} has no todos/${e.ticket}-*.md file (open or done)`);
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
        errors.push(CC_RE.test(id)
          ? `${at}: defers-to ${id} does not exist in the c-compiler cc project`
          : `${at}: defers-to ${id} has no todos/${id}-*.md file (open or done)`);
        continue;
      }
      // 'unverified' (#N without cc-meta): liveness unknowable here, so neither
      // the outlived-premise error nor a pin verdict can be judged — the check's
      // summary already says the #N half ran UNVERIFIED.
      if (st === 'unverified') continue;
      const isPinned = expired.includes(id);
      if (st === 'done' && !isPinned) {
        errors.push(`${at}: DEFERRAL OUTLIVED ITS PREMISE — this gap is deferred to ${id}, which is CLOSED. ` +
          `A pointer at a closed item reads as "handled". Do the deferred work under ticket ${e.ticket}, re-point the deferral, ` +
          `or pin it with "- expired: ${id}" once ${e.ticket} owns the fix.`);
      } else if (st === 'open' && isPinned) {
        errors.push(`${at}: pin no longer applies — expired: ${id} claims ${id} is closed, but it is OPEN again. ` +
          `Drop the pin and re-read the entry (this is the xpass case: the premise moved under the acknowledgement).`);
      } else if (st === 'done' && isPinned) {
        pinned.push({ id: e.id, ticket: e.ticket, expired: id, gap: e.gap });
      }
    }

    // --- every ticket ref the anchor mentions must be classified ---
    const declared = new Set([e.ticket, ...defers, ...(e.provenance || [])]);
    const mentioned = new Set([
      ...(e.anchor.match(ID_IN_TEXT_RE) || []),
      ...(e.anchor.match(CC_IN_TEXT_RE) || []),
    ]);
    for (const found of mentioned) {
      const st = state(found);
      if (st === 'missing') continue;      // a number that is not a ticket
      if (st === 'unverified') continue;   // #N, liveness unknowable — see summary
      if (declared.has(found)) continue;
      errors.push(`${at}: the anchor mentions ticket ${found} but the entry does not classify it — ` +
        `add "- defers-to: ${found}" if the gap waits on it, or "- provenance: ${found}" if it is only history`);
    }
  }

  // ccNote is non-null exactly when some #N ref was judged without cc
  // liveness — the caller must surface it (silence would read as verified).
  return { errors, pinned, entries, ccNote: cc && !cc.verified ? cc.note : null };
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

const refLabel = (ref) => CC_RE.test(String(ref)) ? String(ref) : `todos/${ref}`;

function cmdCheck(argv) {
  const { errors, pinned, entries, ccNote } = check({ offline: (argv || []).includes('--offline') });
  for (const p of pinned) {
    process.stdout.write(`  pinned  ${p.id}  deferral target ${p.expired} is closed — funded by ${refLabel(p.ticket)}: ${p.gap}\n`);
  }
  if (ccNote) process.stdout.write(`  ⚠ ${ccNote} — anchors and structure were checked; #N liveness was NOT\n`);
  if (errors.length) {
    process.stderr.write(`liabilities: FAILED (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`liabilities: OK — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
    `${pinned.length} pinned, ${new Set(entries.map(e => e.ticket)).size} funding ticket(s)` +
    `${ccNote ? ` [${ccNote}]` : ''}.\n`);
}

function cmdList(argv) {
  const { errors, entries, ccNote } = check({ offline: (argv || []).includes('--offline') });
  for (const e of entries) {
    process.stdout.write(`${e.id}  ${refLabel(e.ticket)}  ${e.at || `${e.file}:?`}\n      ${e.gap}\n`);
  }
  if (ccNote) process.stdout.write(`\n  ⚠ ${ccNote}\n`);
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
  const offline = argv.includes('--offline');   // skip the freshness probe (todos/0360)
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
    const a = IDSPACE.allocate('liability', ids, { root: REPO_ROOT, local, offline });
    process.stdout.write(`${a.id}  ${a.note}\n`);
    process.stdout.write(`     ${a.freshness.line}\n`);   // todos/0360
  } catch (e) {
    if (!(e instanceof IDSPACE.IdSpaceError)) throw e;
    process.stderr.write(`liabilities: ${e.message}\n`);
    process.exit(1);
  }
}

const USAGE = `liabilities.js — the liability register's validator (todos/done/0286)

  check [--offline]
                   validate todos/LIABILITIES.md; exit 1 on any failure.
                   #N funding refs are checked against the cc ticket tracker
                   (cc-meta); --offline, a missing cc-meta, or a failed call
                   degrade LOUDLY to structure+anchor checking only
  list [--offline] entries, with each anchor resolved to a live file:line
  next-id [--local] [--offline]
                   the next free Lnn, derived across every ref + every sibling worktree
                   (todos/0358), with a freshness verdict on what it surveyed (todos/0360)
`;

function main() {
  const cmd = process.argv[2];
  if (cmd === undefined || cmd === '-h' || cmd === '--help') { process.stdout.write(USAGE); return; }
  switch (cmd) {
    case 'check': return cmdCheck(process.argv.slice(3));
    case 'list': return cmdList(process.argv.slice(3));
    case 'next-id': return cmdNextId(process.argv.slice(3));
    default:
      process.stderr.write(`liabilities.js: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

module.exports = {
  check, parseRegister, citedFiles, scanTickets, scanCcTickets, REGISTER_REL, CC_PROJECT,
  registerPath: () => path.join(REPO_ROOT, REGISTER_REL),
};

if (require.main === module) main();
