// 0385: in-browser (Chromium) end-to-end command latency on the DEPLOY-shaped
// (minimal) image + runtime gucman install — the iPhone scenario.
// Usage: node logs/2026-07-28/0385-measure-browser.mjs
import { openOsSession } from '../../tests/browser/lib/os-harness.mjs';

const PORT = 3313;

const s = await openOsSession({
  port: PORT, serveArgs: ['--minimal'],
  serverTries: 1800, serverInterval: 500,
});
const { page, setVt } = s;

let tagN = 0;
// Type the command (tag split so its echo can't satisfy the wait), THEN start
// the clock on Enter; stop when the rc marker appears in the tty mirror.
// polling:'raf' for ~frame precision.
async function timedSh(cmd, ms = 120000) {
  const tag = 'T' + (tagN++) + 'X';
  await page.keyboard.type(`${cmd}; echo ${tag.slice(0, -1)}""X-RC=$?`);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), `${tag}-RC=`,
    { timeout: ms, polling: 'raf' });
  const dt = Date.now() - t0;
  const out = await page.evaluate(() => window.__osOut);
  const m = new RegExp(`${tag}-RC=(\\d+)`).exec(out);
  return { dt, rc: m ? parseInt(m[1], 10) : null };
}

async function bench(name, cmd, reps = 5) {
  const xs = [];
  for (let i = 0; i < reps; i++) {
    const { dt, rc } = await timedSh(cmd);
    xs.push(dt);
    if (rc !== 0) console.log(`  !! ${name} rep ${i} rc=${rc}`);
  }
  const s2 = xs.slice().sort((a, b) => a - b);
  console.log(`  ${name.padEnd(30)} p50=${s2[Math.floor(s2.length / 2)]}ms all=[${xs.join(',')}]`);
  return xs;
}

try {
  await setVt(1);
  console.log('== browser (Chromium, minimal image + gucman install) ==');

  const inst = await timedSh('gucman install python-clang', 300000);
  console.log(`  gucman install: ${inst.dt}ms rc=${inst.rc}`);
  if (inst.rc !== 0) throw new Error('install failed');

  await bench('true_applet', 'true');
  await bench('sh_c_colon', 'sh -c :');
  await bench('pyv_wasm_direct', '/opt/python-clang/bin/python-clang.wasm --version >/dev/null 2>&1');
  await bench('pyv_launcher', 'python-clang --version >/dev/null 2>&1');
  await bench('pyv_dispatcher', 'python --version >/dev/null 2>&1');
  await bench('pass_direct', '/opt/python-clang/bin/python-clang.wasm -c pass >/dev/null 2>&1', 3);
  await bench('pass_dispatcher', 'python -c pass >/dev/null 2>&1', 3);

  await s.close();
  console.log('done');
  process.exit(0);
} catch (e) {
  console.error('ERROR: ' + (e && e.message));
  try { await s.close(); } catch {}
  process.exit(1);
}
