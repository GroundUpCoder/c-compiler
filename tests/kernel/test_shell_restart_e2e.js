#!/usr/bin/env node
'use strict';
// #780: a background child's exit must not truncate hush's substitution pipe.
// The paired C test proves delivery while blocked; this exercises real hush.
const assert=require('assert');
const {driveBoot}=require('./lib/drive.js');
const result=driveBoot([
 'values=""; for i in $(seq 1 120); do values="$values $i"; done; echo "CONTROL:$values"',
 'sleep 0.2 &',
 'values=""; for i in $(sleep 0.6; seq 1 120); do values="$values $i"; done; echo "INTERRUPTED:$values"',
 'wait',
 'values=""; for i in $(seq 1 120); do values="$values $i"; done; echo "AFTER:$values"'
],{timeout:300000});
const output=String(result.stdout),error=String(result.stderr);
assert.equal(result.status,0,output+'\n'+error);
const values=Array.from({length:120},(_,i)=>' '+(i+1)).join('');
for(const name of ['CONTROL','INTERRUPTED','AFTER'])
 assert(output.split('\n').includes(name+':'+values),name+' lost or reordered substitution output\n'+output+'\n'+error);
console.log('hush interrupted substitution: all 120 values preserved in order');
