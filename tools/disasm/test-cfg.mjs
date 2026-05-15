// Smoke test for the CFG view. Compiles a tiny C function with both a
// loop and an if/else, opens the CFG tab from the '+' menu, then asserts
// that nodes and edges were rendered.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, 'index.html');

const SRC = `
int factorial(int n) {
    int r = 1;
    while (n > 1) {
        r = r * n;
        n = n - 1;
    }
    return r;
}

int sign(int x) {
    if (x < 0) return -1;
    if (x == 0) return 0;
    return 1;
}

int main(void) {
    return factorial(5) + sign(-3);
}
`;

function assert(cond, msg) {
  if (!cond) { console.error('ASSERT FAILED:', msg); process.exit(1); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', err => { console.log('PAGE ERROR:', err.message); errs.push(err); });

  await page.goto('file://' + indexPath);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready', null, { timeout: 15000 });

  // Replace editor contents with our test source
  await page.evaluate((src) => {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: src } });
  }, SRC);

  await page.click('#btnCompile');
  await page.waitForFunction(() => !document.getElementById('btnCompile').disabled, null, { timeout: 15000 });
  console.log('Compiled OK');

  // lastCfg should now be populated
  const cfgState = await page.evaluate(() => ({
    has: !!lastCfg,
    fnCount: lastCfg ? lastCfg.functions.length : 0,
    fnNames: lastCfg ? lastCfg.functions.map(f => f.name) : [],
  }));
  console.log('CFG state after compile:', cfgState);
  assert(cfgState.has, 'lastCfg should be set');
  assert(cfgState.fnNames.includes('factorial'), 'factorial should be in CFG');
  assert(cfgState.fnNames.includes('sign'), 'sign should be in CFG');

  // Open the '+' menu and click "Control-Flow Graph"
  const addBtn = page.locator('.tab-add').first();
  await addBtn.click();
  await page.waitForTimeout(200);
  const cfgItem = page.locator('.tab-add-menu-item:has-text("Control-Flow Graph")');
  const found = await cfgItem.count();
  assert(found > 0, '"Control-Flow Graph" should appear in + menu');
  await cfgItem.first().click();
  await page.waitForTimeout(300);

  // Verify the CFG tab exists and rendered the graph
  const cfgTab = page.locator('.tab:has-text("CFG")');
  assert(await cfgTab.count() > 0, 'CFG tab should exist');

  // Default selection should pick the first function (factorial). Check
  // that node boxes and edge paths exist.
  const graphState = await page.evaluate(() => {
    const select = document.querySelector('.cfg-fn-select');
    const stage = document.querySelector('.cfg-stage');
    return {
      selectedFn: select ? select.options[select.selectedIndex].text : null,
      nodeCount: stage ? stage.querySelectorAll('.cfg-node').length : 0,
      edgeCount: stage ? stage.querySelectorAll('.cfg-edges path').length : 0,
      backEdges: stage ? stage.querySelectorAll('.cfg-edge-back').length : 0,
    };
  });
  console.log('Initial graph (factorial):', graphState);
  assert(graphState.nodeCount >= 3, 'factorial should have at least 3 BBs (header, body, exit)');
  assert(graphState.edgeCount >= 3, 'factorial should have edges');
  assert(graphState.backEdges >= 1, 'factorial loop should have at least one back-edge');

  // Switch to sign() and verify it has branches
  const signIdx = await page.evaluate(() => {
    return Array.from(document.querySelector('.cfg-fn-select').options).findIndex(o => o.text.startsWith('sign'));
  });
  assert(signIdx >= 0, 'sign function should be in the dropdown');
  await page.selectOption('.cfg-fn-select', { index: signIdx });
  await page.waitForTimeout(200);
  const signState = await page.evaluate(() => {
    const stage = document.querySelector('.cfg-stage');
    return {
      nodeCount: stage.querySelectorAll('.cfg-node').length,
      trueEdges: stage.querySelectorAll('.cfg-edge-true').length,
      falseEdges: stage.querySelectorAll('.cfg-edge-false').length,
    };
  });
  console.log('After switching to sign:', signState);
  assert(signState.nodeCount >= 4, 'sign should have ≥4 BBs');
  assert(signState.trueEdges >= 2, 'sign should have ≥2 true edges (two ifs)');
  assert(signState.falseEdges >= 2, 'sign should have ≥2 false edges');

  assert(errs.length === 0, 'No page errors should have occurred');
  await browser.close();
  console.log('\nAll CFG tests passed!');
})();
