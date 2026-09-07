'use strict';
// #762: positive optimizer telemetry and actual frame chains, both frontends.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const {spawnSync} = require('child_process');
const CC = require('../../compiler.js'), COMMON = require('../../os/os-common.js'), HOST = require('../../host.js');
const source = [
  'static void depth3(void) { __builtin_trap(); }',
  'static void depth2(void) { depth3(); }',
  'static void depth1(void) { depth2(); }',
  'int main(void) { depth1(); return 0; }',
].join('\n') + '\n';
const kfs = HOST.BLOCK_FS.createV4(new HOST.BLOCK_FS.MemoryByteStore(8 << 20));
const b = new TextEncoder().encode(source), fd = kfs.open('/chain.c', 0x241, 0o644);
kfs.write(fd,b,b.length); kfs.close(fd);
const driver = COMMON.createCcDriver(CC,kfs);
async function report(bytes, full) {
  let err = '';
  await assert.rejects(HOST({bytes,args:['chain'],writeErr:b=>{err += new TextDecoder().decode(b);}}));
  assert(/#\d+\s+main\s+at /.test(err),err);
  for (const name of ['depth1','depth2','depth3'])
    assert.strictEqual(new RegExp('#\\d+\\s+'+name+'\\s+at ').test(err),full,err);
  assert(err.includes('chain.c:'+(full?1:4)),err);
}
(async()=>{
  let failures=0;
  async function check(name,fn){try{await fn();console.log('ok '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}}
  for(const flags of [[],['-g'],['-g','-fno-inline'],['-g2','-fno-inline']]) await check('in-OS '+flags.join(' '),async()=>{
    const r=driver(['cc',...flags,'/chain.c','-o','/chain'],'/');
    assert.strictEqual(r.exitCode,0,r.stderr);
    const bytes=COMMON.readFileBytes(kfs,'/chain'),disabled=flags.includes('-fno-inline');
    const stats=CC.WAST.lastPassStats.inline;
    assert(disabled?stats.inlined===0:stats.inlined>=3,JSON.stringify(stats));
    const sections=WebAssembly.Module.customSections(new WebAssembly.Module(bytes),'c.sources');
    assert.strictEqual(sections.length,flags.includes('-g2')?1:0);
    if(sections.length) assert(Buffer.from(sections[0]).includes(Buffer.from(source)));
    if(flags.length)await report(bytes,disabled);
  });
  for(const flag of ['-g3','-fno-inlien','--unknown']) await check('unknown '+flag,()=>{
    const r=driver(['cc',flag,'/chain.c'],'/');assert.notStrictEqual(r.exitCode,0);assert(r.stderr.includes(flag),r.stderr);
  });
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-debug-flags-'));
  try{
    fs.writeFileSync(path.join(dir,'chain.c'),source);
    for(const flags of [['-g'],['-g','-fno-inline'],['-g2','-fno-inline']]) await check('host '+flags.join(' '),async()=>{
      const out=path.join(dir,'chain.wasm');
      const r=spawnSync(process.execPath,[path.resolve(__dirname,'../../compiler.js'),...flags,path.join(dir,'chain.c'),'-o',out],{encoding:'utf8'});
      assert.strictEqual(r.status,0,r.stderr);await report(fs.readFileSync(out),flags.includes('-fno-inline'));
    });
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
  assert.strictEqual(failures,0);
})().catch(e=>{console.error(e);process.exitCode=1;});
