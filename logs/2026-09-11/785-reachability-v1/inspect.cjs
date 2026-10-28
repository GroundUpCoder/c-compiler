'use strict';
// Read-only image inspection only: no Wasm compilation/instantiation or guest execution.
const fs=require('fs'),crypto=require('crypto'),assert=require('assert');
const root='/Users/jku/git/c-compiler-land783';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const pin=JSON.parse(fs.readFileSync('/Users/jku/git/c-compiler-prep785/logs/2026-09-11/785-cmdalt-observation-source-v1/run.json'));
assert.strictEqual(digest(fs.readFileSync(process.execPath)),pin.absolutePins[process.execPath]);
assert.strictEqual(digest(fs.readFileSync(root+'/host.js')),pin.sourceVerification['host.js']);
const B=require(root+'/host.js').BLOCK_FS;
const base=root+'/build/trap783/durable-run-gate-le3ges2n/payload/';
const files=[base+'observation-system.img',base+'observation-root.img'];
let writes=0;const before=files.map(f=>digest(fs.readFileSync(f)));
function load(file){const b=fs.readFileSync(file);const store={size:()=>b.length,getUint32:o=>b.readUInt32LE(o),getBytes:(o,n)=>Uint8Array.from(b.subarray(o,o+n)),setUint32(){writes++;throw Error('write forbidden');},setBytes(){writes++;throw Error('write forbidden');},resize(){writes++;throw Error('resize forbidden');},flush(){}};return B.createV4(store,{readonly:true});}
const sys=load(files[0]),user=load(files[1]);const view=new B.MountFS({'/':user,'/usr':sys});
function read(p,max=4*1024*1024){const st=view.stat(p);if(!st)return null;assert(st.size<=max);const fd=view.open(p,0,0);assert(fd!==null);try{const b=new Uint8Array(st.size);const n=view.read(fd,b,b.length);assert(n===b.length);return Buffer.from(b);}finally{view.close(fd);}}
function inspect(p){const l=view.lstat(p),st=view.stat(p),result={path:p,lstat:l&&{mode:l.mode,size:l.size},stat:st&&{mode:st.mode,size:st.size},error:st?null:view._lastError};if(l&&(l.mode&0xf000)===0xa000){const b=new Uint8Array(4096);const n=view.readlink(p,b,b.length);result.link=Buffer.from(b.subarray(0,n)).toString();}if(st&&(st.mode&0xf000)===0x8000){const b=read(p);result.sha256=digest(b);result.magic=b.subarray(0,16).toString('hex');if(b.length<16384)result.text=b.toString();}return result;}
const paths=['/bin','/usr/local','/usr/local/bin','/usr/local/bin/chmod','/bin/chmod','/usr/bin/chmod','/bin/busybox','/bin/coreutils','/bin/sh','/usr/local/bin/python','/etc/profile','/root/.profile','/etc/gucman/defaults','/usr/share/gucman/defaults','/etc/gucman/repos','/usr/share/gucman/repos','/bin/gucman','/usr/bin/cmdalt'];
const dirs={};for(const p of ['/bin','/usr/local/bin']){const h=view.opendir(p);assert(h!==null);dirs[p]=[];try{for(let e;(e=view.readdir(h))!==null;)dirs[p].push(e.name);}finally{view.closedir(h);}}
const records=paths.map(inspect);const after=files.map(f=>digest(fs.readFileSync(f)));assert.deepStrictEqual(after,before);assert.strictEqual(writes,0);
process.stdout.write(JSON.stringify({kind:'offline readonly library inspection; not guest runtime',node:process.execPath,nodeSha256:digest(fs.readFileSync(process.execPath)),hostSha256:pin.sourceVerification['host.js'],images:files.map((f,i)=>({path:f,before:before[i],after:after[i]})),writeAttempts:writes,directories:dirs,records},null,2)+'\n');
