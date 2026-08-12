// todos/0416 — the browser leg todos/0413 deferred: a RUST binary runs in a
// real gucOS terminal, in the browser sweep, through the full -rust package
// channel (mkpkg --rust repo → /packages over the kernel's browser-realm
// HTTP → gucman install → the tool on PATH).
//
// The sibling here is SYNTHETIC, derived from the committed fixture
// tests/kernel/fixtures/wc-rust/wc-rust.wasm, so the sweep runs on any clone
// without the gucos-rust repo (the estate never hard-requires a producer
// sibling). That fixture IS the producer's bytes: test_rust_e2e's freshness
// leg pins fixture == a fresh sibling build, and test_rust_pkgs_e2e pins the
// real overlay's sha256 == the fixture's — so the binary this leg runs is
// byte-identical to the real channel's.
//
// Legs: base purity in the booted browser OS (zero *-rust in /usr/bin,
// wc-rust is 127 pre-install — the non-vacuous half), install over the
// origin-relative /packages repo, the tool's output byte-equal to the
// busybox wc applet IN the same terminal, clean remove.
//
// Usage: node os-rust.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openOsSession, ROOT, buildPackageRepo } from './lib/os-harness.mjs';

const PORT = 3280;

// --- the synthetic rust sibling, from the committed fixture ---------------
const FIXTURE = path.join(ROOT, 'tests', 'kernel', 'fixtures', 'wc-rust', 'wc-rust.wasm');
const SIB = path.join(ROOT, 'build', 'test-rust-sibling');
{
  const bytes = fs.readFileSync(FIXTURE);
  const payDir = path.join(SIB, 'out-image', 'wc-rust');
  fs.mkdirSync(payDir, { recursive: true });
  fs.writeFileSync(path.join(payDir, 'wc-rust.wasm'), bytes);
  fs.writeFileSync(path.join(SIB, 'out-image', 'overlay.json'), JSON.stringify({
    schema: 'overlay@1', id: 'rust-apps',
    provenance: { producer: 'gucos-rust (synthetic: the committed wc-rust fixture)',
                  artifactRoot: '.', repo: { commitShort: 'fixture', dirty: false } },
    files: { '/usr/bin/wc-rust': {
      bin: 'wc-rust/wc-rust.wasm', mode: '0755',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length } },
  }, null, 2));
}

// serve.js serves /packages from dist/packages but never runs mkpkg — build
// the wc-rust card there (base entries already present are carried forward;
// the sweep is serial, so the shared dist/packages repo is the accepted
// sequential thrash of todos/0388, exactly as in os-gucman.mjs). A NAMED
// build like this one gets the sibling package names appended by the helper
// (#665): in a cold tree there is no prior index to carry them from, and
// serve.js's #614 guard refuses an index that lacks them.
buildPackageRepo({ args: ['wc-rust', '--rust', `--rust-root=${SIB}`] });

// A stale image makes serve.js re-bake BEFORE listening — give it room.
const s = await openOsSession({ port: PORT, serverTries: 600, serverInterval: 500 });
const { page, check, waitOut, setVt } = s;

try {
  await setVt(1);

  // Base purity, in the running browser OS: nothing -rust is baked, and the
  // command is 127 before the install (proves the run below is the install's
  // doing, not a baked twin's).
  await page.keyboard.type('echo PURE-$(ls /usr/bin | grep -c -- -rust)-""END\r');
  await waitOut('PURE-0-END', 30000);
  check('base image ships zero *-rust binaries (browser boot)', true);
  await page.keyboard.type('wc-rust /dev/null 2>/dev/null; echo PRE-RC""=$?\r');
  await waitOut('PRE-RC=', 20000);
  const pre = await page.evaluate(() => window.__osOut);
  check('wc-rust is 127 BEFORE the install', /PRE-RC=127/.test(pre),
    (/PRE-RC=(\d+)/.exec(pre) || [])[1]);

  // Install through the origin-relative /packages repo over the kernel's
  // browser-realm HTTP (the os-gucman.mjs path, now carrying a Rust payload).
  await page.keyboard.type('gucman install wc-rust; echo GUC-RC""=$?\r');
  await waitOut('GUC-RC=', 120000);
  const inst = await page.evaluate(() => window.__osOut);
  const rc = /GUC-RC=(\d+)/.exec(inst);
  check('gucman install wc-rust exits 0', rc && rc[1] === '0', rc && rc[1]);

  // THE leg: the Rust binary runs in this real gucOS terminal, and its
  // output is byte-equal to the busybox wc applet on the same input.
  await page.keyboard.type('a=$(echo one two three | wc); b=$(echo one two three | wc-rust); ' +
    '[ "$a" = "$b" ] && echo WC-""MATCH; echo "rs:$b"\r');
  await waitOut('WC-MATCH', 30000);
  check('wc-rust runs in the terminal, output byte-equal to busybox wc', true);

  // And the full default three-column format on a file, via the planted
  // /usr/local/bin symlink explicitly (bare name could not hit a baked twin
  // — purity above proved there is none — but the plant is the contract).
  await page.keyboard.type('printf "x y\\nz\\n" > /tmp/r.txt && /usr/local/bin/wc-rust /tmp/r.txt; echo FILE-RC""=$?\r');
  await waitOut('FILE-RC=', 20000);
  const fout = await page.evaluate(() => window.__osOut);
  check('the planted /usr/local/bin/wc-rust counts a file (exit 0)', /FILE-RC=0/.test(fout),
    (/FILE-RC=(\d+)/.exec(fout) || [])[1]);

  // Clean removal.
  await page.keyboard.type('gucman remove wc-rust; echo RM-RC""=$?\r');
  await waitOut('RM-RC=', 30000);
  await page.keyboard.type('wc-rust /dev/null 2>/dev/null; echo POST-RC""=$?\r');
  await waitOut('POST-RC=', 20000);
  const post = await page.evaluate(() => window.__osOut);
  check('gucman remove exits 0', /RM-RC=0/.test(post), (/RM-RC=(\d+)/.exec(post) || [])[1]);
  check('wc-rust is 127 again after the remove', /POST-RC=127/.test(post),
    (/POST-RC=(\d+)/.exec(post) || [])[1]);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os rust package (browser)');
