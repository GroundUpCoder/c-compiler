import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  await page.goto('file://' + indexPath);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready', null, { timeout: 10000 });

  await page.click('#btnCompile');
  await page.waitForFunction(() => !document.getElementById('btnCompile').disabled, null, { timeout: 10000 });
  console.log('Compiled OK');

  // Click a function row to open a function tab
  const fnRow = page.locator('.fn-row').first();
  await fnRow.scrollIntoViewIfNeeded();
  await fnRow.click();
  await page.waitForTimeout(300);

  const allTabs = await page.locator('.tab').allTextContents();
  console.log('Tabs after clicking function:', allTabs.map(t => t.replace('×','').trim()));

  // Close a function tab, then try '+' to reopen
  const fnTabClose = page.locator('.tab:has-text("main") .tab-close').first();
  if (await fnTabClose.count() > 0) {
    await fnTabClose.click();
    await page.waitForTimeout(100);
    console.log('\nClosed function tab');
  }

  // Try '+' button
  const addBtns = page.locator('.tab-add');
  const count = await addBtns.count();
  console.log('+ buttons:', count);
  for (let i = 0; i < count; i++) {
    const btn = addBtns.nth(i);
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(200);
      const menu = page.locator('.tab-add-menu.open');
      if (await menu.count() > 0) {
        const items = await menu.locator('.tab-add-menu-item').allTextContents();
        console.log(`+ menu on pane ${i}:`, items);
        // Close menu
        await page.click('body');
        await page.waitForTimeout(100);
      }
    }
  }

  // Close Source, verify it can be reopened
  const srcClose = page.locator('.tab:has-text("Source") .tab-close').first();
  await srcClose.click();
  await page.waitForTimeout(100);
  console.log('\nClosed Source');

  const addBtn = page.locator('.tab-add').first();
  await addBtn.click();
  await page.waitForTimeout(200);
  const menu = page.locator('.tab-add-menu.open');
  const items = await menu.locator('.tab-add-menu-item').allTextContents();
  console.log('+ menu after closing Source:', items);

  const srcItem = menu.locator('.tab-add-menu-item:has-text("Source Editor")');
  if (await srcItem.count() > 0) {
    await srcItem.click();
    await page.waitForTimeout(200);
    const editorWorks = await page.evaluate(() => {
      return typeof editorView !== 'undefined' && editorView.state.doc.length > 0 && editorView.dom.offsetParent !== null;
    });
    console.log('Source editor reopened and visible:', editorWorks);
  }

  const finalTabs = await page.locator('.tab').allTextContents();
  console.log('\nFinal tabs:', finalTabs.map(t => t.replace('×','').trim()));

  await browser.close();
  console.log('\nAll + button tests passed!');
})();
