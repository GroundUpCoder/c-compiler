'use strict';
const files=require('./files.js'),corpus=require('./corpus.js');
const lines=['mkdir -p /root/foundation-test','cd /root/foundation-test'];
for(const [name,source] of Object.entries(files)) if(name.startsWith('/tests/')) {
  lines.push("cat > '"+name.slice(7)+"' <<'FOUNDATION_SOURCE_END'",source,'FOUNDATION_SOURCE_END');
}
let count=0;
for(const program of corpus.programs) if(!program.limitMemory && !program.failure) {
  lines.push('cc -g '+program.inputs.join(' ')+' -o case.out && ./case.out || exit 1',"echo 'FOUNDATION-OS-PASS "+program.name+"'");count++;
}
// The installed source namespace and header requirement converge on one TU.
lines.push('cc ownership.m /usr/src/foundation/NSObject.m /usr/src/foundation/NSAutoreleasePool.m -o explicit.out && ./explicit.out || exit 1');count++;
lines.push('cc -g misuse.m -o misuse.out || exit 1');
for(let i=0;i<3;i++) {
  const message=['pools cannot be retained','pools cannot be autoreleased','recursive drain'][i];
  lines.push('./misuse.out '+i+' > misuse.log 2>&1','result=$?', 'test "$result" = 134 || exit 1',"grep '"+message+"' misuse.log || exit 1");count++;
}
lines.push('echo FOUNDATION-OS-COUNT='+count);
module.exports={source:lines.join('\n')+'\n',count};
