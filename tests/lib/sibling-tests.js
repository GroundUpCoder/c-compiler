'use strict';
// tests/lib/sibling-tests.js — sibling-owned test discovery (#613, design of
// record: gucos-packages-second-repo-design-2026-08-05.md §3).
//
// Per-package e2es live in the SIBLING data repo (gucos-packages) beside
// their package definitions, so a package change that needs a test change
// never commits to c-compiler. This module is the c-compiler half of that
// contract: locate the sibling checkout (through os-common's
// resolveSiblingRepo — the naive `../gucos-packages` is WRONG from a linked
// git worktree, where it names a sibling of the worktree slug; the resolver
// follows the `.git` gitdir pointer home to the main clone), read the
// sibling's own member manifest (`tests/manifest.json` — the sibling's half
// of the #314 registry guard), validate it STRICTLY, and hand the caller
// runner-shaped entries.
//
// The three outcomes, and why each is what it is:
//   'absent'  ... no sibling checkout found. The CALLER skips these tests,
//                 loudly — failing here would make every c-compiler
//                 contributor's gate depend on cloning an optional repo,
//                 which is the exact coupling the sibling repo exists to
//                 remove, reintroduced through the back door. The hole this
//                 opens is closed at the SHIP boundary (the pre-deploy full
//                 gate runs where the sibling is mandatory — comguc's
//                 assertSiblingUsable), not the land boundary.
//   'invalid' ... a sibling checkout IS present (or an explicit
//                 GUCOS_PACKAGES override names one) but its test contract
//                 is broken: missing/unparseable manifest, malformed
//                 members, an override pointing nowhere. This is LOUD and
//                 fatal at the caller — every malformed-manifest shape would
//                 otherwise degrade to "zero members", which is
//                 indistinguishable from "the sibling has no tests" and
//                 prints green while its tests never run. Silent-empty is
//                 the one outcome this module must never produce.
//   'ok'      ... entries ready for suite-runner. Member keys are PREFIXED
//                 with the repo name ('gucos-packages/test_x.js') so a
//                 sibling member can never collide with a native member of
//                 the same basename in the summary/resume/log/filter
//                 namespaces (runOne already flattens path separators into
//                 '_' for log names); `src` carries the absolute source
//                 path, which suite-runner prefers over opts.dir+file for
//                 spawn and resume-freshness.
//
// Manifest shape (the sibling README's "Tests" section is the user-facing
// twin of this validator — keep them in agreement):
//   pattern  : the member-matching regex, SOURCE form (a string — it is
//              compiled here; assertMemberRegistry wants a RegExp object)
//   members  : [{ file, timeoutMs?, serial?, image? }] — `file` is a BARE
//              filename in tests/ (no path separators), matching `pattern`.
//              The option allowlist is deliberately closed: an unknown key
//              is an ERROR, not ignored — a typo'd `timeoutMS` that
//              silently does nothing is the zombie-fallback shape. Notably
//              NOT allowed: the RAM-class tags (light/boot/gb) — those are
//              assertions about local measurements (#579), and an untagged
//              sibling member deliberately lands in the safe over-charged
//              default class.
//   exclude  : [{ file, owner }] — deliberate exclusions only, each naming
//              the live ticket that owns registering the file.
const fs = require('fs');
const path = require('path');

// The one intended resident today; parameterized so the browser tier (or a
// second sibling) can reuse the same mechanism without touching this file.
const REPO_NAME = 'gucos-packages';

const TOP_KEYS = new Set(['pattern', 'members', 'exclude']);
const MEMBER_KEYS = new Set(['file', 'timeoutMs', 'serial', 'image']);
const EXCLUDE_KEYS = new Set(['file', 'owner']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// -> { status: 'absent', name }
//  | { status: 'invalid', name, root|null, errors: [string] }
//  | { status: 'ok', name, root, via, testsDir, pattern (RegExp),
//      members (bare, for assertMemberRegistry), exclude, prefix,
//      entries (prefixed + src, for runSuite) }
function loadSiblingTests({ ccRoot, name = REPO_NAME, env } = {}) {
  if (!ccRoot) throw new Error('loadSiblingTests: ccRoot is required');
  if (env === undefined) env = process.env.GUCOS_PACKAGES;
  const COMMON = require(path.join(__dirname, '..', '..', 'os', 'os-common.js'));
  const resolved = COMMON.resolveSiblingRepo(fs, path, ccRoot, name, { env });
  if (!resolved) return { status: 'absent', name };
  const { root, via } = resolved;
  const errs = [];
  // Only the env override can name a nonexistent path (discovery candidates
  // are existence-checked in the resolver) — and an explicit override that is
  // wrong must fail LOUD at the caller, never quietly demote to 'absent'
  // (the cmdalt no-silent-fallback rule; same behavior as serve.js/comguc).
  let rootSt = null;
  try { rootSt = fs.statSync(root); } catch (e) {}
  if (!rootSt || !rootSt.isDirectory()) {
    return { status: 'invalid', name, root, errors: [
      `GUCOS_PACKAGES=${env} does not exist — point it at the ${name} checkout, or unset it to use discovery`,
    ] };
  }
  const testsDir = path.join(root, 'tests');
  const manifestPath = path.join(testsDir, 'manifest.json');
  let dirSt = null;
  try { dirSt = fs.statSync(testsDir); } catch (e) {}
  if (!dirSt || !dirSt.isDirectory()) {
    return { status: 'invalid', name, root, errors: [
      `${testsDir} is missing — a present ${name} checkout must carry tests/ + tests/manifest.json (its README's contract); an empty members list is fine, a missing dir is not`,
    ] };
  }
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf-8'); }
  catch (e) {
    return { status: 'invalid', name, root, errors: [
      `${manifestPath} is missing/unreadable (${e.code || e.message}) — the member manifest is the sibling's half of the #314 registry guard; without it "no tests" and "tests silently dropped" are indistinguishable`,
    ] };
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (e) { errs.push(`manifest.json does not parse: ${e.message}`); }
  if (manifest !== undefined && !isPlainObject(manifest)) {
    errs.push('manifest.json must be a JSON object { pattern, members, exclude }');
    manifest = undefined;
  }
  let pattern = null;
  const members = [];
  const exclude = [];
  if (manifest) {
    for (const k of Object.keys(manifest)) {
      if (!TOP_KEYS.has(k)) errs.push(`unknown top-level key "${k}" (allowed: ${[...TOP_KEYS].join(', ')})`);
    }
    if (typeof manifest.pattern !== 'string' || !manifest.pattern) {
      errs.push('"pattern" must be a non-empty string (regex source form)');
    } else {
      try { pattern = new RegExp(manifest.pattern); }
      catch (e) { errs.push(`"pattern" does not compile as a RegExp: ${e.message}`); }
    }
    if (!Array.isArray(manifest.members)) {
      errs.push('"members" must be an array');
    } else {
      manifest.members.forEach((m, i) => {
        if (!isPlainObject(m)) { errs.push(`members[${i}] must be an object { file, ... }`); return; }
        for (const k of Object.keys(m)) {
          if (!MEMBER_KEYS.has(k)) errs.push(`members[${i}] ("${m.file}"): unknown key "${k}" (allowed: ${[...MEMBER_KEYS].join(', ')}) — unknown keys are errors, not ignored`);
        }
        if (typeof m.file !== 'string' || !m.file) { errs.push(`members[${i}]: "file" must be a non-empty string`); return; }
        if (/[\/\\]/.test(m.file)) { errs.push(`members[${i}] ("${m.file}"): "file" must be a bare filename in tests/ — no path separators`); return; }
        if (pattern && !pattern.test(m.file)) errs.push(`members[${i}] ("${m.file}"): does not match the manifest's own pattern ${manifest.pattern}`);
        if (m.timeoutMs !== undefined && (!Number.isInteger(m.timeoutMs) || m.timeoutMs <= 0)) {
          errs.push(`members[${i}] ("${m.file}"): "timeoutMs" must be a positive integer`);
        }
        if (m.serial !== undefined && typeof m.serial !== 'boolean') errs.push(`members[${i}] ("${m.file}"): "serial" must be a boolean`);
        if (m.image !== undefined && typeof m.image !== 'boolean') errs.push(`members[${i}] ("${m.file}"): "image" must be a boolean`);
        members.push(m);
      });
    }
    if (manifest.exclude !== undefined) {
      if (!Array.isArray(manifest.exclude)) {
        errs.push('"exclude" must be an array');
      } else {
        manifest.exclude.forEach((e, i) => {
          if (!isPlainObject(e)) { errs.push(`exclude[${i}] must be an object { file, owner }`); return; }
          for (const k of Object.keys(e)) {
            if (!EXCLUDE_KEYS.has(k)) errs.push(`exclude[${i}]: unknown key "${k}" (allowed: file, owner)`);
          }
          if (typeof e.file !== 'string' || !e.file) errs.push(`exclude[${i}]: "file" must be a non-empty string`);
          if (typeof e.owner !== 'string' || !e.owner) errs.push(`exclude[${i}] ("${e.file}"): "owner" must name the live ticket that owns registering it`);
          exclude.push(e);
        });
      }
    }
  }
  if (errs.length) return { status: 'invalid', name, root, errors: errs };
  const entries = members.map((m) => {
    const e = { file: `${name}/${m.file}`, src: path.join(testsDir, m.file) };
    if (m.timeoutMs !== undefined) e.timeoutMs = m.timeoutMs;
    if (m.serial) e.serial = true;
    if (m.image) e.image = true;
    return e;
  });
  return {
    status: 'ok', name, root, via, testsDir, pattern, exclude, prefix: name,
    members: members.map((m) => ({ file: m.file })),
    entries,
  };
}

module.exports = { loadSiblingTests, REPO_NAME };
