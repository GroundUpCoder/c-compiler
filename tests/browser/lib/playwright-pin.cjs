'use strict';
// tests/browser/lib/playwright-pin.cjs — the browser tier's install pre-flight
// (#559). CJS on purpose (tests/browser/package.json is "type":"module"), so
// BOTH consumers reach the ONE implementation with no async seam:
//   - tests/browser/lib/os-harness.mjs re-exports checkPlaywrightPin() and
//     calls it in launchBrowser() — defense in depth for a hand-run os-*.mjs;
//   - tests/run.js (gate start, whenever the sweep is in the selected set) and
//     tests/browser/os-sweep.mjs (before the heavy lock and the bake) call
//     checkBrowserPreflight(), so a knowable install fault refuses in under a
//     second instead of 33 minutes in.
//
// WHY THIS EXISTS. This tier's deps used to be a caret range with a gitignored
// lockfile, so a fresh worktree re-resolved to a NEWER playwright whose
// Chromium build was not in the local cache — every sweep file then failed at
// launch, which reads as "the OS is broken" rather than "your install
// drifted". Observed 2026-07-26: 1.62.0 in a worktree vs the 1.61.0 every
// other tree had, 39/39 spurious FAILs. Recurred 2026-08-07 (lane-554, #559):
// tests/browser/node_modules is gitignored, so a fresh `git worktree` lacks it
// and Node resolution falls through to a drifted ancestor install — the
// launch-time pin check then failed all 56 members, 33 minutes into the gate.
// The guard was right both times; #559 moved it to second zero and made it
// name the exact fix. Set CC_NO_PLAYWRIGHT_PIN=1 to bypass the version check
// when deliberately testing another playwright (a resolvable install is still
// required — "no playwright at all" can never be a deliberate sweep run).
const fs = require('fs');
const path = require('path');

const BROWSER_DIR = path.resolve(__dirname, '..');

// The playwright this tier is PINNED to, read from tests/browser/package.json
// (the one source of truth — no second copy of the number to drift).
function pinnedPlaywright(browserDir = BROWSER_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(browserDir, 'package.json'), 'utf8'));
    return (pkg.devDependencies || {}).playwright || null;
  } catch { return null; }
}

// Resolve the playwright Node would actually load for a module in
// <browserDir>/lib. Walking up is what node's resolver does, so this reports
// the same copy `import('playwright')` gets — including the case where
// tests/browser has no node_modules and the import falls up to a repo-root or
// ambient install.
function resolvedPlaywright(browserDir = BROWSER_DIR) {
  for (let dir = path.join(browserDir, 'lib'); ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', 'playwright', 'package.json');
    try { return { version: JSON.parse(fs.readFileSync(p, 'utf8')).version, path: p }; }
    catch {}
    if (path.dirname(dir) === dir) return null;
  }
}

// The launch-time assert (todos/0171 loud-symptom rule) — throws on a drifted
// resolution, silent otherwise. Kept alongside the pre-flight because a
// hand-run single os-*.mjs goes through neither runner.
function checkPlaywrightPin(browserDir = BROWSER_DIR) {
  if (typeof process !== 'undefined' && process.env && process.env.CC_NO_PLAYWRIGHT_PIN) return;
  const want = pinnedPlaywright(browserDir);
  if (!want || /[\^~*x><|| ]/.test(want)) return;   // not an exact pin — nothing to enforce
  const got = resolvedPlaywright(browserDir);
  if (!got) return;                                  // no playwright at all: the import after this says so
  if (got.version === want) return;
  throw new Error(
    `playwright ${got.version} resolved, but tests/browser/package.json pins ${want} ` +
    `(${got.path}). A drifted playwright wants a Chromium build that is probably not in the ` +
    `local cache and will fail EVERY sweep file at launch — that is an install problem, not a ` +
    `product problem. Fix: cd tests/browser && pnpm install --frozen-lockfile. ` +
    `(Override with CC_NO_PLAYWRIGHT_PIN=1.)`);
}

// The main clone's path when `root` is a `git worktree` checkout, read from
// the gitdir-pointer FILE `git worktree add` leaves ("gitdir: <main>/.git/
// worktrees/<name>"). A clone has a .git DIRECTORY → null. Used only to name
// the exact fix command in the refusal — never to read through.
function mainTreeOf(root) {
  const gitPath = path.join(root, '.git');
  try {
    if (fs.lstatSync(gitPath).isDirectory()) return null;
    const m = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const marker = path.sep + '.git' + path.sep + 'worktrees' + path.sep;
    const i = m[1].lastIndexOf(marker);
    return i >= 0 ? m[1].slice(0, i) : null;
  } catch { return null; }
}

// The gate-start decision, PURE (tree-guard's checkTree precedent): returns
// { ok: true } or { ok: false, message, … } and never exits — exit codes
// belong to the callers. Parameterized so the failure paths are testable on
// throwaway fixture trees (tests/host/test_browser_preflight.js).
//
// The check is OUTCOME-based: what matters is that the playwright Node will
// resolve IS the pinned one, not which directory supplied it — the pinned
// version's Chromium is in the per-user cache however it resolves. A missing
// tests/browser/node_modules is diagnosed in the refusal (it is WHY the
// resolution drifted, and its symlink is the fix), but a tree whose ambient
// resolution matches the pin passes.
function checkBrowserPreflight({ browserDir = BROWSER_DIR, env = process.env } = {}) {
  const got = resolvedPlaywright(browserDir);
  const want = pinnedPlaywright(browserDir);
  const exactPin = want != null && !/[\^~*x><|| ]/.test(want);
  if (got && env.CC_NO_PLAYWRIGHT_PIN) {
    return { ok: true, note: 'CC_NO_PLAYWRIGHT_PIN set — version not enforced' };
  }
  if (got && (!exactPin || got.version === want)) return { ok: true };

  // Refusing. Name the cause, then the exact fix.
  const root = path.resolve(browserDir, '..', '..');
  const nmPath = path.join(browserDir, 'node_modules');
  const nmMissing = !fs.existsSync(nmPath);          // follows symlinks — dangling counts as missing
  const rel = path.relative(root, browserDir) || browserDir;
  const mainTree = mainTreeOf(root);
  const mainNm = mainTree ? path.join(mainTree, rel, 'node_modules') : null;

  const lines = ['\x1b[1m\x1b[31m━━━ browser tier pre-flight FAILED (#559) — nothing ran ━━━\x1b[0m'];
  if (!got) {
    lines.push(`  no playwright is resolvable from ${rel}/ — every sweep member would fail at import.`);
  } else {
    lines.push(`  playwright ${got.version} resolved, but ${rel}/package.json pins ${want}`,
               `    (resolved at: ${got.path})`,
               '  A drifted playwright wants a Chromium build that is probably not in the local',
               '  cache and would fail EVERY sweep file at launch — an install problem, not a',
               '  product problem.');
  }
  if (nmMissing) {
    lines.push('',
               `  ${rel}/node_modules is MISSING. It is gitignored, so a fresh \`git worktree\``,
               '  does not have it; Node resolution then falls through to whatever ancestor',
               '  install it finds (or none). Fix (pick one):');
    if (mainNm && fs.existsSync(mainNm)) {
      lines.push(`    ln -s ${mainNm} ${nmPath}`,
                 `    cd ${path.join(root, rel)} && pnpm install --frozen-lockfile`);
    } else {
      lines.push(`    cd ${path.join(root, rel)} && pnpm install --frozen-lockfile`);
    }
  } else {
    lines.push('', `  Fix: cd ${path.join(root, rel)} && pnpm install --frozen-lockfile`);
  }
  lines.push('',
             '  Deliberately testing another playwright? CC_NO_PLAYWRIGHT_PIN=1 skips the',
             '  version check (a resolvable playwright is still required).', '');
  return { ok: false, nmMissing, resolved: got, pinned: want, message: lines.join('\n') + '\n' };
}

module.exports = { pinnedPlaywright, resolvedPlaywright, checkPlaywrightPin,
                   checkBrowserPreflight, mainTreeOf };
