// Drives www/webgpu-worker-probe.html in a browser and prints the #out text.
// Usage: node webgpu-worker-probe.mjs [safari|chrome]   (default safari)
import { Builder, By } from 'selenium-webdriver';
import 'selenium-webdriver/safari.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || 'safari';
const PORT = 3189;
const URL = `http://localhost:${PORT}/webgpu-worker-probe.html`;

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const watchdog = setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 60000);
watchdog.unref();

let driver;
if (which === 'chrome') {
  const { Options } = await import('selenium-webdriver/chrome.js');
  driver = await new Builder().forBrowser('chrome').build();
} else {
  driver = await new Builder().forBrowser('safari').build();
}

try {
  await driver.get(URL);
  let text = '';
  for (let i = 0; i < 30; i++) {
    await driver.sleep(400);
    text = await driver.findElement(By.id('out')).getText();
    if (text.includes('READBACK') || text.includes('ERROR') || text.includes('WORKER_ERR')) break;
  }
  console.log('=== #out (' + which + ') ===\n' + text);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await Promise.race([driver.quit().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  server.kill('SIGTERM');
  process.exit(process.exitCode || 0);
}
