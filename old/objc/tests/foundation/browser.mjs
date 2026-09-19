import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../browser/package.json',import.meta.url));
const evidence=require('../foundation/evidence.js')('browser');
let release,server,browser;
try {
  require('../browser/lib/playwright-pin.cjs').checkPlaywrightPin();
  const {chromium}=require('playwright');
  const files=require('../foundation/files.js');
  release=require('../lib/heavy-lock.js').joinHeavyLock({name:'Foundation browser corpus'});
  const root=new URL('../../',import.meta.url);
  const routes=new Map([
    ['/compiler.js',new URL('compiler.js',root)],['/host.js',new URL('host.js',root)],
    ['/corpus.js',new URL('tests/foundation/corpus.js',root)]
  ]);
  server=http.createServer((req,res)=>{
    if(req.url==='/') {res.setHeader('content-type','text/html');res.end('<script src="/compiler.js"></script><script src="/host.js"></script><script src="/corpus.js"></script>');}
    else if(req.url==='/files.json') {res.setHeader('content-type','application/json');res.end(JSON.stringify(files));}
    else if(routes.has(req.url)) {res.setHeader('content-type','text/javascript');res.end(fs.readFileSync(routes.get(req.url)));}
    else {res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.exposeFunction('recordFoundation',record=>evidence.record(record));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await page.evaluate(async()=>{
    const files=await(await fetch('/files.json')).json();
    const records=await FoundationCorpus.run(CompilerJS,runModule,files,()=>{
      const fs=BLOCK_FS.create(new BLOCK_FS.MemoryByteStore(8*1024*1024));
      return {blockFsFactory:ctx=>({c:fs.toWasmEnv(ctx)})};
    },record=>window.recordFoundation(record));
    return {userAgent:navigator.userAgent,records};
  });
  evidence.finish(null,{userAgent:result.userAgent});
  console.log('PASS Foundation Chromium corpus',result.records.length,'records');
} catch(error) {evidence.finish(error);throw error;}
finally {await browser?.close();if(server?.listening) await new Promise(resolve=>server.close(resolve));release?.();}
