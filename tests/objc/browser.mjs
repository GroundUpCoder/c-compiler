// #772: real Chromium compiles .m source itself, then runs the resulting Wasm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
require('../browser/lib/playwright-pin.cjs').checkPlaywrightPin();
const { chromium } = require('playwright');
const release = require('../lib/heavy-lock.js').joinHeavyLock({ name: 'Objective-C browser experiment' });
const root = new URL('../../', import.meta.url);
const routes = new Map([
  ['/compiler.js', new URL('compiler.js', root)],
  ['/host.js', new URL('host.js', root)],
  ['/cases.js', new URL('tests/objc/cases.js', root)],
  ['/round2.js', new URL('tests/objc/round2.js', root)],
  ['/core.m', new URL('tests/objc/core.m', root)],
]);
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><script src="/compiler.js"></script><script src="/host.js"></script><script src="/cases.js"></script><script src="/round2.js"></script>');
  } else if (routes.has(req.url)) {
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(fs.readFileSync(routes.get(req.url)));
  } else { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const C = window.CompilerJS, records = [];
    function compile(source, name, noInline) {
      name += '.m'; let diagnostics = '';
      const options = { compilerOptions: { noInline }, warningFlags: {}, writeErr: s => { diagnostics += s; } };
      let units;
      try { units = C.parseAllUnits({ readFileSync: () => source }, C.createDefaultPPRegistry(), [name], options); }
      catch (e) { throw Error(diagnostics || e.message); }
      if (diagnostics) throw Error(diagnostics);
      const link = C.linkTranslationUnits(units, options.compilerOptions);
      if (link.errors.length) throw Error(link.errors.map(e => e.message).join('\n'));
      return C.generateCode(units, name + '.wasm', options);
    }
    const positives = [['core', await (await fetch('/core.m')).text()], ...ObjcCases.positive, ...ObjcRound2.positive];
    for (const noInline of [false, true]) for (const [name, source] of positives) {
      const bytes = compile(source, name, noInline);
      if (!WebAssembly.validate(bytes)) throw Error('invalid wasm ' + name);
      const blockfs = BLOCK_FS.create(new BLOCK_FS.MemoryByteStore(8 * 1024 * 1024));
      const exit = await runModule({ bytes, args: [name], blockFsFactory: ctx => ({ c: blockfs.toWasmEnv(ctx) }), writeOut: () => {}, writeErr: s => { throw Error(s); } });
      if (exit !== 0) throw Error(`${name}: exit ${exit}`);
      records.push({ name, noInline, exit, bytes: bytes.length });
    }
    for (const [name, source, expected] of [...ObjcCases.negative, ...ObjcRound2.negative]) {
      let error = '';
      try { compile(source, name, false); } catch(e) { error = e.message; }
      if (!expected.test(error)) throw Error(`${name}: wrong refusal: ${error}`);
      records.push({ name, refused: true });
    }
    return { userAgent: navigator.userAgent, records };
  });
  assert.equal(result.records.length, 14 + 24);
  fs.mkdirSync(new URL('build/objc/', root), { recursive: true });
  fs.writeFileSync(new URL('build/objc/browser.json', root), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  release();
}
