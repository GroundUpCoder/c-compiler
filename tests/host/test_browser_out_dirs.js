#!/usr/bin/env node
'use strict';
// Browser-test output-destination lint (#399 / #183).
//
// Two sweep tests (os-vt2zoom.mjs, os-hires.mjs) used to hardcode their
// screenshot OUT_DIR into committed journal folders (logs/2026-07-18,
// logs/2026-07-25) and overwrite the PNGs there on every run. logs/ is
// durable committed project memory: the journal prose cites those exact
// images as evidence of July changes, so every sweep silently replaced
// July's pixels with today's — nothing errored, nothing warned, and lanes
// that `git add -A` swept the churn into unrelated commits (d48012a2).
//
// The rule this test enforces: NO file under tests/browser/ may name a
// committed journal/doc directory (logs/, todos/, docs/, old/) in a string
// literal. Test artifacts belong under gitignored scratch — build/ (the
// suite convention, e.g. build/test-browser/<name>-shots/), media/, or a
// tests/browser/.gitignore-covered name. A dev-log illustration is a
// deliberate HUMAN copy step, never a side effect of a gate run.
//
// The scanner extracts string literals with a small comment/string state
// machine (comments are free to MENTION logs/ — e.g. to say "never write
// there"; only code-reachable strings are flagged). A positive control runs
// the scanner over the original defect line every time, so a regex/tokenizer
// regression cannot rot this test into a vacuous green (#97/#144/#167/#171
// class).
//
// Run: node tests/host/test_browser_out_dirs.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const BAD = /(^|[/\\])(logs|todos|docs|old)\//;

// Extract string-literal contents (', ", `) skipping // and /* */ comments.
// Returns [{content, line}]. Regex literals are not modeled — they read as
// plain code, which is safe: a regex body's characters can't open a string.
function stringLiterals(src) {
  const out = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') {          // line comment
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {          // block comment
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {      // string literal
      const quote = c, startLine = line;
      let content = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { content += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '\n') line++;
        content += src[i];
        i++;
      }
      i++;                                          // closing quote
      out.push({ content, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

// ---- positive control: the scanner must flag the original defect line ----
const defect = "const OUT_DIR = path.resolve(__dirname, '../../logs/2026-07-18');";
const flagged = stringLiterals(defect).filter((s) => BAD.test(s.content));
check('positive control: the original os-vt2zoom OUT_DIR line is flagged',
  flagged.length === 1, JSON.stringify(flagged));
// ...and a commented-out mention is NOT (comments may cite the rule itself).
const comment = "// never write to logs/2026-07-18 — it holds 'frozen' evidence";
check('control: a comment mentioning logs/ is not flagged',
  stringLiterals(comment).filter((s) => BAD.test(s.content)).length === 0);

// ---- the sweep: every .mjs under tests/browser (node_modules excluded) ----
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;          // vendored (symlinked) deps
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);                     // lstat: never follow links
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && name.endsWith('.mjs')) files.push(p);
  }
})(path.join(ROOT, 'tests', 'browser'));

for (const f of files) {
  const hits = stringLiterals(fs.readFileSync(f, 'utf-8'))
    .filter((s) => BAD.test(s.content));
  const rel = path.relative(ROOT, f);
  check(`${rel}: no committed-dir (logs/, todos/, docs/, old/) path in a string literal`,
    hits.length === 0,
    hits.map((h) => `line ${h.line}: ${JSON.stringify(h.content)}`).join('; '));
}

// Census tripwires: an empty or half-dark walk must fail loud, and the two
// files this rule exists for must actually be in the scanned set.
check(`scanned set is plausibly complete (found ${files.length} .mjs files, expect > 30)`,
  files.length > 30);
for (const must of ['os-vt2zoom.mjs', 'os-hires.mjs']) {
  check(`scanned set includes ${must} (the #399/#183 regression targets)`,
    files.some((f) => path.basename(f) === must));
}

console.log(failures ? `\nbrowser out-dirs: ${failures} FAILED` : '\nbrowser out-dirs: PASS');
process.exit(failures ? 1 : 0);
