'use strict';
// Import-seam controls complement the real compiled-C kernel regressions.
const assert = require('assert');
const {BLOCK_FS} = require('../../host.js');
let checked=0;
function fixture(operation, results, verdict) {
  const memory=new WebAssembly.Memory({initial:1});
  const calls=[];
  let delivered=0,errno;
  const backend={_fdTable:[],_lastError:'EINTR'};
  backend[operation]=function(...args){calls.push(args);return results[calls.length-1];};
  const ctx={getMemory:()=>memory,readString:()=>'',setErrnoName:e=>{errno=e;},writeOut:()=>{},writeErr:()=>{}};
  if(verdict!==undefined)ctx.deliverSignals=()=>{delivered++;backend._lastError='EBADF';return verdict;};
  const env=BLOCK_FS.BlockFS.prototype.toWasmEnv.call(backend,ctx);
  return {backend,ctx,env,memory,calls,get delivered(){return delivered;},get errno(){return errno;}};
}
for(const [operation,importName,args] of [['read','read',[7,32,4]],['write','write',[7,32,4]],['sockAccept','__sock_accept',[7]]]) {
  for(const verdict of [undefined,null,false]) {
    const f=fixture(operation,[null],verdict);
    assert.equal(f.env[importName](...args),-1);
    assert.equal(f.calls.length,1);
    assert.equal(f.errno,'EINTR'); // handler's EBADF cannot replace syscall error
    assert.equal(f.delivered,verdict===undefined?0:1);checked++;
  }
  for(const result of [0,1,2]) {
    const f=fixture(operation,[result],true);
    assert.equal(f.env[importName](...args),result);
    assert.equal(f.calls.length,1);assert.equal(f.delivered,0);checked++;
  }
  const f=fixture(operation,[null,2],true);
  assert.equal(f.env[importName](...args),2);assert.equal(f.calls.length,2);assert.equal(f.delivered,1);checked++;
  const other=fixture(operation,[null],true);other.backend._lastError='EIO';
  assert.equal(other.env[importName](...args),-1);assert.equal(other.errno,'EIO');assert.equal(other.delivered,0);checked++;
}
for(const operation of ['read','write']) {
  const f=fixture(operation,[null,4],true);
  new Uint8Array(f.memory.buffer).set([1,2,3,4],32);
  const old=f.memory.buffer;
  f.ctx.deliverSignals=()=>{f.memory.grow(1);return true;};
  assert.equal(f.env[operation](7,32,4),4);
  assert.equal(old.byteLength,0);
  assert.equal(f.calls[1][1].buffer,f.memory.buffer);
  assert.deepEqual([...f.calls[1][1]],[1,2,3,4]);checked++;
}
{
 const f=fixture('close',[null],true);
 assert.equal(f.env.close(7),-1);assert.equal(f.delivered,0);assert.equal(f.errno,'EINTR');checked++;
}
{
 const f=fixture('read',[null],true);const thrown={handler:'nonlocal-exit'};
 f.ctx.deliverSignals=()=>{throw thrown;};
 assert.throws(()=>f.env.read(7,32,4),e=>e===thrown);assert.equal(f.calls.length,1);checked++;
}
console.log('syscall restart import seam: '+checked+' controls passed');
