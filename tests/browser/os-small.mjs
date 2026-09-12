import {createRequire} from 'node:module';
import {openOsSession, ROOT} from './lib/os-harness.mjs';
const require = createRequire(import.meta.url);
if (!require('../../tools/small-sibling.js').snapshot(ROOT)) {
  console.log('SKIP Small browser e2e: optional sibling absent');
  process.exit(0);
}
const s = await openOsSession({port:3387, readyLabel:'Small image boots', serverTries:600, serverInterval:500});
try {
  await s.setVt(1);
  await s.page.keyboard.type(`cat > /root/browser-small.wc <<'SMALL_SOURCE'\nimport java.util.ArrayList;\nvoid main() { try { new ArrayList<String>().get(0); } catch (Exception error) { System.out.println("small browser".toUpperCase()); } }\nSMALL_SOURCE\nsmall /root/browser-small.wc -o /root/sapp && /root/sapp | cat > /root/small.out && grep -q 'SMALL BROWSER' /root/small.out && echo SMALL""-BROWSER-OK\n`);
  await s.waitOut('SMALL-BROWSER-OK', 60000);
  s.check('Small compiles inside browser kernel and output reaches a pipe', true);
  await s.context.close();
  // Exercise the existing publication layout: an image under a content alias,
  // with mkimage's metadata left beside the stable compatibility image.
  const published = await s.browser.newContext();
  try {
    let aliasMetadataRequests = 0;
    await published.route('**/os/image.json', async route => {
      const response = await route.fetch();
      const manifest = await response.json();
      manifest.image = 'small-content-alias.img';
      await route.fulfill({response, json:manifest});
    });
    await published.route('**/os/small-content-alias.img.small.json', async route => {
      aliasMetadataRequests++;
      await route.fulfill({status:404, body:'Not found'});
    });
    await published.route('**/os/small-content-alias.img', async route => {
      // Let Chromium fetch the image directly: fulfilling a large binary through
      // Playwright base64-encodes it onto the DevTools pipe (100 MiB limit).
      await route.continue({url:new URL('os-system.img', route.request().url()).href});
    });
    const page = await published.newPage();
    await page.goto(s.url);
    await page.waitForFunction(() => window.__osState === 'ready', null, {timeout:180000});
    s.check('content-named image boots using stable metadata fallback', aliasMetadataRequests > 0);
  } finally { await published.close(); }
  const incomplete = await s.browser.newContext();
  try {
    await incomplete.route('**/*.small.json', route => route.fulfill({status:404, body:'Not found'}));
    const page = await incomplete.newPage();
    await page.goto(s.url);
    await page.waitForFunction(() => window.__osState === 'error', null, {timeout:30000});
    const message = await page.evaluate(() => window.__osBootErr || '');
    s.check('missing required metadata refuses boot with a publication diagnostic', /Small image metadata unavailable/.test(message), message);
  } finally { await incomplete.close(); }
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('Small gucOS browser integration');
