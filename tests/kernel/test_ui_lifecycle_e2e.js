#!/usr/bin/env node
// #789 compiled Win32/SDL adapters over real OS worker/RPC transports.
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const {driveBoot,freshImage}=require('./lib/drive.js');
const source=fs.readFileSync(path.join(__dirname,'ui_lifecycle_probe.c'),'utf8');
const {image}=freshImage('ui-lifecycle-');
const out=driveBoot(["cat > /root/lifecycle.c <<'EOF'",...source.trimEnd().split('\n'),'EOF',
 'cc /root/lifecycle.c -o /root/lifecycle && /root/lifecycle','exit'],{image,maxBuffer:32*1024*1024}).stdout;
console.log(out);
assert(out.includes('LIFECYCLE-DONE failures=0'),'compiled lifecycle probe must complete all assertions');
assert(!/^FAIL /m.test(out),'no failed lifecycle assertions');
