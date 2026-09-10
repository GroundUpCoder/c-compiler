'use strict';
const assert=require('assert');
const evidence=require('../objc/exceptions-evidence.js')('os-node');
try {
  const {driveBoot}=require('./lib/drive.js'),fixture=require('../objc/exceptions-os.js');
  const script=["cat > /root/objc-exceptions.sh <<'OBJC_EXCEPTION_SCRIPT_END'",fixture.source,'OBJC_EXCEPTION_SCRIPT_END','sh /root/objc-exceptions.sh','echo OBJC-EH-RESULT=$?','exit'].join('\n');
  const result=driveBoot(script,{prefix:'os-objc-exceptions-',timeout:900000});
  evidence.record({name:'actual-bin-cc',status:result.status===0?'pass':'fail',exit:result.status,stdout:String(result.stdout),stderr:String(result.stderr)});
  assert.equal(result.status,0,String(result.stderr));
  assert.match(String(result.stdout),/OBJC-EH-RESULT=0/,String(result.stdout));
  assert.match(String(result.stdout),new RegExp('OBJC-EH-COUNT='+fixture.count),String(result.stdout));
  evidence.finish(null);console.log('PASS Objective-C exceptions /bin/cc:',fixture.count,'programs');
} catch(error){evidence.finish(error);throw error;}
