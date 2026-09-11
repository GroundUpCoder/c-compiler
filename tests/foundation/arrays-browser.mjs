import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const browserRequire=createRequire(new URL('../browser/package.json',import.meta.url));
const evidence=require('./arrays-evidence.js')('browser');
let release,server,browser;
try {
 require('../browser/lib/playwright-pin.cjs').checkPlaywrightPin();
 const {chromium}=browserRequire('playwright'),files=require('./files.js');
 release=require('../lib/heavy-lock.js').joinHeavyLock({name:'Foundation arrays browser corpus'});
 const root=new URL('../../',import.meta.url);
 const routes=new Map([['/compiler.js','compiler.js'],['/host.js','host.js'],['/corpus.js','tests/foundation/corpus.js'],['/arrays.js','tests/foundation/arrays-corpus.js']]);
 server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<script src="/compiler.js"></script><script src="/host.js"></script><script src="/corpus.js"></script><script src="/arrays.js"></script>');}
  else if(req.url==='/files.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(files));}
  else if(routes.has(req.url)){res.setHeader('content-type','text/javascript');res.end(fs.readFileSync(new URL(routes.get(req.url),root)));}
  else {res.statusCode=404;res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.exposeFunction('recordArrays779',r=>evidence.record(r));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const result=await page.evaluate(async()=>{
  const files=await(await fetch('/files.json')).json();
  const records=await FoundationArraysCorpus.run(CompilerJS,runModule,files,FoundationCorpus,()=>{
   const fs=BLOCK_FS.create(new BLOCK_FS.MemoryByteStore(8*1024*1024));return {blockFsFactory:ctx=>({c:fs.toWasmEnv(ctx)})};
  },r=>window.recordArrays779(r));
  return {count:records.length,userAgent:navigator.userAgent};
 });
 if(errors.length)throw Error(errors.join('\n'));
 evidence.finish(null,result);console.log('PASS Foundation arrays Chromium:',result.count);
}catch(e){evidence.finish(e);throw e;}
finally{await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));release?.();}
