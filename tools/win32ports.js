#!/usr/bin/env node
// win32ports.js — the 0060 Win32 port compile-test harness (todos/WIN32.md).
//
// Compiles every target in os/win32/ports.json (bin.json projects linked
// against the os/win32 veneer) and logs which win32 symbols each one still
// needs. The generated report, os/win32/PORTS.md, is the AUTHORITATIVE
// backlog for 0059+ — we implement to real demand, not speculation.
//
// Per-target status:
//   links           parse + link + codegen clean (the veneer covers it)
//   missing-symbols parse clean; link fails ONLY on undefined win32 symbols
//                   (the useful state: the symbol list is the demand data)
//   parse-errors    the header surface doesn't cover it yet — grow
//                   os/win32/include until the target reaches the link stage
//
// Usage:
//   node tools/win32ports.js           regenerate os/win32/PORTS.md + summary
//   node tools/win32ports.js --check   verify the committed report is current
//                                      and every target matches its "expect"
//                                      (exit 1 otherwise) — the CI mode
//   node tools/win32ports.js --verbose also dump raw compiler diagnostics

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const MANIFEST = path.join(ROOT, 'os/win32/ports.json');
const REPORT = path.join(ROOT, 'os/win32/PORTS.md');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const VERBOSE = argv.includes('--verbose');

/* ---- one target: expand its bin.json and compile (parse -> link ->
 * codegen), capturing diagnostics instead of throwing. Mirrors
 * os/os-common.js buildProject's expansion — kept tool-local because the
 * boot-path builder throws on first failure while the harness's whole job
 * is to keep going and classify. ---- */
function compileTarget(projPath) {
  let err = '';
  const writeErr = (s) => { err += s; };

  const pp = CompilerJS.createDefaultPPRegistry();
  const sources = [];
  const compilerOptions = { requireSources: [], backend: 'default' };

  function normalize(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else if (seg !== '.') out.push(seg);
    }
    return out.join('/');
  }
  const seen = new Set();                /* diamond-dep dedup (0079, matching
                                            os-common buildProject — freetype
                                            rides under both menucore.json
                                            and lib.json since 0259) */
  (function expand(p) {
    if (seen.has(p)) return;
    seen.add(p);
    const dir = p.slice(0, p.lastIndexOf('/'));
    const proj = JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
    for (const d of proj.deps || []) expand(normalize(dir + '/' + d));
    for (const inc of proj.includes || []) pp.includePaths.push(normalize(dir + '/' + inc));
    for (const a of proj.compilerArgs || []) {
      if (a.startsWith('-D')) {
        const def = a.substring(2), eq = def.indexOf('=');
        if (eq >= 0) pp.defines.set(def.substring(0, eq), def.substring(eq + 1));
        else pp.defines.set(def, '1');
      } else if (a.startsWith('-I')) {
        pp.includePaths.push(normalize(dir + '/' + a.substring(2)));
      } else {
        throw new Error(projPath + ': unsupported compilerArg ' + a);
      }
    }
    for (const s of proj.sources || []) sources.push(normalize(dir + '/' + s));
  })(projPath);

  pp.fileReader = (fp) => {
    try { return fs.readFileSync(path.join(ROOT, fp), 'utf8'); } catch (e) { return null; }
  };
  const fsShim = { readFileSync: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8') };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };

  let units;
  try {
    units = CompilerJS.parseAllUnits(fsShim, pp, sources, { warningFlags, compilerOptions, writeErr });
  } catch (e) {
    return { status: 'parse-errors', missing: [], diagnostics: err || e.message };
  }
  if (/error:/.test(err)) {
    return { status: 'parse-errors', missing: [], diagnostics: err };
  }

  const linkResult = CompilerJS.linkTranslationUnits(units, compilerOptions);
  if (linkResult.errors.length > 0) {
    const missing = new Set();
    let other = '';
    for (const e of linkResult.errors) {
      const m = /^Undefined symbol '(.+)' during linking$/.exec(e.message);
      if (m) missing.add(m[1]);
      else other += e.message + '\n';
    }
    if (other) return { status: 'parse-errors', missing: [...missing].sort(), diagnostics: err + other };
    return { status: 'missing-symbols', missing: [...missing].sort(), diagnostics: err };
  }

  try {
    CompilerJS.generateCode(units, 'a.wasm', {
      compilerOptions, warningFlags, writeErr,
      fatalExit: (code) => { throw new Error('codegen fatal exit ' + code); },
    });
  } catch (e) {
    return { status: 'parse-errors', missing: [], diagnostics: err + 'codegen: ' + e.message };
  }
  return { status: 'links', missing: [], diagnostics: err };
}

/* ---- report generation (deterministic: sorted, no timestamps) ---- */
function generateReport(manifest, results) {
  const L = [];
  L.push('# Win32 port status — the 0059+ missing-symbol backlog');
  L.push('');
  L.push('Generated by `node tools/win32ports.js` (todos/0060; design todos/WIN32.md).');
  L.push('Do not edit by hand — regenerate after changing os/win32 or a vendored');
  L.push('port, and keep it committed (`--check` verifies freshness).');
  L.push('');
  L.push('| target | status | missing |');
  L.push('|--------|--------|---------|');
  for (const t of manifest.targets) {
    const r = results.get(t.name);
    L.push(`| ${t.name} | ${r.status} | ${r.missing.length} |`);
  }
  L.push('');

  for (const t of manifest.targets) {
    const r = results.get(t.name);
    L.push(`## ${t.name} — ${r.status}`);
    L.push('');
    L.push(`Project: \`${t.project}\`${t.notes ? ' — ' + t.notes : ''}`);
    L.push('');
    if (r.status === 'missing-symbols') {
      L.push('Missing symbols (' + r.missing.length + '):');
      L.push('');
      L.push('```');
      for (const s of r.missing) L.push(s);
      L.push('```');
      L.push('');
    } else if (r.status === 'parse-errors') {
      const lines = r.diagnostics.split('\n').filter((l) => /error:/.test(l));
      const uniq = [...new Set(lines)].slice(0, 25);
      L.push('First distinct errors (grow os/win32/include until these clear):');
      L.push('');
      L.push('```');
      for (const l of uniq) L.push(l);
      L.push('```');
      L.push('');
    }
  }

  // The aggregate demand table: symbol -> apps, most-demanded first. This
  // ordering IS the 0059+ order of attack.
  const demand = new Map();
  for (const t of manifest.targets) {
    for (const s of results.get(t.name).missing) {
      if (!demand.has(s)) demand.set(s, []);
      demand.get(s).push(t.name);
    }
  }
  const rows = [...demand.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  L.push('## Aggregate demand (the order of attack)');
  L.push('');
  L.push(`${rows.length} distinct symbols across ${manifest.targets.length} targets.`);
  L.push('');
  L.push('| symbol | apps |');
  L.push('|--------|------|');
  for (const [sym, apps] of rows) L.push(`| ${sym} | ${apps.join(' ')} |`);
  L.push('');
  return L.join('\n');
}

/* ---- main ---- */
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const results = new Map();
let failed = false;

for (const t of manifest.targets) {
  const r = compileTarget(t.project);
  results.set(t.name, r);
  const ok = r.status === t.expect;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${t.name.padEnd(10)} ${r.status}` +
    (r.missing.length ? ` (${r.missing.length} missing)` : '') +
    (ok ? '' : ` — expected ${t.expect}`));
  if (VERBOSE && r.diagnostics) console.log(r.diagnostics);
  if (!ok && r.status === 'parse-errors' && !VERBOSE) {
    const lines = r.diagnostics.split('\n').filter((l) => /error:/.test(l));
    for (const l of [...new Set(lines)].slice(0, 15)) console.log('     ' + l);
  }
}

const report = generateReport(manifest, results);
if (CHECK) {
  const committed = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
  if (committed !== report) {
    console.error('FAIL os/win32/PORTS.md is stale — rerun `node tools/win32ports.js`');
    failed = true;
  } else {
    console.log('ok   PORTS.md current');
  }
} else {
  fs.writeFileSync(REPORT, report);
  console.log('wrote os/win32/PORTS.md');
}
process.exit(failed ? 1 : 0);
