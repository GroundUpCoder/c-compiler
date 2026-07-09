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
//   node todos/queue.js list                         # resolved order + ready/blocked state
//   node todos/queue.js add <NNNN|next> [--slug s] [--title t] \
//                        [--after A,B] [--blocked-by A,B] [--pos N]
//   node todos/queue.js reorder <ID> --before <ID> | --after <ID> | --pos <N>
//   node todos/queue.js done <ID>                    # git-mv to done/, drop from queue
//   node todos/queue.js block <ID> [--hard A,B] [--soft C,D]
//   node todos/queue.js check [--fix]                # validate; exit non-zero on failure
//
// Zero dependencies (Node built-ins only), matching the repo's tools/ ethos.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function parseListFlag(v) {
  // "0057,0058" / "0057, 0058" -> ['0057','0058']; "" / "-" -> []
  if (v === undefined) return undefined;
  return v.split(',').map(s => s.trim()).filter(s => s && s !== '—' && s !== '-');
}

// Parse `add`/`reorder`/`block` style `--flag value` args into a map.
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = true; // bare boolean flag
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

function statusOf(id, openFiles) {
  const file = openFiles.get(id);
  if (!file) return 'unknown';
  let body;
  try { body = fs.readFileSync(path.join(TODOS_DIR, file), 'utf8'); }
  catch { return 'unknown'; }
  const m = body.match(/^-\s*\*{0,2}Status\*{0,2}\s*:\s*(.*)$/mi);
  if (m && /deferred/i.test(m[1])) return 'deferred';
  return 'open';
}

// ---------- manifest load / parse / format ----------

function loadManifestRaw() {
  let content;
  try { content = fs.readFileSync(QUEUE_PATH, 'utf8'); }
  catch { return null; }
  return content;
}

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
  }
  return { manifest: data };
}

// Diff-friendly serializer: one entry per line, `{ "id": ... }` shape.
function formatManifest(manifest) {
  const lines = manifest.queue.map(e => {
    let s = `    { "id": ${JSON.stringify(e.id)}`;
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
  const { flags } = parseFlags(argv);
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
  }

  const { errors, warnings } = validate(manifest, fsState);
  for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
  if (errors.length) {
    process.stderr.write(`check FAILED (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  if (flags.fix) writeManifest(manifest);
  process.stdout.write(`check OK — ${manifest.queue.length} item(s), ${fsState.done.size} done.\n`);
}

function cmdList() {
  const manifest = requireManifest();
  const fsState = scanFs();
  const doneSet = new Set(fsState.done.keys());
  process.stdout.write(`Order of attack (${manifest.queue.length} open):\n`);
  manifest.queue.forEach((e, i) => {
    const status = statusOf(e.id, fsState.open);
    const hardUnmet = (e.blockedBy || []).filter(d => !doneSet.has(d));
    const softUnmet = (e.after || []).filter(d => !doneSet.has(d));
    let state;
    if (status === 'deferred') state = 'deferred';
    else if (status === 'unknown') state = 'MISSING FILE';
    else if (hardUnmet.length) state = `blocked ⛓ ${hardUnmet.join(' ')}`;
    else state = 'ready';
    let line = `  ${String(i + 1).padStart(2)}. ${e.id}  ${state}`;
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

function cmdAdd(argv) {
  const { flags, positional } = parseFlags(argv);
  const fsState = scanFs();
  let id = positional[0];
  if (!id || id === 'next') id = nextId(fsState);
  if (!ID_RE.test(id)) die(`add: id must be NNNN (4 digits) or "next", got "${id}"`);
  if (fsState.open.has(id) || fsState.done.has(id)) die(`add: id "${id}" already exists`);

  const title = typeof flags.title === 'string' ? flags.title : (typeof flags.slug === 'string' ? flags.slug.replace(/-/g, ' ') : 'untitled');
  const slug = typeof flags.slug === 'string' ? flags.slug : slugify(title) || 'untitled';
  const fileName = `${id}-${slug}.md`;
  const filePath = path.join(TODOS_DIR, fileName);

  const entry = { id };
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
  fs.writeFileSync(filePath, scaffold(id, title));
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

function cmdReorder(argv) {
  const { flags, positional } = parseFlags(argv);
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
  const { positional } = parseFlags(argv);
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

  const manifest = requireManifest();
  if (!removeFromQueue(manifest, id)) process.stderr.write(`  note: "${id}" was not in queue.json\n`);
  validateOrDie(manifest, scanFs(), 'done');
  writeManifest(manifest);
  process.stdout.write(`done ${id} → todos/done/${file} (dropped from queue)\n`);
}

function cmdBlock(argv) {
  const { flags, positional } = parseFlags(argv);
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

  list                                          resolved order + ready/blocked state
  add <NNNN|next> [--slug s] [--title t]        scaffold a todo + insert into the queue
          [--after A,B] [--blocked-by A,B] [--pos N]
  reorder <ID> --before <ID> | --after <ID> | --pos <N>
  done <ID>                                     git-mv to done/, drop from queue
  block <ID> [--hard A,B] [--soft C,D]          set hard/soft deps ("" clears)
  check [--fix]                                 validate; exit non-zero on failure
`;

function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'list': return cmdList(rest);
    case 'add': return cmdAdd(rest);
    case 'reorder': return cmdReorder(rest);
    case 'done': return cmdDone(rest);
    case 'block': return cmdBlock(rest);
    case 'check': return cmdCheck(rest);
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`queue.js: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

main();
