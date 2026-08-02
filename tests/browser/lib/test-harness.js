// Unit coverage for the PURE parts of os-harness.mjs (todos/0146) — the bits
// that don't need Playwright or a browser: osUrl, near, makeCheck, and
// waitForServer against an injected fetch. Runs in plain Node (the harness
// imports playwright lazily, so this import succeeds without the operator's
// separate install). The pixel/VT helpers and openOsSession are exercised by
// the real browser sweep (operator-owed, 0064).
//
//   node tests/browser/lib/test-harness.js
import { osUrl, near, makeCheck, waitForServer, wmctlTimeoutHits } from './os-harness.mjs';

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name); failures++; }
};

// osUrl (hostKeys defaults to 'off' — META-ARROW-KEYBIND.md decision 4 pins
// the keyboard-scheme host auto-detect off for the sweep; '' omits the param)
check('osUrl builds the os.html URL (pinned hostkeys)',
  osUrl(3193) === 'http://localhost:3193/os/os.html?hostkeys=off');
check('osUrl with hostKeys "" omits the query', osUrl(3193, '') === 'http://localhost:3193/os/os.html');

// near: channel-wise tolerance
check('near: exact match', near([10, 20, 30], [10, 20, 30]) === true);
check('near: within default tol 8', near([10, 20, 30], [15, 25, 22]) === true);
check('near: outside default tol 8', near([10, 20, 30], [19, 20, 30]) === false);
check('near: custom tol', near([10, 20, 30], [22, 20, 30], 12) === true);
check('near: null got is falsy', !near(null, [0, 0, 0]));

// makeCheck: scoreboard + stringify tail
{
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    const { check: c, state } = makeCheck();
    c('pass one', true);
    c('fail one', false, { a: 1 });
    c('fail two', false);
    console.log = orig;
    check('makeCheck counts only failures', state.failures === 2);
    check('makeCheck ok line', logs[0] === '  ok   pass one');
    check('makeCheck stringifies extra', logs[1] === '  FAIL fail one  {"a":1}');
    check('makeCheck omits absent extra', logs[2] === '  FAIL fail two');
  } finally { console.log = orig; }
}

// makeCheck stringify:false prints raw
{
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    const { check: c } = makeCheck({ stringify: false });
    c('raw', false, 'plain-extra');
    console.log = orig;
    check('makeCheck raw extra (stringify:false)', logs[0] === '  FAIL raw  plain-extra');
  } finally { console.log = orig; }
}

// wmctlTimeoutHits (#97/0287): the drive.js-class loud-symptom scanner
check('wmctlTimeoutHits: clean output has no hits',
  wmctlTimeoutHits('~ # wmctl wait win About 8000\nok\n').length === 0);
check('wmctlTimeoutHits: catches a timeout line',
  wmctlTimeoutHits('x\nwmctl: wait win timed out after 8000ms\ny')
    .join() === 'wmctl: wait win timed out after 8000ms');
check('wmctlTimeoutHits: dedups repeats, keeps distinct hits', (() => {
  const h = wmctlTimeoutHits(
    'wmctl: wait win timed out after 8000ms\n' +
    'wmctl: wait win timed out after 8000ms\n' +
    'wmctl: wait label timed out after 5000ms\n');
  return h.length === 2 && h[1] === 'wmctl: wait label timed out after 5000ms';
})());
check('wmctlTimeoutHits: null/undefined-safe', wmctlTimeoutHits(undefined).length === 0);

// waitForServer: injected fetch
(async () => {
  let calls = 0;
  const okAfter3 = async () => { calls++; if (calls < 3) throw new Error('down'); return { ok: true }; };
  const up = await waitForServer('x', { tries: 10, interval: 1, fetchFn: okAfter3 });
  check('waitForServer returns true once the server answers', up === true && calls === 3);

  const neverUp = await waitForServer('x', { tries: 4, interval: 1, soft: true, fetchFn: async () => ({ ok: false }) });
  check('waitForServer returns false after tries exhausted (soft)', neverUp === false);

  // Default (non-soft): exhaustion THROWS a loud, actionable error (0171).
  let threw = false;
  try { await waitForServer('x', { tries: 3, interval: 1, fetchFn: async () => ({ ok: false }) }); }
  catch (e) { threw = /never answered/.test(e.message); }
  check('waitForServer throws on exhaustion by default', threw);

  console.log(failures === 0 ? '\nos-harness unit: PASS' : `\nos-harness unit: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
