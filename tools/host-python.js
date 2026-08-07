'use strict';
// tools/host-python.js — the ONE resolver for the HOST-side Python interpreter
// (#483). Everything on the host that spawns a Python — the tests/run.js py
// batch and tools/mkmpgenhdr.js's qstr generator — resolves through here;
// nothing spawns a bare `python3` from $PATH. (In-OS `python` — cmdalt,
// micropython, cpython-clang — is a different axis entirely and never touches
// this file.)
//
// WHY THIS EXISTS. `tests/run.js` used to spawn `python3` by $PATH lookup,
// which on this machine is Xcode's system Python 3.9 — the gate's largest leg
// (19 of 26 suites) rode an ambient property of whoever's shell launched the
// runner, in violation of the machine-wide never-system-Python rule. Two lanes
// on one tree could legitimately disagree about whether the tree was green,
// and an interpreter fault presented as a tree fault.
//
// Resolution order — NEVER falls through to $PATH:
//   1. $PYTHON            an explicit caller override, used verbatim. Missing/
//                         non-executable REFUSES naming it — an explicit
//                         override that doesn't resolve must never be silently
//                         substituted. No version enforcement: the override IS
//                         the deliberately-different-interpreter mechanism
//                         (the CC_NO_PLAYWRIGHT_PIN analog, and the same shape
//                         as mkmpgenhdr's existing $CC override).
//   2. <root>/.venv       this tree's uv venv. A PRESENT .venv dir claims the
//                         slot: broken (no interpreter) or drifted (pyvenv.cfg
//                         version vs the committed .python-version pin)
//                         refuses with the exact fix — never routed around.
//   3. <main>/.venv       worktree read-through: a `git worktree` checkout
//                         resolves the main clone's venv (located via the
//                         gitdir-pointer file, the #559 mainTreeOf parse), so
//                         a fresh worktree needs NO per-tree setup — the class
//                         of outage #559 fixed for node_modules cannot recur
//                         here. (Read-through is safe where it wasn't for
//                         playwright: there Node's own resolver defines what
//                         loads; here this resolver IS the resolution.)
//   4. refuse             { ok:false, message } naming `uv venv` at the right
//                         tree. Pure decision, no exit — exit codes belong to
//                         the callers (the checkBrowserPreflight precedent).
//
// The version pin lives in the committed .python-version (major.minor; uv venv
// reads it natively). The check is loose on patch level on purpose: uv rolls
// patches forward, and the hermeticity axis that actually bit was
// system-3.9-vs-pinned-modern, i.e. major.minor.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The gitdir-pointer parse already exists in the browser tier's pre-flight
// (#559); imported rather than duplicated, so it cannot drift. An edit to it
// is covered here too: playwright-pin.cjs's RULES row selects `host`, and the
// worktree legs of tests/host/test_python_resolve.js ride this import.
const { mainTreeOf } = require('../tests/browser/lib/playwright-pin.cjs');

// The committed pin, or null. No pin file → nothing to enforce (the
// "not an exact pin" playwright rule).
function pinnedPython(root = ROOT) {
  try { return fs.readFileSync(path.join(root, '.python-version'), 'utf8').trim() || null; }
  catch { return null; }
}

// The venv's interpreter version WITHOUT spawning it: pyvenv.cfg carries
// `version_info = 3.12.13` (uv) or `version = 3.12.13` (stdlib venv).
function venvPythonVersion(venvDir) {
  try {
    const m = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf8')
      .match(/^\s*version(?:_info)?\s*=\s*(\S+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function venvInterpreter(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); }
  catch { return false; }
}

// `version` satisfies a major.minor `pin` (3.12 accepts 3.12.13; 3.12.13
// accepts only itself).
function versionMatchesPin(version, pin) {
  return version === pin || version.startsWith(pin + '.');
}

function refusal(lines) {
  return {
    ok: false,
    message: '\x1b[1m\x1b[31m━━━ host-python pre-flight FAILED (#483) — nothing ran ━━━\x1b[0m\n'
      + lines.join('\n') + '\n\n'
      + '  Deliberately using another interpreter? PYTHON=/path/to/python overrides\n'
      + '  (it must exist — an override never falls through).\n',
  };
}

// The decision, PURE (the checkBrowserPreflight/checkTree precedent): returns
// { ok:true, python, source } or { ok:false, message } and never exits.
// Parameterized so the failure paths are testable on throwaway fixture trees
// (tests/host/test_python_resolve.js).
function resolvePython({ root = ROOT, env = process.env } = {}) {
  if (env.PYTHON) {
    if (isExecutable(env.PYTHON)) {
      return { ok: true, python: env.PYTHON, source: 'PYTHON env override' };
    }
    return refusal([
      `  $PYTHON is set to ${env.PYTHON}, which does not exist or is not executable.`,
      '  An explicit override is never silently substituted — fix or unset it.',
    ]);
  }

  const pin = pinnedPython(root);
  const mainTree = mainTreeOf(root);
  const candidates = [
    { dir: path.join(root, '.venv'), tree: root, source: 'venv' },
    ...(mainTree ? [{ dir: path.join(mainTree, '.venv'), tree: mainTree, source: 'main-tree venv' }] : []),
  ];

  for (const c of candidates) {
    if (!fs.existsSync(c.dir)) continue;   // wholly absent → next candidate
    const py = venvInterpreter(c.dir);
    if (!isExecutable(py)) {
      // A present .venv claims the slot: broken is a fault to fix loudly, not
      // to route around (a venv whose uv-managed base interpreter was removed
      // leaves exactly this dangling shape).
      return refusal([
        `  ${c.dir} exists but has no working interpreter at ${py}.`,
        '  Fix:',
        `    cd ${c.tree} && uv venv --clear`,
      ]);
    }
    const ver = venvPythonVersion(c.dir);
    if (pin && ver && !versionMatchesPin(ver, pin)) {
      return refusal([
        `  ${c.dir} is Python ${ver}, but .python-version pins ${pin}.`,
        '  A drifted venv is the system-python bug wearing a venv suit. Fix:',
        `    cd ${c.tree} && uv venv --clear`,
      ]);
    }
    return { ok: true, python: py, source: c.source, version: ver };
  }

  const fixTree = mainTree || root;
  return refusal([
    '  No Python venv is resolvable — and $PATH lookup is exactly the bug this',
    '  resolver exists to end, so there is no fallback.',
    ...(mainTree
      ? [`  This is a worktree of ${mainTree}; it reads the main clone's .venv,`,
         '  which is missing. One command fixes every worktree at once:']
      : ['  Fix:']),
    `    cd ${fixTree} && uv venv`,
    '  (uv reads the committed .python-version pin; the .venv is gitignored.)',
  ]);
}

module.exports = { resolvePython, pinnedPython, venvPythonVersion,
                   venvInterpreter, versionMatchesPin };
