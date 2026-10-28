'use strict';
// Owned static publication only; no compiler/bake/package hooks.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const configPath=process.argv[2], bytes=fs.readFileSync(configPath), c=JSON.parse(bytes);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const identity={pid:process.pid,root:c.root,configSha256:sha(bytes)};
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf'};
const server=http.createServer((req,res)=>{
 try {
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(pathname==='/__serve-id'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(identity));return;}
  let entry=c.publication[pathname];
  const rel=pathname.slice(1);
  if(!entry && Object.prototype.hasOwnProperty.call(c.sources,rel)) entry={path:path.join(c.root,rel),sha256:c.sources[rel]};
  if(!entry){res.writeHead(404);res.end('not in pinned publication');return;}
  const data=fs.readFileSync(entry.path);if(sha(data)!==entry.sha256)throw new Error('publication drift '+pathname);
  res.setHeader('Content-Type',mime[path.extname(pathname)]||'application/octet-stream');res.end(data);
  fs.appendFileSync(path.join(c.output,'served-inventory.jsonl'),JSON.stringify({url:pathname,sha256:entry.sha256,bytes:data.length})+'\n');
 }catch(e){console.error(e.stack);res.writeHead(500);res.end('pinned publication error');process.exitCode=1;}
});
server.listen(0,'127.0.0.1',()=>process.send({...identity,port:server.address().port}));
process.on('SIGTERM',()=>server.close(()=>process.exit(process.exitCode||0)));
