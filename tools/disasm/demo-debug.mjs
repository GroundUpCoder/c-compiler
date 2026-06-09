// Playwright demo: drives tools/disasm/index.html through compile → debug → step,
// capturing screenshots at each interesting moment so the flow is visible.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, 'index.html');
const outDir = process.env.SHOTS_DIR || '/tmp/disasm-demo';
fs.mkdirSync(outDir, { recursive: true });

const shot = (page, name) =>
  page.screenshot({ path: path.join(outDir, name), fullPage: false });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  await page.goto('file://' + indexPath);
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Ready',
    null, { timeout: 15000 }
  );

  // 1. Initial UI — default C source loaded.
  await shot(page, '01-initial.png');
  console.log('01-initial.png — initial UI with default C source');

  // 2. Compile & disassemble.
  await page.click('#btnCompile');
  await page.waitForFunction(
    () => !document.getElementById('btnCompile').disabled,
    null, { timeout: 15000 }
  );
  // Give the disassembly panel a moment to render.
  await page.waitForTimeout(400);
  await shot(page, '02-compiled.png');
  console.log('02-compiled.png — disassembly rendered (collapsed sections)');

  // 3. Open the `main` function tab. Code's <details> is open by default;
  // function rows live in `.fn-list .fn-row`. (There's also a `.meta-row.fn-row`
  // in the Exports section which is collapsed — we explicitly avoid that.)
  const mainRow = page.locator('.fn-list .fn-row:has-text("main")').first();
  if (await mainRow.count() > 0) {
    await mainRow.scrollIntoViewIfNeeded();
    await mainRow.click();
  } else {
    const anyRow = page.locator('.fn-list .fn-row').first();
    await anyRow.scrollIntoViewIfNeeded();
    await anyRow.click();
  }
  await page.waitForTimeout(400);
  await shot(page, '03-function-view.png');
  console.log('03-function-view.png — main function disassembly open');

  // 4. Enter Debug mode.
  await page.click('#btnDebug');
  await page.waitForFunction(
    () => document.getElementById('debugBar').classList.contains('active'),
    null, { timeout: 10000 }
  );
  await page.waitForTimeout(400);
  await shot(page, '04-debug-start.png');
  console.log('04-debug-start.png — debugger paused at first instruction, debug bar visible');

  // Helper: read the step counter from the debug status line.
  const stepCount = () => page.evaluate(() => {
    const m = document.getElementById('debugStatus').textContent.match(/(\d+)\s+steps/);
    return m ? Number(m[1]) : -1;
  });
  console.log('  initial step count:', await stepCount());

  // 5. A few single-steps to show locals/stack updating.
  for (let i = 0; i < 6; i++) {
    await page.click('#dbgStep');
    await page.waitForTimeout(120);
  }
  await shot(page, '05-after-6-steps.png');
  console.log('05-after-6-steps.png — after 6 Step clicks, step count:', await stepCount());

  // 6. Step Over to advance past a call (or current insn) several times.
  for (let i = 0; i < 5; i++) {
    await page.click('#dbgStepOver');
    await page.waitForTimeout(120);
  }
  await shot(page, '06-after-step-over.png');
  console.log('06-after-step-over.png — after 5 Step Over clicks, step count:', await stepCount());

  // 7. Run to completion (or until 10M steps), then capture final state.
  await page.click('#dbgRun');
  await page.waitForTimeout(800);
  await shot(page, '07-run-to-done.png');
  console.log('07-run-to-done.png — program run to completion, step count:', await stepCount());

  // 8. Activate the Debug tab to show the running state pane
  // (call stack, locals, value stack, output) at the trap location.
  const dbgTab = page.locator('.tab:has-text("Debug")').first();
  await dbgTab.click();
  await page.waitForTimeout(300);
  await shot(page, '08-debug-state-pane.png');
  console.log('08-debug-state-pane.png — Debug tab pane: call stack + locals + stack at trap');

  // Dump the debug status line and a snippet of state for the transcript.
  const summary = await page.evaluate(() => ({
    status: document.getElementById('debugStatus').textContent,
    callStack: [...document.querySelectorAll('.debug-callstack-frame')].map(e => e.textContent.trim()).slice(0, 4),
    locals: [...document.querySelectorAll('.debug-var')].slice(0, 8).map(e => e.textContent.replace(/\s+/g, ' ').trim()),
    stdout: (document.querySelector('.debug-stdout') || {}).textContent || '',
  }));
  console.log('Final debugger summary:', JSON.stringify(summary, null, 2));

  await browser.close();
  console.log('\nDone. Screenshots in', outDir);
})();
