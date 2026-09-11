'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {driveBoot}=require('./lib/drive');const fixture=require('../foundation/arrays-os');
const evidence=require('../foundation/arrays-evidence')('os-node');
fs.writeFileSync(path.join(evidence.directory,'fixture.sh'),fixture.source);
try{
 const script=["cat > /root/arrays779.sh <<'ARRAY779_SCRIPT_END'",fixture.source,'ARRAY779_SCRIPT_END','sh /root/arrays779.sh','echo ARRAY779-OS-RESULT=$?','exit'].join('\n');
 const r=driveBoot(script,{prefix:'os-arrays779-',timeout:900000});
 evidence.record({name:'actual-bin-cc',status:r.status===0?'executed':'fail',exit:r.status,stdout:String(r.stdout),stderr:String(r.stderr)});
 assert.equal(r.status,0,String(r.stderr));assert.match(String(r.stdout),/ARRAY779-OS-RESULT=0/);
 assert.match(String(r.stdout),new RegExp('ARRAY779-OS-COUNT='+fixture.count));
 const names=[...String(r.stdout).matchAll(/^ARRAY779-OS-PASS (.+)$/gm)].map(m=>m[1].trim());assert.deepEqual(names,fixture.names);
 evidence.finish(null,{names});console.log('PASS Foundation arrays /bin/cc:',names.length,'programs');
}catch(e){evidence.finish(e);throw e;}
