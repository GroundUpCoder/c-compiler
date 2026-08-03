// Build-artifact FRESHNESS, for the browser test drivers that render a
// pre-built binary out of tests/browser/www/ (ticket #171).
//
// The guard this replaces was an `fs.existsSync` loop under the comment
// "Build artifacts must exist — refuse to test stale state." `existsSync`
// answers "is there a file here", never "was this file built from the current
// sources", so a quake.wasm emitted by an older compiler.js walked straight
// through it and the suite reported the OLD compiler's behaviour under the NEW
// compiler's name. A regression reads green; a fix reads as already-landed.
// This estate has paid for that shape once already — the mGBA investigation
// chased a codegen bug that turned out to be a stale measurement.
//
// The relation implemented here is MTIME: every artifact must be at least as
// new as every input that produces it. It is the cheap, honest one — it cannot
// tell you an input was edited and reverted, and it is defeated by a clock
// jump, but it catches the case that actually happens (edit a source, forget to
// rebuild, measure the old binary). It is the same relation the rest of the
// estate's freshness gates already use (os-common's newestBakeInput,
// tests/lib/image-fixture.js), so a reader who knows one knows this one.
//
// What is deliberately NOT promised, so no comment here over-states its code:
//   - equality of BUILD FLAGS. An artifact built with different compiler flags
//     from the same sources is newer than its inputs and passes.
//   - anything about inputs the caller does not list. The spec is the contract;
//     an input the caller forgets is an input this cannot check.
//
// Missing inputs are an ERROR, not a pass: an input that is not on disk cannot
// establish freshness, and silently waving the artifact through would be the
// same lie in a new place.
import fs from 'node:fs';
import path from 'node:path';

// Expand one input spec into concrete files. A spec is either a path string
// (a file, or a directory walked recursively) or { dir, match } where `match`
// is a RegExp tested against each file's basename.
function expandInput(spec) {
  const p = typeof spec === 'string' ? spec : spec.dir;
  const match = typeof spec === 'string' ? null : spec.match;
  let st;
  try { st = fs.statSync(p); } catch { return { missing: p, files: [] }; }
  if (!st.isDirectory()) return { missing: null, files: [p] };
  const out = [];
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, ent.name);
    if (ent.isDirectory()) out.push(...expandInput(typeof spec === 'string' ? full : { dir: full, match }).files);
    else if (!match || match.test(ent.name)) out.push(full);
  }
  return { missing: null, files: out };
}

// The newest of a set of input specs: { path, mtimeMs } for the winner, plus
// any specs that could not be resolved at all.
function newestInput(specs) {
  let best = null;
  const missing = [];
  for (const spec of specs) {
    const { missing: gone, files } = expandInput(spec);
    if (gone) { missing.push(gone); continue; }
    for (const f of files) {
      let ms;
      try { ms = fs.statSync(f).mtimeMs; } catch { missing.push(f); continue; }
      if (!best || ms > best.mtimeMs) best = { path: f, mtimeMs: ms };
    }
  }
  return { best, missing };
}

// specs: [{ artifact, inputs, rebuild }] — `artifact` is the built file,
// `inputs` the specs above, `rebuild` the command that regenerates it.
// Returns a list of human-readable problems; empty means fresh.
export function checkArtifactFreshness(specs, { cwd = process.cwd() } = {}) {
  const rel = p => path.relative(cwd, p) || p;
  const problems = [];
  for (const { artifact, inputs, rebuild } of specs) {
    let aMs;
    try { aMs = fs.statSync(artifact).mtimeMs; }
    catch { problems.push(`Missing ${rel(artifact)} — run '${rebuild}' first.`); continue; }
    const { best, missing } = newestInput(inputs);
    for (const m of missing) {
      problems.push(`${rel(artifact)}: input ${rel(m)} is not on disk — freshness cannot be established.`);
    }
    if (best && best.mtimeMs > aMs) {
      problems.push(
        `STALE ${rel(artifact)} — input ${rel(best.path)} is newer than it `
        + `(input ${new Date(best.mtimeMs).toISOString()} > artifact ${new Date(aMs).toISOString()}). `
        + `Run '${rebuild}' — testing this artifact would measure a build that predates that input.`);
    }
  }
  return problems;
}

// The driver-facing form: print every problem and exit non-zero, or say
// nothing and return. Exits rather than throws because the callers are
// top-level module bodies that would otherwise go on to launch a browser.
export function requireFreshArtifacts(specs, opts) {
  const problems = checkArtifactFreshness(specs, opts);
  if (!problems.length) return;
  for (const p of problems) console.error(p);
  process.exit(1);
}
